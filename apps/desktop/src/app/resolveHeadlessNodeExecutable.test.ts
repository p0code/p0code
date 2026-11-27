// @effect-diagnostics nodeBuiltinImport:off -- Creates temporary app bundle layouts on disk to verify executable resolution.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveHeadlessNodeExecutable } from "./resolveHeadlessNodeExecutable.ts";

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

const tempRoot = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-headless-node-exec-"));
  directories.push(root);
  return root;
};

const writeFile = (filePath: string, mode: number) => {
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  NodeFS.writeFileSync(filePath, "#!/bin/sh\n", { mode });
};

describe("resolveHeadlessNodeExecutable", () => {
  it("resolves the macOS Helper executable inside a packaged app bundle", () => {
    const root = tempRoot();
    const execPath = NodePath.posix.join(root, "p0code.app", "Contents", "MacOS", "p0code");
    const helperPath = NodePath.posix.join(
      root,
      "p0code.app",
      "Contents",
      "Frameworks",
      "p0code Helper.app",
      "Contents",
      "MacOS",
      "p0code Helper",
    );
    writeFile(execPath, 0o755);
    writeFile(helperPath, 0o755);

    expect(resolveHeadlessNodeExecutable({ platform: "darwin", execPath })).toBe(helperPath);
  });

  it("handles product names with spaces such as Nightly builds", () => {
    const execPath = "/Applications/p0code (Nightly).app/Contents/MacOS/p0code (Nightly)";
    const expectedHelper =
      "/Applications/p0code (Nightly).app/Contents/Frameworks/p0code (Nightly) Helper.app/Contents/MacOS/p0code (Nightly) Helper";

    expect(
      resolveHeadlessNodeExecutable({
        platform: "darwin",
        execPath,
        isExecutable: (candidate) => candidate === expectedHelper,
      }),
    ).toBe(expectedHelper);
  });

  it("falls back to execPath when the helper binary does not exist", () => {
    const root = tempRoot();
    const execPath = NodePath.posix.join(root, "p0code.app", "Contents", "MacOS", "p0code");
    writeFile(execPath, 0o755);

    expect(resolveHeadlessNodeExecutable({ platform: "darwin", execPath })).toBe(execPath);
  });

  it("falls back to execPath when the helper path is not an executable file", () => {
    const root = tempRoot();
    const execPath = NodePath.posix.join(root, "p0code.app", "Contents", "MacOS", "p0code");
    const helperPath = NodePath.posix.join(
      root,
      "p0code.app",
      "Contents",
      "Frameworks",
      "p0code Helper.app",
      "Contents",
      "MacOS",
      "p0code Helper",
    );
    writeFile(execPath, 0o755);
    writeFile(helperPath, 0o644);

    expect(resolveHeadlessNodeExecutable({ platform: "darwin", execPath })).toBe(execPath);

    NodeFS.rmSync(helperPath);
    NodeFS.mkdirSync(helperPath, { recursive: true });
    expect(resolveHeadlessNodeExecutable({ platform: "darwin", execPath })).toBe(execPath);
  });

  it("falls back to execPath when not running from an app bundle or already running as a helper", () => {
    const probes: Array<string> = [];
    const probe = (candidate: string) => {
      probes.push(candidate);
      return true;
    };

    const plainNode = "/usr/local/bin/node";
    expect(
      resolveHeadlessNodeExecutable({
        platform: "darwin",
        execPath: plainNode,
        isExecutable: probe,
      }),
    ).toBe(plainNode);

    const alreadyHelper =
      "/Applications/p0code.app/Contents/Frameworks/p0code Helper.app/Contents/MacOS/p0code Helper";
    expect(
      resolveHeadlessNodeExecutable({
        platform: "darwin",
        execPath: alreadyHelper,
        isExecutable: probe,
      }),
    ).toBe(alreadyHelper);

    expect(probes).toEqual([]);
  });

  it("returns execPath untouched on Windows and Linux", () => {
    const probes: Array<string> = [];
    const probe = (candidate: string) => {
      probes.push(candidate);
      return true;
    };

    const winExec = "C:\\Program Files\\p0code\\p0code.exe";
    expect(
      resolveHeadlessNodeExecutable({ platform: "win32", execPath: winExec, isExecutable: probe }),
    ).toBe(winExec);

    const linuxExec = "/opt/p0code/p0code";
    expect(
      resolveHeadlessNodeExecutable({
        platform: "linux",
        execPath: linuxExec,
        isExecutable: probe,
      }),
    ).toBe(linuxExec);

    expect(probes).toEqual([]);
  });
});
