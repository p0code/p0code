// @effect-diagnostics nodeBuiltinImport:off -- Runs at the top of the Electron main process, before any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { appHomeFromEnv } from "@t3tools/shared/appHome";
import { moveAppHomeFromPreviousName } from "@t3tools/shared/appHomeMigration";

const ELECTRON_PROFILE_RENAMES = [
  ["hhhcode", "p0code"],
  ["hhhcode-dev", "p0code-dev"],
] as const;

/**
 * Carries an install from before the HHHCode -> p0code rename over: the `~/.hhh` home and the
 * Electron profile folders. Must run before anything resolves either path.
 */
export function moveDesktopFoldersFromPreviousName(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly appDataDirectory: string;
}): void {
  if (appHomeFromEnv(input.env) === undefined) moveAppHomeFromPreviousName(input.homeDirectory);
  for (const [previousName, nextName] of ELECTRON_PROFILE_RENAMES) {
    const previous = NodePath.join(input.appDataDirectory, previousName);
    const next = NodePath.join(input.appDataDirectory, nextName);
    if (NodeFS.existsSync(next) || !NodeFS.existsSync(previous)) continue;
    try {
      NodeFS.renameSync(previous, next);
    } catch {
      // Leave the old profile; the app starts with a fresh one.
    }
  }
}
