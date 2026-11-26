import { compareSemverVersions } from "@t3tools/shared/semver";
import { desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";
import * as Schema from "effect/Schema";

const Asset = Schema.Struct({
  name: Schema.String,
  browser_download_url: Schema.String,
  size: Schema.Number,
});
const Releases = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.Boolean,
    prerelease: Schema.Boolean,
    html_url: Schema.String,
    body: Schema.NullOr(Schema.String),
    assets: Schema.Array(Asset),
  }),
);

const decodeReleases = Schema.decodeUnknownSync(Releases);

export function selectGitHubRelease(raw: unknown, channel: string, arch: string) {
  const releases = decodeReleases(raw);
  return (
    releases
      .flatMap((release) => {
        const version = release.tag_name.replace(/^v/, "");
        if (
          release.draft ||
          !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) ||
          desktopUpdateChannelOf(version) !== channel ||
          (channel === "latest" && release.prerelease)
        )
          return [];
        const dmg = release.assets.find(
          (asset) =>
            asset.name.endsWith(".dmg") &&
            (asset.name.includes(arch) || asset.name.includes("universal")),
        );
        const sums = release.assets.find((asset) => asset.name === "SHA256SUMS");
        if (!dmg || !sums) return [];
        return [
          {
            version,
            releaseNotes: release.body ?? "",
            releaseUrl: release.html_url,
            downloadSize: dmg.size,
            asset: dmg,
            sums,
          },
        ];
      })
      .sort((a, b) => compareSemverVersions(b.version, a.version))[0] ?? null
  );
}

export function checksumForAsset(sums: string, name: string): string {
  const hashes = sums.split(/\r?\n/).flatMap((line) => {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);
    return match?.[2] === name ? [match[1]!.toLowerCase()] : [];
  });
  if (hashes.length !== 1)
    throw new Error("The release has no unique SHA256 checksum for this download.");
  return hashes[0]!;
}

export function verifyChecksum(actual: string, expected: string): void {
  if (actual !== expected)
    throw new Error(
      "SHA256 checksum mismatch. The current app has been kept; download the update again.",
    );
}

export function shouldCheckInBackground(lastCheck: number | null, now: number): boolean {
  return (
    lastCheck === null ||
    !Number.isFinite(lastCheck) ||
    now - lastCheck >= 24 * 60 * 60 * 1000 ||
    now < lastCheck
  );
}
