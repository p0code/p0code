import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
  ThreadMoveToProjectError,
  type VcsStatusLocalResult,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadProjectMove from "./ThreadProjectMove.ts";

const threadId = ThreadId.make("thread:move");
const sourceProjectId = ProjectId.make("project:scratch");
const targetProjectId = ProjectId.make("project:repo");
const sourceRoot = "/scratch";
const targetRoot = "/repo";

interface State {
  readonly dirty?: boolean;
  readonly dispatchFails?: boolean;
  readonly createWorktreeFails?: boolean;
  readonly taskMoveFails?: boolean;
  readonly thread?: Partial<OrchestrationV2ThreadShell>;
  readonly commands: Array<{ readonly type: string; readonly [key: string]: unknown }>;
  readonly taskMoves: ProjectId[];
  readonly createdWorktrees: string[];
  readonly removedWorktrees: Array<{ readonly path: string; readonly force: boolean }>;
}

function makeState(overrides: Partial<State> = {}): State {
  return {
    commands: [],
    taskMoves: [],
    createdWorktrees: [],
    removedWorktrees: [],
    ...overrides,
  };
}

const status = (isRepo: boolean, hasWorkingTreeChanges: boolean): VcsStatusLocalResult => ({
  isRepo,
  hasPrimaryRemote: isRepo,
  isDefaultRef: false,
  refName: isRepo ? "main" : null,
  hasWorkingTreeChanges,
  workingTree: { files: [], insertions: 0, deletions: 0 },
});

const layerFor = (state: State) =>
  ThreadProjectMove.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              projectId: sourceProjectId,
              title: "Scratch chat",
              branch: "t3/old",
              worktreePath: "/scratch/notes-a1b2",
              ...state.thread,
            } as never),
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, deletedAt: null },
              runs: [],
              runtimeRequests: [],
            } as never),
          dispatch: (command) =>
            Effect.suspend(() => {
              state.commands.push(command as never);
              return state.dispatchFails
                ? Effect.fail(new Error("commit failed"))
                : Effect.succeed({ sequence: state.commands.length } as never);
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (projectId) =>
            Effect.succeed(
              projectId === targetProjectId
                ? Option.some({
                    id: targetProjectId,
                    title: "Repo",
                    workspaceRoot: targetRoot,
                    deletedAt: null,
                  } as never)
                : projectId === sourceProjectId
                  ? Option.some({
                      id: sourceProjectId,
                      title: "No project",
                      workspaceRoot: sourceRoot,
                      deletedAt: null,
                    } as never)
                  : Option.none(),
            ),
        }),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          moveThreadTasks: ({ projectId }) =>
            Effect.suspend(() => {
              if (state.taskMoveFails === true)
                return Effect.fail(new Error("move failed") as never);
              state.taskMoves.push(projectId);
              return Effect.void;
            }),
        }),
        Layer.mock(GitWorkflow.GitWorkflowService)({
          localStatus: () => Effect.succeed(status(true, state.dirty === true)),
          currentBranch: () => Effect.succeed("main"),
          hasCommit: () => Effect.succeed(true),
          createWorktree: (input) =>
            Effect.suspend(() => {
              if (state.createWorktreeFails === true) {
                return Effect.fail(new Error("worktree failed") as never);
              }
              const path = "/tmp/repo-worktree";
              state.createdWorktrees.push(path);
              return Effect.succeed({
                worktree: { path, refName: input.newRefName ?? "main" },
              } as never);
            }),
          removeWorktree: (input) =>
            Effect.sync(() => {
              state.removedWorktrees.push({ path: input.path, force: input.force === true });
            }),
        }),
        Layer.mock(TaskFolders.TaskFolders)({
          plan: () => Effect.succeed(null),
          remove: () => Effect.void,
        }),
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    ),
  );

const run = <A, E>(
  state: State,
  effect: Effect.Effect<A, E, ThreadProjectMove.ThreadProjectMove>,
) => effect.pipe(Effect.provide(layerFor(state)));

const move = (input: {
  readonly workspace?: "keep" | "project-root" | "new-worktree";
  readonly acceptOutOfTree?: boolean;
}) =>
  Effect.flatMap(ThreadProjectMove.ThreadProjectMove, (service) =>
    service.move({ threadId, projectId: targetProjectId, ...input }),
  );

const adoptCommand = (state: State) => {
  const command = state.commands.find((entry) => entry.type === "thread.project.adopt-folder");
  assert.isDefined(command);
  return command!;
};

describe("ThreadProjectMove", () => {
  it.effect("keeps the thread's folder and records the new project", () => {
    const state = makeState({ thread: { worktreePath: "/scratch/notes-a1b2" } });
    return run(
      state,
      move({ workspace: "keep", acceptOutOfTree: true }).pipe(
        Effect.map((result: unknown) => {
          assert.deepEqual(result, {
            projectId: targetProjectId,
            workspace: "keep",
            worktreePath: "/scratch/notes-a1b2",
            branch: "t3/old",
          });
          assert.deepEqual(adoptCommand(state), {
            type: "thread.project.adopt-folder",
            commandId: adoptCommand(state).commandId,
            threadId,
            projectId: targetProjectId,
            worktreePath: "/scratch/notes-a1b2",
            branch: "t3/old",
            allowOutsideWorkspace: true,
          });
          assert.deepEqual(state.taskMoves, [targetProjectId]);
          assert.deepEqual(state.createdWorktrees, []);
        }),
      ),
    );
  });

  it.effect("refuses to keep an out-of-tree folder without acceptance", () => {
    const state = makeState({ thread: { worktreePath: "/scratch/notes-a1b2" } });
    return run(
      state,
      move({ workspace: "keep" }).pipe(
        Effect.flip,
        Effect.map((error) => {
          assert.instanceOf(error, ThreadMoveToProjectError);
          assert.match(error.message, /outside that project/);
          assert.deepEqual(state.commands, []);
          assert.deepEqual(state.taskMoves, []);
        }),
      ),
    );
  });

  it.effect("points the thread at the project root and clears its branch", () => {
    const state = makeState({ thread: { worktreePath: "/scratch/notes-a1b2" } });
    return run(
      state,
      move({ workspace: "project-root" }).pipe(
        Effect.map((result: unknown) => {
          assert.deepEqual(result, {
            projectId: targetProjectId,
            workspace: "project-root",
            worktreePath: null,
            branch: null,
          });
          assert.deepEqual(adoptCommand(state), {
            type: "thread.project.adopt-folder",
            commandId: adoptCommand(state).commandId,
            threadId,
            projectId: targetProjectId,
            worktreePath: null,
            branch: null,
          });
          assert.deepEqual(state.taskMoves, [targetProjectId]);
        }),
      ),
    );
  });

  it.effect("creates and binds a new worktree without touching the old folder", () => {
    const state = makeState({ thread: { worktreePath: "/scratch/notes-a1b2" } });
    return run(
      state,
      move({ workspace: "new-worktree" }).pipe(
        Effect.map((result: { worktreePath: string | null; branch: string | null }) => {
          assert.equal(result.worktreePath, "/tmp/repo-worktree");
          assert.match(result.branch ?? "", /^t3\//);
          assert.deepEqual(state.createdWorktrees, ["/tmp/repo-worktree"]);
          assert.equal(adoptCommand(state).worktreePath, "/tmp/repo-worktree");
          assert.equal(adoptCommand(state).branch, result.branch);
          assert.deepEqual(state.removedWorktrees, []);
        }),
      ),
    );
  });

  it.effect("refuses to leave a dirty workspace behind", () => {
    const state = makeState({ dirty: true, thread: { worktreePath: "/scratch/notes-a1b2" } });
    return run(
      state,
      move({ workspace: "project-root" }).pipe(
        Effect.flip,
        Effect.map((error) => {
          assert.instanceOf(error, ThreadMoveToProjectError);
          assert.match(error.message, /uncommitted changes/);
          assert.deepEqual(state.commands, []);
          assert.deepEqual(state.taskMoves, []);
        }),
      ),
    );
  });

  it.effect("rolls the tasks and the new worktree back when the move fails", () => {
    const state = makeState({
      dispatchFails: true,
      thread: { worktreePath: "/scratch/notes-a1b2" },
    });
    return run(
      state,
      move({ workspace: "new-worktree" }).pipe(
        Effect.flip,
        Effect.map((error) => {
          assert.instanceOf(error, ThreadMoveToProjectError);
          assert.deepEqual(state.taskMoves, [targetProjectId, sourceProjectId]);
          assert.deepEqual(state.removedWorktrees, [{ path: "/tmp/repo-worktree", force: true }]);
          assert.equal(
            state.commands.filter((entry) => entry.type === "thread.project.adopt-folder").length,
            1,
          );
        }),
      ),
    );
  });

  it.effect("removes a created worktree when moving the tasks fails first", () => {
    const state = makeState({ taskMoveFails: true });
    return run(
      state,
      move({ workspace: "new-worktree" }).pipe(
        Effect.flip,
        Effect.map((error) => {
          assert.instanceOf(error, ThreadMoveToProjectError);
          assert.deepEqual(state.taskMoves, []);
          assert.deepEqual(state.removedWorktrees, [{ path: "/tmp/repo-worktree", force: true }]);
          assert.deepEqual(state.commands, []);
        }),
      ),
    );
  });
});
