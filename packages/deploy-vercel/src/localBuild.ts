/*
 * MIT License
 * Copyright (c) 2026 p0code contributors
 * Ported from https://github.com/p0code/deploy-vercel (v0.2.0)
 */
import { PluginError } from "@t3tools/plugin-api";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { UploadedFileRef } from "./vercelClient.ts";

const MAX_LOCAL_BUILD_FILES = 500;
const MAX_LOCAL_BUILD_BYTES = 50 * 1024 * 1024;
const IGNORED_SEGMENTS = new Set([".git", "node_modules", ".DS_Store"]);

export interface LocalBuildFile {
  readonly file: string;
  readonly sha: string;
  readonly size: number;
  readonly bytes: Uint8Array;
}

export interface LocalBuildBundle {
  readonly files: ReadonlyArray<LocalBuildFile>;
  readonly prebuilt: boolean;
}

function bytesToHex(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let out = "";
  for (const byte of view) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

const sha1Hex = (bytes: Uint8Array) =>
  Effect.tryPromise({
    try: () => {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return globalThis.crypto.subtle.digest("SHA-1", copy.buffer).then(bytesToHex);
    },
    catch: (cause) => new PluginError({ message: "Could not hash local build file.", cause }),
  });

export interface LocalBuildFsDeps {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}

/**
 * Collects files from a local build output directory for Vercel `/v2/files` + `/v13/deployments`.
 * Detects Vercel Build Output API v3 directories (`.vercel/output/config.json` or `config.json`
 * + `static/` / `functions/`) so prebuilt bundles are marked `prebuilt: true`.
 */
export const collectLocalBuildFiles = Effect.fn("vercel.localBuild.collect")(function* (
  directory: string,
  deps: LocalBuildFsDeps,
) {
  const { fs, path } = deps;
  const trimmed = directory.trim();
  if (trimmed.length === 0) {
    return yield* new PluginError({
      message: "Local build deploy requires source.directory.",
    });
  }

  const resolvedRoot = path.resolve(trimmed);
  const rootReal = yield* fs.realPath(resolvedRoot).pipe(
    Effect.mapError(
      (cause) =>
        new PluginError({
          message: `Local build directory does not exist: ${trimmed}`,
          cause,
        }),
    ),
  );
  const rootStat = yield* fs.stat(rootReal).pipe(
    Effect.mapError(
      (cause) =>
        new PluginError({
          message: `Could not inspect local build directory: ${trimmed}`,
          cause,
        }),
    ),
  );
  if (rootStat.type !== "Directory") {
    return yield* new PluginError({
      message: `Local build path is not a directory: ${trimmed}`,
    });
  }

  // If the caller points at a project root that already contains `.vercel/output/config.json`,
  // upload `.vercel/output` as a prebuilt Build Output API bundle.
  const nestedOutput = path.join(rootReal, ".vercel", "output");
  const nestedConfigExists = yield* fs
    .exists(path.join(nestedOutput, "config.json"))
    .pipe(Effect.orElseSucceed(() => false));
  const scanRoot = nestedConfigExists ? nestedOutput : rootReal;
  const rootConfigExists =
    nestedConfigExists ||
    (yield* fs.exists(path.join(scanRoot, "config.json")).pipe(Effect.orElseSucceed(() => false)));
  const hasOutputDirs =
    rootConfigExists &&
    ((yield* fs.exists(path.join(scanRoot, "static")).pipe(Effect.orElseSucceed(() => false))) ||
      (yield* fs.exists(path.join(scanRoot, "functions")).pipe(Effect.orElseSucceed(() => false))));
  const prebuilt = nestedConfigExists || hasOutputDirs;

  const files: Array<LocalBuildFile> = [];
  let totalBytes = 0;

  // Symlinked directories can loop back inside the build; visit each real directory once.
  const visitedDirs = new Set<string>();
  const walk = Effect.fn("VercelLocalBuild.walk")(function* (
    dir: string,
    relPrefix: string,
  ): Effect.fn.Return<void, PluginError> {
    const entries = yield* fs
      .readDirectory(dir)
      .pipe(
        Effect.mapError(
          (cause) => new PluginError({ message: "Could not read local build directory.", cause }),
        ),
      );
    for (const name of [...entries].sort()) {
      if (IGNORED_SEGMENTS.has(name)) continue;
      const fullPath = path.join(dir, name);
      const relPath = relPrefix.length > 0 ? `${relPrefix}/${name}` : name;
      const linkStat = yield* fs
        .stat(fullPath)
        .pipe(
          Effect.mapError(
            (cause) => new PluginError({ message: `Could not inspect ${relPath}.`, cause }),
          ),
        );
      const entryReal = yield* fs
        .realPath(fullPath)
        .pipe(
          Effect.mapError(
            (cause) => new PluginError({ message: `Could not resolve ${relPath}.`, cause }),
          ),
        );
      const relativeFromRoot = path.relative(scanRoot, entryReal);
      if (
        relativeFromRoot === ".." ||
        relativeFromRoot.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeFromRoot)
      ) {
        return yield* new PluginError({
          message: `Refusing to upload path outside build directory: ${relPath}`,
        });
      }
      if (linkStat.type === "Directory") {
        if (visitedDirs.has(entryReal)) continue;
        visitedDirs.add(entryReal);
        yield* walk(fullPath, relPath);
        continue;
      }
      if (linkStat.type !== "File") continue;
      if (files.length >= MAX_LOCAL_BUILD_FILES) {
        return yield* new PluginError({
          message: `Local build exceeds the ${MAX_LOCAL_BUILD_FILES}-file upload limit.`,
        });
      }
      const bytes = yield* fs
        .readFile(fullPath)
        .pipe(
          Effect.mapError(
            (cause) => new PluginError({ message: `Could not read ${relPath}.`, cause }),
          ),
        );
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_LOCAL_BUILD_BYTES) {
        return yield* new PluginError({
          message: "Local build exceeds the 50 MiB upload limit.",
        });
      }
      const sha = yield* sha1Hex(bytes);
      files.push({
        file: relPath,
        sha,
        size: bytes.byteLength,
        bytes,
      });
    }
  });

  yield* walk(scanRoot, "");

  if (files.length === 0) {
    return yield* new PluginError({
      message: "Local build directory contains no files to deploy.",
    });
  }

  return { files, prebuilt } satisfies LocalBuildBundle;
});

export function toUploadedFileRefs(
  files: ReadonlyArray<LocalBuildFile>,
): ReadonlyArray<UploadedFileRef> {
  return files.map(({ file, sha, size }) => ({ file, sha, size }));
}
