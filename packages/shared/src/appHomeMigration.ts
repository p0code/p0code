// @effect-diagnostics nodeBuiltinImport:off -- Runs before any Effect runtime, in the server CLI and the Electron main process.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { APP_HOME_DIRECTORY_NAME, PREVIOUS_APP_HOME_DIRECTORY_NAME } from "./appHome.ts";

/**
 * Moves the pre-rename `~/.hhh` home to `~/.p0code` once, when only the old one exists.
 * A failed move leaves `~/.hhh` in place and the app starts on a fresh `~/.p0code`.
 */
export function moveAppHomeFromPreviousName(homeDirectory: string): void {
  // A test that forgets to fake the home would otherwise move the developer's live install.
  if (process.env.VITEST) return;
  const next = NodePath.join(homeDirectory, APP_HOME_DIRECTORY_NAME);
  const previous = NodePath.join(homeDirectory, PREVIOUS_APP_HOME_DIRECTORY_NAME);
  if (NodeFS.existsSync(next) || !NodeFS.existsSync(previous)) return;
  try {
    NodeFS.renameSync(previous, next);
  } catch {
    // Another process won the race, or the folder is on another volume; either way leave it.
  }
}

/**
 * Keychain entries are namespaced by a hash of their secrets folder, so a home moved by
 * `moveAppHomeFromPreviousName` keeps hashing its old `~/.hhh` path and finds its entries.
 * `apps/p0d/internal/auth/secrets.go` maps paths the same way.
 */
export function previousAppHomePath(resolvedPath: string, homeDirectory: string): string {
  const next = NodePath.join(homeDirectory, APP_HOME_DIRECTORY_NAME);
  if (resolvedPath !== next && !resolvedPath.startsWith(next + NodePath.sep)) return resolvedPath;
  return NodePath.join(
    homeDirectory,
    PREVIOUS_APP_HOME_DIRECTORY_NAME,
    resolvedPath.slice(next.length),
  );
}
