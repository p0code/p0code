// @effect-diagnostics nodeBuiltinImport:off -- Native updater integration tests use isolated temporary downloads and Node hashing.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { expect, it, vi } from "vite-plus/test";
import { app } from "electron";
import * as NodeChildProcess from "node:child_process";
import { MacGitHubUpdater } from "./MacGitHubUpdater.ts";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.2.3",
    getPath: () => fixture.directory,
    getAppPath: () => fixture.appPath,
    quit: vi.fn(),
  },
}));
const fixture = vi.hoisted(() => ({
  directory: "",
  appPath: "/Volumes/p0code/p0code.app/Contents/Resources/app.asar",
  failPrepare: false,
}));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    execFile: vi.fn(
      (
        _file: string,
        _args: string[],
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(fixture.failPrepare ? new Error("signature mismatch") : null, "", ""),
    ),
    spawn: vi.fn(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }),
  };
});

it("checks, downloads with progress, refuses corrupt bytes and permits a verified retry", async () => {
  const directory = (fixture.directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "p0-update-test-"),
  ));
  try {
    const bytes = new TextEncoder().encode("fake DMG fixture");
    const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    const feed = [
      {
        tag_name: "v0.2.4",
        draft: false,
        prerelease: false,
        body: "notes",
        html_url: "https://github.com/p0code/p0code/releases/tag/v0.2.4",
        assets: [
          {
            name: "p0code-universal.dmg",
            browser_download_url: "https://example.com/update.dmg",
            size: bytes.length,
          },
          { name: "SHA256SUMS", browser_download_url: "https://example.com/SHA256SUMS", size: 100 },
        ],
      },
    ];
    let corrupt = true;
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("api.github.com")) return Response.json(feed);
      if (url.endsWith("SHA256SUMS")) return new Response(`${hash}  p0code-universal.dmg`);
      return new Response(corrupt ? "corrupt" : bytes);
    });
    const updater = new MacGitHubUpdater("p0code/p0code", request);
    const available = vi.fn();
    const downloaded = vi.fn();
    const progress = vi.fn();
    updater
      .on("update-available", available)
      .on("update-downloaded", downloaded)
      .on("download-progress", progress);
    await updater.checkForUpdates();
    expect(available).toHaveBeenCalledWith(expect.objectContaining({ version: "0.2.4" }));
    await expect(updater.downloadUpdate()).rejects.toThrow("checksum mismatch");
    expect(downloaded).not.toHaveBeenCalled();
    await expect(updater.quitAndInstall()).rejects.toThrow("Download and verify");
    corrupt = false;
    await updater.downloadUpdate();
    expect(progress).toHaveBeenCalled();
    expect(downloaded).toHaveBeenCalledWith(expect.objectContaining({ version: "0.2.4" }));
    await expect(updater.quitAndInstall()).rejects.toThrow("writable Applications folder");
    fixture.appPath = NodePath.join(directory, "p0code.app/Contents/Resources/app.asar");
    await expect(updater.quitAndInstall()).rejects.toThrow("not writable");
    await NodeFSP.mkdir(NodePath.join(directory, "p0code.app"));
    fixture.failPrepare = true;
    await expect(updater.quitAndInstall()).rejects.toThrow("current app has been kept");
    expect(app.quit).not.toHaveBeenCalled();
    expect(NodeChildProcess.spawn).not.toHaveBeenCalled();
    fixture.failPrepare = false;
    await updater.quitAndInstall();
    expect(NodeChildProcess.execFile).toHaveBeenLastCalledWith(
      "/bin/bash",
      [expect.stringContaining("install.sh"), "prepare"],
      expect.any(Function),
    );
    expect(NodeChildProcess.spawn).toHaveBeenCalledWith(
      "/bin/bash",
      [expect.stringContaining("install.sh"), "install"],
      expect.objectContaining({ detached: true }),
    );
    expect(app.quit).toHaveBeenCalledOnce();
    request.mockResolvedValueOnce(Response.json([{ ...feed[0], tag_name: "v0.2.3" }]));
    const latest = vi.fn();
    updater.on("update-not-available", latest);
    await updater.checkForUpdates();
    expect(latest).toHaveBeenCalled();
    request.mockResolvedValueOnce(new Response("offline", { status: 503 }));
    await expect(updater.checkForUpdates()).rejects.toThrow("HTTP 503");
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
