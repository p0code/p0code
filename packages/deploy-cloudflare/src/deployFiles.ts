/*
 * MIT License
 * Copyright (c) 2026 p0code
 * Ported from https://github.com/p0code/deploy-cloudflare (v0.3.0)
 */
import { PluginError } from "@t3tools/plugin-api";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  type ParsedWranglerConfig,
  type WorkerBinding,
  parseWranglerJsonc,
  parseWranglerToml,
} from "./wranglerConfig.ts";

const IGNORED_ENTRIES = new Set([".git", "node_modules", ".DS_Store"]);

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encodeBase64(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b1 = has1 ? bytes[i + 1]! : 0;
    const b2 = has2 ? bytes[i + 2]! : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    result += BASE64_ALPHABET[(triple >> 18) & 0x3f]!;
    result += BASE64_ALPHABET[(triple >> 12) & 0x3f]!;
    result += has1 ? BASE64_ALPHABET[(triple >> 6) & 0x3f]! : "=";
    result += has2 ? BASE64_ALPHABET[triple & 0x3f]! : "=";
  }
  return result;
}

function guessContentType(relativePath: string): string {
  const dot = relativePath.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = relativePath.slice(dot).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export interface CollectedPageAsset {
  /** Leading-slash POSIX path expected in Cloudflare Pages manifests, e.g. `/index.html`. */
  readonly routePath: string;
  readonly hash: string;
  readonly base64: string;
  readonly contentType: string;
}

/**
 * Recursively collects regular files inside a local build directory for Cloudflare Pages
 * Direct Upload. Skips `.git` and `node_modules` and ignores symbolic links.
 */
export const collectPagesAssets = Effect.fn("deployFiles.collectPagesAssets")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;

  const rootDir = path.resolve(directory);
  const rootStat = yield* fs
    .stat(rootDir)
    .pipe(
      Effect.mapError(
        () => new PluginError({ message: `Build directory does not exist: ${directory}` }),
      ),
    );
  if (rootStat.type !== "Directory") {
    return yield* new PluginError({ message: `Build path is not a directory: ${directory}` });
  }

  const assets: Array<CollectedPageAsset> = [];
  const queue: Array<string> = [rootDir];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = yield* fs
      .readDirectory(current)
      .pipe(
        Effect.mapError(
          () => new PluginError({ message: `Could not read build directory: ${current}` }),
        ),
      );
    for (const entry of [...entries].sort()) {
      if (IGNORED_ENTRIES.has(entry)) continue;
      const fullPath = path.join(current, entry);
      const info = yield* fs
        .lstat(fullPath)
        .pipe(
          Effect.mapError(
            () =>
              new PluginError({ message: `Could not inspect file in build directory: ${entry}` }),
          ),
        );
      if (info.type === "SymbolicLink") continue;
      if (info.type === "Directory") {
        queue.push(fullPath);
        continue;
      }
      if (info.type !== "File") continue;
      const bytes = yield* fs
        .readFile(fullPath)
        .pipe(
          Effect.mapError(
            () => new PluginError({ message: `Could not read asset file: ${entry}` }),
          ),
        );
      const rel = path.relative(rootDir, fullPath).split(path.sep).join("/");
      const routePath = `/${rel}`;
      const base64 = encodeBase64(bytes);
      const ext = path.extname(rel).replace(/^\./, "");
      const hashInput = new TextEncoder().encode(`${base64}${ext}`);
      const fullHash = yield* digest.digestHex(Digest.sha256, hashInput);
      assets.push({
        routePath,
        hash: fullHash.slice(0, 32),
        base64,
        contentType: guessContentType(rel),
      });
    }
  }

  if (assets.length === 0) {
    return yield* new PluginError({
      message: `Build directory "${directory}" contains no uploadable files.`,
    });
  }

  return assets;
});

const WRANGLER_FILENAMES = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"] as const;
const DEFAULT_WORKER_ENTRIES = [
  "_worker.js",
  "index.js",
  "worker.js",
  "index.mjs",
  "dist/index.js",
] as const;

export interface LoadedWorkerBundle {
  readonly mainModule: string;
  readonly scriptContent: Uint8Array;
  readonly compatibilityDate?: string;
  readonly compatibilityFlags: ReadonlyArray<string>;
  readonly bindings: ReadonlyArray<WorkerBinding>;
  readonly routes: ReadonlyArray<string>;
}

const isInsideDir = (path: Path.Path, baseDir: string, candidate: string): boolean => {
  const rel = path.relative(baseDir, candidate);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

const readOptionalWranglerConfig = Effect.fn("deployFiles.readOptionalWranglerConfig")(function* (
  baseDir: string,
  envName?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  for (const filename of WRANGLER_FILENAMES) {
    const candidate = path.join(baseDir, filename);
    const exists = yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (!exists) continue;
    const raw = yield* fs
      .readFileString(candidate)
      .pipe(
        Effect.mapError(
          () => new PluginError({ message: `Could not read ${filename} in ${baseDir}.` }),
        ),
      );
    if (filename.endsWith(".toml")) {
      return parseWranglerToml(raw, envName);
    }
    return yield* parseWranglerJsonc(raw, envName).pipe(
      Effect.mapError(
        () => new PluginError({ message: `Could not parse ${filename} as JSON/JSONC.` }),
      ),
    );
  }
  return undefined;
});

/**
 * Loads a built Worker bundle and optional wrangler config from a local directory,
 * merging any explicit deploy `envVars` as `plain_text` bindings.
 */
export const loadWorkerBundle = Effect.fn("deployFiles.loadWorkerBundle")(function* (options: {
  readonly directory: string;
  readonly envName?: string;
  readonly envVars?: Readonly<Record<string, string>>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const rootDir = path.resolve(options.directory);
  const rootStat = yield* fs.stat(rootDir).pipe(
    Effect.mapError(
      () =>
        new PluginError({
          message: `Worker build directory does not exist: ${options.directory}`,
        }),
    ),
  );
  if (rootStat.type !== "Directory") {
    return yield* new PluginError({
      message: `Worker build path is not a directory: ${options.directory}`,
    });
  }

  let config: ParsedWranglerConfig | undefined = yield* readOptionalWranglerConfig(
    rootDir,
    options.envName,
  );
  let configBaseDir = rootDir;
  if (config === undefined) {
    const parentDir = path.dirname(rootDir);
    if (parentDir !== rootDir) {
      config = yield* readOptionalWranglerConfig(parentDir, options.envName);
      if (config !== undefined) configBaseDir = parentDir;
    }
  }

  let entryPath: string | undefined;
  if (config?.main) {
    const fromConfig = path.resolve(configBaseDir, config.main);
    const fromRoot = path.resolve(rootDir, config.main);
    if (
      isInsideDir(path, rootDir, fromRoot) &&
      (yield* fs.exists(fromRoot).pipe(Effect.orElseSucceed(() => false)))
    ) {
      entryPath = fromRoot;
    } else if (
      isInsideDir(path, configBaseDir, fromConfig) &&
      (yield* fs.exists(fromConfig).pipe(Effect.orElseSucceed(() => false)))
    ) {
      entryPath = fromConfig;
    } else if (
      !isInsideDir(path, rootDir, fromRoot) &&
      !isInsideDir(path, configBaseDir, fromConfig)
    ) {
      return yield* new PluginError({
        message: `Refusing to read Worker entrypoint outside project directory: ${config.main}`,
      });
    } else {
      return yield* new PluginError({
        message: `Worker entrypoint "${config.main}" from wrangler config was not found.`,
      });
    }
  } else {
    for (const candidate of DEFAULT_WORKER_ENTRIES) {
      const full = path.join(rootDir, candidate);
      if (yield* fs.exists(full).pipe(Effect.orElseSucceed(() => false))) {
        entryPath = full;
        break;
      }
    }
  }

  if (entryPath === undefined) {
    return yield* new PluginError({
      message: `No Worker script entrypoint found in "${options.directory}". Set "main" in wrangler.toml/wrangler.jsonc or build an index.js / worker.js module.`,
    });
  }

  const scriptContent = yield* fs
    .readFile(entryPath)
    .pipe(
      Effect.mapError(
        () => new PluginError({ message: `Could not read Worker entrypoint: ${entryPath}` }),
      ),
    );

  const bindingsByName = new Map<string, WorkerBinding>();
  for (const binding of config?.bindings ?? []) {
    bindingsByName.set(binding.name, binding);
  }
  for (const [key, value] of Object.entries(options.envVars ?? {})) {
    bindingsByName.set(key, { name: key, type: "plain_text", text: value });
  }

  const mainModule = path.basename(entryPath);
  return {
    mainModule,
    scriptContent,
    ...(config?.compatibilityDate ? { compatibilityDate: config.compatibilityDate } : {}),
    compatibilityFlags: config?.compatibilityFlags ?? [],
    bindings: [...bindingsByName.values()],
    routes: config?.routes ?? [],
  } satisfies LoadedWorkerBundle;
});
