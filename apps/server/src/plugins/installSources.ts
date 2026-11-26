// @effect-diagnostics nodeBuiltinImport:off -- Reads prebuilt archives without extracting paths onto disk.
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import { PluginOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient } from "effect/http";
import * as Yauzl from "yauzl";

const LIMIT = 32 * 1024 * 1024;
export interface Bundle {
  readonly manifest: string;
  readonly code: Uint8Array;
}
export type Download = (url: string) => Promise<Uint8Array>;
export const download: Download = (url) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const response = yield* HttpClient.get(url);
      if (response.status < 200 || response.status >= 300)
        return yield* new PluginOperationError({
          pluginId: "",
          message: "Download failed. Check the URL and release visibility, then retry.",
        });
      const collected = yield* Stream.runFoldEffect(
        response.stream,
        () => ({ size: 0, chunks: [] as Uint8Array[] }),
        (acc, chunk) => {
          if (acc.size + chunk.length > LIMIT)
            return Effect.fail(
              new PluginOperationError({
                pluginId: "",
                message: "Plugin exceeds 32 MiB. Choose a smaller prebuilt bundle.",
              }),
            );
          acc.chunks.push(chunk);
          return Effect.succeed({ size: acc.size + chunk.length, chunks: acc.chunks });
        },
      );
      return Buffer.concat(collected.chunks);
    }).pipe(Effect.timeout("60 seconds"), Effect.provide(FetchHttpClient.layer), Effect.scoped),
  ).catch(() => {
    throw new Error(
      "Network failure. Check the server's internet connection and release URL, then retry.",
    );
  });
const bundleFromFiles = (files: Map<string, Buffer>): Bundle => {
  const manifest = files.get("manifest.json");
  const code = files.get("plugin.mjs");
  if (!manifest || !code)
    throw new Error("No manifest.json + plugin.mjs pair. Choose a prebuilt plugin bundle.");
  return { manifest: manifest.toString("utf8"), code };
};
export async function readArchive(bytes: Uint8Array, name: string): Promise<Bundle> {
  if (bytes.length > LIMIT)
    throw new Error("Plugin exceeds 32 MiB. Choose a smaller prebuilt bundle.");
  const files = new Map<string, Buffer>();
  const add = (path: string, data: Buffer) => {
    if (!/^(dist\/)?(manifest\.json|plugin\.mjs)$/.test(path)) return;
    const key = path.split("/").at(-1)!;
    if (files.has(key)) throw new Error("Duplicate bundle member. Rebuild the plugin archive.");
    files.set(key, data);
  };
  if (/\.(tgz|tar\.gz)$/i.test(name)) {
    const tar = NodeZlib.gunzipSync(bytes, { maxOutputLength: LIMIT });
    for (let offset = 0; offset + 512 <= tar.length;) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every((value) => value === 0)) break;
      const path = header.subarray(0, 100).toString().split("\0")[0]!;
      const prefix = header.subarray(345, 500).toString().split("\0")[0]!;
      const size = Number.parseInt(
        header.subarray(124, 136).toString().replace(/\0/g, "").trim(),
        8,
      );
      if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length)
        throw new Error("Invalid plugin archive. Download it again.");
      if (header[156] === 0 || header[156] === 48)
        add(prefix ? `${prefix}/${path}` : path, tar.subarray(offset + 512, offset + 512 + size));
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    return bundleFromFiles(files);
  }
  await new Promise<void>((resolve, reject) => {
    Yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(new Error("Invalid plugin archive. Download it again."));
        return;
      }
      const fail = (cause: unknown) => {
        zip.close();
        reject(cause);
      };
      zip.on("error", fail);
      zip.on("entry", (entry: Yauzl.Entry) => {
        if (!/^(dist\/)?(manifest\.json|plugin\.mjs)$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        if (entry.uncompressedSize > LIMIT) {
          fail(new Error("Plugin exceeds 32 MiB. Choose a smaller bundle."));
          return;
        }
        zip.openReadStream(entry, (cause, stream) => {
          if (cause || !stream) {
            fail(cause);
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on("error", fail);
          stream.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > LIMIT) {
              stream.destroy();
              fail(new Error("Plugin exceeds 32 MiB."));
            } else chunks.push(chunk);
          });
          stream.on("end", () => {
            try {
              add(entry.fileName, Buffer.concat(chunks));
              zip.readEntry();
            } catch (cause) {
              fail(cause);
            }
          });
        });
      });
      zip.on("end", resolve);
      zip.readEntry();
    });
  });
  return bundleFromFiles(files);
}

interface Asset {
  name: string;
  browser_download_url: string;
  digest?: string | null;
}
interface Release {
  assets: Asset[];
}
const json = async (url: string, get: Download): Promise<unknown> =>
  JSON.parse(new TextDecoder().decode(await get(url)));
const releaseFrom = (value: unknown): Release => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("assets" in value) ||
    !Array.isArray(value.assets)
  )
    throw new Error("No release assets. Publish a prebuilt plugin release first.");
  const assets = value.assets.filter(
    (asset: unknown): asset is Asset =>
      typeof asset === "object" &&
      asset !== null &&
      "name" in asset &&
      typeof asset.name === "string" &&
      "browser_download_url" in asset &&
      typeof asset.browser_download_url === "string",
  );
  return { assets };
};
export async function readGithub(source: string, get: Download = download): Promise<Bundle> {
  const shorthand = /^([\w.-]+)\/([\w.-]+)(?:@([^\s]+))?$/.exec(source);
  let url: URL;
  try {
    url = new URL(
      shorthand
        ? `https://github.com/${shorthand[1]}/${shorthand[2]}${shorthand[3] ? `#${shorthand[3]}` : ""}`
        : source,
    );
  } catch {
    throw new Error("Bad plugin URL. Use a GitHub repository, release asset, or owner/repo@tag.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.search
  )
    throw new Error(
      "Bad plugin URL. Use an HTTPS GitHub URL without credentials or query parameters.",
    );
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || !parts.slice(0, 2).every((part) => /^[\w.-]+$/.test(part)))
    throw new Error("Bad plugin URL. Use owner/repo@tag or a GitHub release asset.");
  const repo = `${parts[0]}/${parts[1]!.replace(/\.git$/, "")}`;
  const direct = parts[2] === "releases" && parts[3] === "download" && parts.length === 6;
  const tag = direct
    ? decodeURIComponent(parts[4]!)
    : url.hash.slice(1) || (parts[3] === "tag" ? decodeURIComponent(parts[4] ?? "") : "");
  if (
    !direct &&
    parts.length !== 2 &&
    !(parts[2] === "releases" && parts[3] === "tag" && parts.length === 5)
  )
    throw new Error("Bad plugin URL. Choose a repository or a release download URL.");
  const release = releaseFrom(
    await json(
      `https://api.github.com/repos/${repo}/releases/${tag ? `tags/${encodeURIComponent(tag)}` : "latest"}`,
      get,
    ),
  );
  const asset = direct
    ? release.assets.find((item) => item.browser_download_url === url.href.split("#")[0])
    : (release.assets.find((item) => /\.(zip|tgz|tar\.gz)$/.test(item.name)) ??
      release.assets.find((item) => item.name === "plugin.mjs"));
  if (!asset)
    throw new Error(
      "No prebuilt plugin asset. Choose a release with a .zip, .tgz, or plugin.mjs + manifest.json pair.",
    );
  const verified = async (asset: Asset) => {
    const bytes = await get(asset.browser_download_url);
    let expected =
      typeof asset.digest === "string"
        ? /^sha256:([a-f0-9]{64})$/i.exec(asset.digest)?.[1]
        : undefined;
    if (!expected) {
      const checksums = release.assets.find(
        (item) =>
          item.name === `${asset.name}.sha256` ||
          /^(sha256sums|checksums)(\.txt)?$/i.test(item.name),
      );
      if (checksums) {
        const lines = new TextDecoder()
          .decode(await get(checksums.browser_download_url))
          .split(/\r?\n/);
        expected = lines
          .map((line) => /^([a-f0-9]{64})(?:\s+\*?(.+))?$/i.exec(line.trim()))
          .find(
            (match) =>
              match &&
              (match[2] === asset.name || (!match[2] && checksums.name === `${asset.name}.sha256`)),
          )?.[1];
        if (!expected)
          throw new Error(
            "Release checksum is missing for this asset. Ask the author to repair the checksum file.",
          );
      }
    }
    if (
      expected &&
      NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== expected.toLowerCase()
    )
      throw new Error(
        "Checksum mismatch. Download again or contact the plugin author; this version was not installed.",
      );
    return bytes;
  };
  const bytes = await verified(asset);
  if (asset.name === "plugin.mjs") {
    const manifest = release.assets.find((item) => item.name === "manifest.json");
    if (!manifest)
      throw new Error(
        "No manifest.json. Choose a release containing both manifest.json and plugin.mjs.",
      );
    return {
      code: bytes,
      manifest: new TextDecoder().decode(await verified(manifest)),
    };
  }
  return readArchive(bytes, asset.name);
}
