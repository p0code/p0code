import { describe, expect, it } from "vite-plus/test";

import { isScratchProject } from "./projects.ts";

describe("isScratchProject", () => {
  it.each([null, undefined])(
    "recognises a loaded scratch project when its environment offers no available root (%s)",
    (scratchWorkspaceRoot) => {
      const project = { workspaceRoot: "/remote/scratch", isScratch: true as const };

      expect(isScratchProject(project, scratchWorkspaceRoot)).toBe(true);
    },
  );

  it("recognises a legacy migrated scratch project and excludes its subfolders", () => {
    const legacyRoot = "/legacy/.t3/scratch";
    expect(
      isScratchProject({ workspaceRoot: legacyRoot }, "/current/.p0code/scratch", [legacyRoot]),
    ).toBe(true);
    expect(isScratchProject({ workspaceRoot: `${legacyRoot}/` }, null, [legacyRoot])).toBe(true);
    expect(
      isScratchProject(
        { workspaceRoot: `${legacyRoot}/2026-11-24-promoted` },
        "/current/.p0code/scratch",
        [legacyRoot],
      ),
    ).toBe(false);
  });
});
