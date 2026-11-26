// @effect-diagnostics nodeBuiltinImport:off -- Builds in-memory archives and hashes for download fixtures.
import { describe, expect, it } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import { readGithub, readArchive, type Download } from "./installSources.ts";

const code = new TextEncoder().encode("export default {};");
const manifest = new TextEncoder().encode('{"id":"fixture"}');
const digest = `sha256:${NodeCrypto.createHash("sha256").update(code).digest("hex")}`;
const base = "https://github.com/owner/repo/releases/download/v1/";
function network(checksum = digest, withManifest = true): { get: Download; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    get: async (url) => {
      calls.push(url);
      if (url.startsWith("https://api.github.com/"))
        return new TextEncoder().encode(
          JSON.stringify({
            assets: [
              { name: "plugin.mjs", browser_download_url: `${base}plugin.mjs`, digest: checksum },
              ...(withManifest
                ? [{ name: "manifest.json", browser_download_url: `${base}manifest.json` }]
                : []),
            ],
          }),
        );
      if (url === `${base}plugin.mjs`) return code;
      if (url === `${base}manifest.json`) return manifest;
      throw new Error("Network failure.");
    },
  };
}
describe("plugin downloads", () => {
  it("resolves repository, tagged shorthand and direct release assets on the server", async () => {
    for (const source of [
      "owner/repo@v1",
      "https://github.com/owner/repo#v1",
      `${base}plugin.mjs`,
      "https://github.com/owner/repo",
    ]) {
      const { get, calls } = network();
      const result = await readGithub(source, get);
      expect(result.manifest).toBe(new TextDecoder().decode(manifest));
      expect(result.code).toEqual(code);
      expect(calls[0]).toMatch(/\/releases\/(tags\/v1|latest)$/);
    }
  });
  it("refuses invalid URLs before network, checksum mismatch and missing manifests", async () => {
    const { get, calls } = network();
    await expect(readGithub("http://evil.test/a/b", get)).rejects.toThrow("Bad plugin URL");
    expect(calls).toEqual([]);
    await expect(readGithub("owner/repo", network(`sha256:${"0".repeat(64)}`).get)).rejects.toThrow(
      "Checksum mismatch",
    );
    await expect(readGithub("owner/repo", network(digest, false).get)).rejects.toThrow(
      "No manifest.json",
    );
    await expect(
      readGithub("owner/repo", async () => {
        throw new Error("Network failure");
      }),
    ).rejects.toThrow("Network failure");
  });
  it("verifies release checksum files and the manifest digest in a direct pair", async () => {
    const checksum = NodeCrypto.createHash("sha256").update(code).digest("hex");
    const manifestDigest = NodeCrypto.createHash("sha256").update(manifest).digest("hex");
    const get: Download = async (url) => {
      if (url.startsWith("https://api.github.com/"))
        return new TextEncoder().encode(
          JSON.stringify({
            assets: [
              { name: "plugin.mjs", browser_download_url: `${base}plugin.mjs` },
              {
                name: "manifest.json",
                browser_download_url: `${base}manifest.json`,
                digest: `sha256:${manifestDigest}`,
              },
              { name: "SHA256SUMS", browser_download_url: `${base}SHA256SUMS` },
            ],
          }),
        );
      if (url.endsWith("SHA256SUMS")) return new TextEncoder().encode(`${checksum}  plugin.mjs\n`);
      if (url.endsWith("manifest.json")) return manifest;
      return code;
    };
    expect((await readGithub("owner/repo", get)).code).toEqual(code);
    await expect(
      readGithub("owner/repo", (url) =>
        url.endsWith("manifest.json") ? Promise.resolve(new Uint8Array([0])) : get(url),
      ),
    ).rejects.toThrow("Checksum mismatch");
  });
  it("reads only prebuilt members from tgz and rejects incomplete archives", async () => {
    const member = (name: string, bytes: Uint8Array) => {
      const header = Buffer.alloc(512);
      header.write(name);
      header.write(bytes.length.toString(8).padStart(11, "0"), 124);
      return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
    };
    const archive = NodeZlib.gzipSync(
      Buffer.concat([member("dist/manifest.json", manifest), member("dist/plugin.mjs", code)]),
    );
    expect((await readArchive(archive, "plugin.tgz")).code).toEqual(Buffer.from(code));
    await expect(
      readArchive(NodeZlib.gzipSync(member("plugin.mjs", code)), "plugin.tgz"),
    ).rejects.toThrow("No manifest");
  });
});
