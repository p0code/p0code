// @effect-diagnostics nodeBuiltinImport:off -- Electron's updater adapter owns detached native helper processes and streamed downloads.
import * as NodeEvents from "node:events";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { app } from "electron";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { checksumForAsset, selectGitHubRelease, verifyChecksum } from "./githubRelease.ts";
import { macUpdateHelper } from "./macUpdateHelper.ts";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);

export class MacGitHubUpdater extends NodeEvents.EventEmitter {
  channel = "latest";
  allowDowngrade = false;
  private repository: string;
  private offered: ReturnType<typeof selectGitHubRelease> = null;
  private downloaded: { file: string; checksum: string; version: string } | null = null;
  private readonly request: typeof fetch;

  constructor(repository: string, request: typeof fetch = fetch) {
    super();
    this.repository = repository;
    this.request = request;
  }

  setRepository(owner: string, repo: string) {
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo))
      throw new Error("Invalid update repository.");
    this.repository = `${owner}/${repo}`;
  }

  private async response(url: string, timeout = 30_000) {
    if (!url.startsWith("https://")) throw new Error("Update downloads require HTTPS.");
    const response = await this.request(url, {
      signal: AbortSignal.timeout(timeout),
      headers: { "User-Agent": "p0code-updater" },
    });
    if (!response.ok) throw new Error(`Update request failed (HTTP ${response.status}).`);
    return response;
  }

  async checkForUpdates() {
    const raw: unknown = await (
      await this.response(`https://api.github.com/repos/${this.repository}/releases?per_page=100`)
    ).json();
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Use the native Mac architecture when migrating from Rosetta.
    const executableArch = process.arch;
    const release = selectGitHubRelease(
      raw,
      this.channel,
      app.runningUnderARM64Translation ? "arm64" : executableArch,
    );
    this.offered = release;
    if (
      !release ||
      (!this.allowDowngrade && compareSemverVersions(release.version, app.getVersion()) <= 0)
    ) {
      this.emit(
        "update-not-available",
        release
          ? undefined
          : {
              message:
                "No compatible release has been published for this update channel and architecture.",
            },
      );
      return;
    }
    this.emit("update-available", release);
  }

  async downloadUpdate() {
    const release = this.offered;
    if (!release) throw new Error("No update release is available.");
    if (this.downloaded)
      await NodeFSP.rm(NodePath.dirname(this.downloaded.file), { recursive: true, force: true });
    this.downloaded = null;
    const sums = await (await this.response(release.sums.browser_download_url)).text();
    const checksum = checksumForAsset(sums, release.asset.name);
    const directory = NodePath.join(app.getPath("userData"), "updates");
    await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
    const downloadDir = await NodeFSP.mkdtemp(NodePath.join(directory, "download-"));
    const file = NodePath.join(downloadDir, "update.dmg");
    try {
      const response = await this.response(release.asset.browser_download_url, 30 * 60 * 1000);
      if (!response.body) throw new Error("The update download is empty.");
      const hash = NodeCrypto.createHash("sha256");
      let received = 0;
      const handle = await NodeFSP.open(file, "wx", 0o600);
      try {
        for await (const chunk of response.body) {
          hash.update(chunk);
          await handle.writeFile(chunk);
          received += chunk.length;
          this.emit("download-progress", {
            percent: Math.min(99, (received / release.downloadSize) * 100),
          });
        }
      } finally {
        await handle.close();
      }
      verifyChecksum(hash.digest("hex"), checksum);
      if (received !== release.downloadSize)
        throw new Error("Update download size does not match the release.");
      this.downloaded = { file, checksum, version: release.version };
      this.emit("update-downloaded", { ...release, downloadedFile: file });
    } catch (error) {
      await NodeFSP.rm(downloadDir, { recursive: true, force: true });
      throw error;
    }
  }

  async quitAndInstall() {
    const downloaded = this.downloaded;
    if (!downloaded) throw new Error("Download and verify an update before installing.");
    const bundle = app.getAppPath().match(/^(.+\.app)\/Contents\//)?.[1];
    if (!bundle || bundle.startsWith("/Volumes/") || bundle.includes("/AppTranslocation/")) {
      throw new Error("Move p0code to a writable Applications folder before installing updates.");
    }
    try {
      await NodeFSP.access(bundle, NodeFS.constants.W_OK);
      await NodeFSP.access(NodePath.dirname(bundle), NodeFS.constants.W_OK);
    } catch {
      throw new Error(
        "Install location is not writable. Move p0code to a writable Applications folder.",
      );
    }
    const directory = NodePath.dirname(downloaded.file);
    const script = NodePath.join(directory, "install.sh");
    await NodeFSP.writeFile(
      script,
      macUpdateHelper({
        app: bundle,
        dmg: downloaded.file,
        directory,
        pid: process.pid,
        checksum: downloaded.checksum,
      }),
      { mode: 0o700 },
    );
    await NodeFSP.chmod(script, 0o700);
    try {
      await execute("/bin/bash", [script, "prepare"]);
    } catch {
      const log = await NodeFSP.readFile(NodePath.join(directory, "install.log"), "utf8").catch(
        () => "",
      );
      throw new Error(
        `Update verification failed. The current app has been kept. ${log.trim().split(/\r?\n/).slice(-1).join("")}`,
      );
    }
    const log = await NodeFSP.open(NodePath.join(directory, "install.log"), "a", 0o600);
    try {
      const child = NodeChildProcess.spawn("/bin/bash", [script, "install"], {
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    } finally {
      await log.close();
    }
    app.quit();
  }
}
