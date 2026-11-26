import { describe, expect, it } from "vite-plus/test";
import {
  checksumForAsset,
  selectGitHubRelease,
  shouldCheckInBackground,
  verifyChecksum,
} from "./githubRelease.ts";
import { macUpdateHelper } from "./macUpdateHelper.ts";

const release = (tag: string, prerelease = false) => ({
  tag_name: tag,
  prerelease,
  draft: false,
  html_url: "https://github.com/p0code/p0code/releases/tag/" + tag,
  body: "Release notes",
  assets: [
    { name: "p0code-arm64.dmg", browser_download_url: "https://example.com/app.dmg", size: 123 },
    { name: "SHA256SUMS", browser_download_url: "https://example.com/SHA256SUMS", size: 80 },
  ],
});

describe("GitHub release updates", () => {
  it("selects the newest semver release on the configured channel and architecture", () => {
    const feed = [
      release("v0.2.9"),
      release("v0.2.10"),
      release("v0.3.0-nightly.20261126.1", true),
      { ...release("v9.0.0"), draft: true },
    ];
    expect(selectGitHubRelease(feed, "latest", "arm64")?.version).toBe("0.2.10");
    expect(selectGitHubRelease(feed, "nightly", "arm64")?.version).toBe("0.3.0-nightly.20261126.1");
    expect(selectGitHubRelease(feed, "latest", "x64")).toBeNull();
    expect(selectGitHubRelease([], "latest", "arm64")).toBeNull();
    expect(() => selectGitHubRelease({}, "latest", "arm64")).toThrow();
  });
  it("requires a unique checksum and refuses a mismatch", () => {
    const hash = "a".repeat(64);
    expect(checksumForAsset(`${hash}  p0code-arm64.dmg\n`, "p0code-arm64.dmg")).toBe(hash);
    expect(checksumForAsset(`${hash.toUpperCase()} *p0code-arm64.dmg`, "p0code-arm64.dmg")).toBe(
      hash,
    );
    expect(() => checksumForAsset("", "p0code-arm64.dmg")).toThrow();
    expect(() => checksumForAsset(`${hash}  app\n${hash}  app`, "app")).toThrow();
    expect(() => verifyChecksum("b".repeat(64), hash)).toThrow("checksum mismatch");
    expect(() => verifyChecksum(hash, hash)).not.toThrow();
  });
  it("allows one background check a day and recovers from clock changes", () => {
    expect(shouldCheckInBackground(null, 0)).toBe(true);
    expect(shouldCheckInBackground(0, 86_399_999)).toBe(false);
    expect(shouldCheckInBackground(0, 86_400_000)).toBe(true);
    expect(shouldCheckInBackground(100, 50)).toBe(true);
  });
  it("generates a quoted helper with verification before replacement and rollback", () => {
    const script = macUpdateHelper({
      app: "/Applications/Howard's p0code.app",
      dmg: "/tmp/update.dmg",
      directory: "/tmp/update",
      pid: 123,
      checksum: "a".repeat(64),
    });
    expect(script).toContain('hdiutil attach "$dmg" -readonly -nobrowse');
    expect(script).toContain('--extract-certificates="$work/cert"');
    expect(script).toContain("kill -0 123");
    expect(script).toContain('mv "$backup" "$app"');
    expect(script.indexOf('codesign --verify --deep --strict "$replacement"')).toBeLessThan(
      script.indexOf('mv "$app" "$backup"'),
    );
    expect(script).toContain("xattr -dr com.apple.quarantine");
    expect(script).toContain("Howard'\\''s");
  });
});
