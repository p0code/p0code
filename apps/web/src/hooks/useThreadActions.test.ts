import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  canMoveThreadIntoProject,
  canTurnThreadIntoProject,
  navigateAfterThreadDeletion,
} from "./useThreadActions";
import { toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import * as entities from "../state/entities";

describe("navigateAfterThreadDeletion", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports a rejected navigation without failing the completed deletion", async () => {
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("navigation-error");

    await expect(
      navigateAfterThreadDeletion(() => Promise.reject(new Error("route unavailable"))),
    ).resolves.toBeUndefined();

    expect(addToast).toHaveBeenCalledOnce();
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Thread deleted, but navigation failed",
        description: "route unavailable",
      }),
    );
  });
});

describe("legacy scratch thread move and promotion eligibility", () => {
  afterEach(() => vi.restoreAllMocks());

  it("allows moving and promoting a thread in a migrated legacy scratch project", () => {
    const environmentId = EnvironmentId.make("env:local");
    const legacyScratchProjectId = ProjectId.make("project:legacy-scratch");
    const promotedProjectId = ProjectId.make("project:legacy-promoted");
    const legacyThreadRef: ScopedThreadRef = {
      environmentId,
      threadId: ThreadId.make("thread:legacy"),
    };
    const promotedThreadRef: ScopedThreadRef = {
      environmentId,
      threadId: ThreadId.make("thread:promoted"),
    };
    const legacyRoot = "/legacy/.t3/scratch";
    const currentRoot = "/current/.p0code/scratch";

    vi.spyOn(appAtomRegistry, "get").mockImplementation((atom: unknown) => {
      if (atom === environmentServerConfigsAtom) {
        return new Map([
          [
            environmentId,
            {
              scratchWorkspaceRoot: currentRoot,
              legacyScratchWorkspaceRoots: [legacyRoot],
              environment: {
                capabilities: {
                  threadMoveToProject: true,
                  threadProjectFromScratch: true,
                },
              },
            },
          ],
        ]);
      }
      return undefined as never;
    });
    vi.spyOn(entities, "readThreadShell").mockImplementation((ref: ScopedThreadRef) =>
      ref.threadId === legacyThreadRef.threadId
        ? ({
            projectId: legacyScratchProjectId,
            worktreePath: `${legacyRoot}/2026-11-24-fork-t3code`,
          } as never)
        : ({
            projectId: promotedProjectId,
            worktreePath: `${legacyRoot}/2026-11-19-promoted`,
          } as never),
    );
    vi.spyOn(entities, "readProject").mockImplementation((ref: ScopedProjectRef) =>
      ref.projectId === legacyScratchProjectId
        ? ({ workspaceRoot: legacyRoot } as never)
        : ({ workspaceRoot: `${legacyRoot}/2026-11-19-promoted` } as never),
    );

    expect(canMoveThreadIntoProject(legacyThreadRef)).toBe(true);
    expect(canTurnThreadIntoProject(legacyThreadRef)).toBe(true);
    expect(canMoveThreadIntoProject(promotedThreadRef)).toBe(false);
    expect(canTurnThreadIntoProject(promotedThreadRef)).toBe(false);
  });
});
