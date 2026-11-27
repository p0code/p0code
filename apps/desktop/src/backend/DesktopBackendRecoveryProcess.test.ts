// @effect-diagnostics nodeBuiltinImport:off -- Creates a temporary macOS bundle layout to verify Helper execPath wiring.
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, beforeEach, describe, it, vi } from "vite-plus/test";

const forkMock = vi.hoisted(() =>
  vi.fn<
    (
      _path: string,
      _args: ReadonlyArray<string>,
      _options: { env?: NodeJS.ProcessEnv; execPath?: string },
    ) => unknown
  >(),
);

vi.mock("node:child_process", () => ({ fork: forkMock }));

import * as DesktopBackendRecoveryProcess from "./DesktopBackendRecoveryProcess.ts";

const directories: Array<string> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

beforeEach(() => {
  forkMock.mockReset();
});

describe("DesktopBackendRecoveryProcess", () => {
  it("forks the recovery worker with the macOS Helper executable on a packaged bundle layout", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-recovery-proc-"));
    directories.push(root);
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
    for (const filePath of [execPath, helperPath]) {
      NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
      NodeFS.writeFileSync(filePath, "#!/bin/sh\n", { mode: 0o755 });
    }
    vi.spyOn(process, "execPath", "get").mockReturnValue(execPath);

    const worker = Object.assign(new NodeEvents.EventEmitter(), {
      kill: vi.fn(() => true),
    });
    forkMock.mockImplementation(() => {
      queueMicrotask(() => worker.emit("exit", 0));
      return worker;
    });

    const recovery = DesktopBackendRecoveryProcess.make({
      appDataDirectory: root,
      stateDir: NodePath.join(root, "home"),
      platform: "darwin",
      onRecovery: () => {},
      onError: () => {},
    });
    await recovery.recover(new AbortController().signal);

    assert.lengthOf(forkMock.mock.calls, 1);
    assert.equal(forkMock.mock.calls[0]?.[2]?.execPath, helperPath);
    assert.equal(forkMock.mock.calls[0]?.[2]?.env?.ELECTRON_RUN_AS_NODE, "1");
  });
});
