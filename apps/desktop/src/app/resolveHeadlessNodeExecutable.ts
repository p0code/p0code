// @effect-diagnostics nodeBuiltinImport:off -- Resolves the macOS Electron Helper binary synchronously at process spawn boundaries.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface ResolveHeadlessNodeExecutableOptions {
  readonly execPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly isExecutable?: (candidate: string) => boolean;
}

const defaultIsExecutable = (candidate: string): boolean => {
  try {
    const stat = NodeFS.statSync(candidate);
    if (!stat.isFile()) return false;
    NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Uses the macOS Electron Helper (`LSUIElement`) for `ELECTRON_RUN_AS_NODE=1` children so they stay
 * out of the Dock. Resolves from the bundle layout without gating on `isPackaged` so dev runs and
 * non-Effect callers (like recovery) always agree on the same executable.
 */
export function resolveHeadlessNodeExecutable(
  options: ResolveHeadlessNodeExecutableOptions = {},
): string {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Synchronous fallback used across non-Effect spawn helpers.
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  if (platform !== "darwin") {
    return execPath;
  }

  const macOsDir = NodePath.posix.dirname(execPath);
  if (NodePath.posix.basename(macOsDir) !== "MacOS") {
    return execPath;
  }

  const contentsDir = NodePath.posix.dirname(macOsDir);
  if (NodePath.posix.basename(contentsDir) !== "Contents") {
    return execPath;
  }

  const executableName = NodePath.posix.basename(execPath);
  if (!executableName || executableName.endsWith(" Helper")) {
    return execPath;
  }

  const helperName = `${executableName} Helper`;
  const helperPath = NodePath.posix.join(
    contentsDir,
    "Frameworks",
    `${helperName}.app`,
    "Contents",
    "MacOS",
    helperName,
  );
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  return isExecutable(helperPath) ? helperPath : execPath;
}
