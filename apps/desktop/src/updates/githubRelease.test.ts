// @effect-diagnostics nodeBuiltinImport:off -- Helper execution tests run generated bash scripts in isolated temp directories.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "extracts certs with = syntax, cleans multi-cert files, and rejects ad-hoc bundles in install",
    async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "p0-mac-helper-test-"));
      try {
        const binDir = NodePath.join(root, "bin");
        const appsDir = NodePath.join(root, "Applications");
        const workDir = NodePath.join(root, "Application Support", "download-1");
        const dmgSourceDir = NodePath.join(root, "dmg-contents");
        await NodeFSP.mkdir(binDir, { recursive: true });
        await NodeFSP.mkdir(appsDir, { recursive: true });
        await NodeFSP.mkdir(workDir, { recursive: true });
        await NodeFSP.mkdir(dmgSourceDir, { recursive: true });

        const writeShim = async (name: string, body: string) => {
          const target = NodePath.join(binDir, name);
          await NodeFSP.writeFile(target, `#!/bin/bash\nset -euo pipefail\n${body}\n`, {
            mode: 0o755,
          });
        };

        await writeShim(
          "codesign",
          `if [ "$1" = "--verify" ]; then
  exit 0
fi
if [ "$1" = "--display" ]; then
  shift
  case "$1" in
    --extract-certificates=*) prefix="\${1#--extract-certificates=}"; shift ;;
    --extract-certificates) echo "missing = argument" >&2; exit 1 ;;
    *) echo "unexpected flag: $1" >&2; exit 1 ;;
  esac
  bundle="$1"
  if [ -e "\${prefix}0" ] || [ -e "\${prefix}1" ]; then
    echo "stale cert file present before extraction" >&2
    exit 1
  fi
  echo "Executable=$bundle/Contents/MacOS/p0code" >&2
  if [ -f "$bundle/cert0" ]; then cp "$bundle/cert0" "\${prefix}0"; fi
  if [ -f "$bundle/cert1" ]; then cp "$bundle/cert1" "\${prefix}1"; fi
  exit 0
fi
exit 1`,
        );
        await writeShim(
          "shasum",
          `if [ "$1" = "-a" ] && [ "$2" = "256" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    exec sha256sum "$3"
  fi
  exec /usr/bin/shasum -a 256 "$3"
fi
exit 1`,
        );
        await writeShim(
          "hdiutil",
          `if [ "$1" = "attach" ]; then
  mount=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-mountpoint" ]; then mount="$2"; shift 2; continue; fi
    shift
  done
  cp -R ${JSON.stringify(dmgSourceDir)}/. "$mount/"
  exit 0
fi
if [ "$1" = "detach" ]; then
  rm -rf "$2"
  exit 0
fi
exit 1`,
        );
        await writeShim("ditto", 'rm -rf "$2"\ncp -R "$1" "$2"');
        await writeShim("xattr", "exit 0");
        await writeShim("open", "exit 0");
        await writeShim("PlistBuddy", 'echo "com.p0code.desktop"');

        const makeApp = async (dir: string, version: string, certs: ReadonlyArray<string>) => {
          await NodeFSP.mkdir(NodePath.join(dir, "Contents"), { recursive: true });
          await NodeFSP.writeFile(NodePath.join(dir, "version.txt"), version);
          for (const [index, cert] of certs.entries()) {
            await NodeFSP.writeFile(NodePath.join(dir, `cert${index}`), cert);
          }
        };

        const appPath = NodePath.join(appsDir, "Howard's p0code.app");
        const dmgPath = NodePath.join(workDir, "update.dmg");
        const dmgBytes = "fake-dmg-bytes";
        const checksum = NodeCrypto.createHash("sha256").update(dmgBytes).digest("hex");
        await NodeFSP.writeFile(dmgPath, dmgBytes);
        await NodeFSP.writeFile(NodePath.join(workDir, "cert1"), "stale-intermediate");
        await makeApp(appPath, "0.2.3", ["leaf-cert-A", "intermediate-cert"]);
        await makeApp(NodePath.join(dmgSourceDir, "p0code.app"), "0.2.4", ["leaf-cert-A"]);

        const exitedPid = NodeChildProcess.spawnSync("/bin/true").pid!;
        const rawScript = macUpdateHelper({
          app: appPath,
          dmg: dmgPath,
          directory: workDir,
          pid: exitedPid,
          checksum,
        });
        const syntax = NodeChildProcess.spawnSync("/bin/bash", ["-n"], {
          input: rawScript,
          encoding: "utf8",
        });
        expect(syntax.status, syntax.stderr).toBe(0);

        const scriptPath = NodePath.join(workDir, "install.sh");
        const testScript = rawScript
          .replace(
            "export PATH=/usr/bin:/bin:/usr/sbin:/sbin",
            `export PATH=${JSON.stringify(`${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`)}`,
          )
          .replaceAll("/usr/libexec/PlistBuddy", "PlistBuddy");
        await NodeFSP.writeFile(scriptPath, testScript, { mode: 0o700 });

        const prepare = NodeChildProcess.spawnSync("/bin/bash", [scriptPath, "prepare"], {
          encoding: "utf8",
        });
        expect(prepare.status).toBe(0);
        const filesAfterPrepare = await NodeFSP.readdir(workDir);
        expect(filesAfterPrepare.filter((name) => name.startsWith("cert"))).toEqual([]);

        const install = NodeChildProcess.spawnSync("/bin/bash", [scriptPath, "install"], {
          encoding: "utf8",
        });
        expect(install.status).toBe(0);
        expect(await NodeFSP.readFile(NodePath.join(appPath, "version.txt"), "utf8")).toBe("0.2.4");

        // Regression test: install must fail when both bundles lack signing certs (ad-hoc signed),
        // rather than letting bash's `||` suppress `set -e` and comparing empty fingerprints equal.
        const adhocWorkDir = NodePath.join(root, "Application Support", "download-adhoc");
        await NodeFSP.mkdir(adhocWorkDir, { recursive: true });
        const adhocApp = NodePath.join(appsDir, "AdHoc.app");
        await makeApp(adhocApp, "0.2.3", []);
        await makeApp(NodePath.join(adhocWorkDir, "staged.app"), "0.2.4", []);
        const adhocScriptPath = NodePath.join(adhocWorkDir, "install.sh");
        const adhocScript = macUpdateHelper({
          app: adhocApp,
          dmg: NodePath.join(adhocWorkDir, "update.dmg"),
          directory: adhocWorkDir,
          pid: exitedPid,
          checksum,
        })
          .replace(
            "export PATH=/usr/bin:/bin:/usr/sbin:/sbin",
            `export PATH=${JSON.stringify(`${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`)}`,
          )
          .replaceAll("/usr/libexec/PlistBuddy", "PlistBuddy");
        await NodeFSP.writeFile(adhocScriptPath, adhocScript, { mode: 0o700 });

        const adhocInstall = NodeChildProcess.spawnSync("/bin/bash", [adhocScriptPath, "install"], {
          encoding: "utf8",
        });
        expect(adhocInstall.status).not.toBe(0);
        expect(await NodeFSP.readFile(NodePath.join(adhocApp, "version.txt"), "utf8")).toBe(
          "0.2.3",
        );
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
});
