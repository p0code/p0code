// @effect-diagnostics nodeBuiltinImport:off -- Tests the plain-Node helper with real path separators.
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { previousAppHomePath } from "./appHomeMigration.ts";

describe("previousAppHomePath", () => {
  const home = NodePath.join(NodePath.sep, "Users", "alice");

  it("maps folders under ~/.p0code to their pre-rename ~/.hhh path", () => {
    expect(previousAppHomePath(NodePath.join(home, ".p0code", "userdata", "secrets"), home)).toBe(
      NodePath.join(home, ".hhh", "userdata", "secrets"),
    );
  });

  it("leaves every other path alone", () => {
    for (const path of [
      NodePath.join(home, ".p0code-other", "secrets"),
      NodePath.join(home, "custom", "secrets"),
      NodePath.join(home, ".t3", "userdata", "secrets"),
    ]) {
      expect(previousAppHomePath(path, home)).toBe(path);
    }
  });
});
