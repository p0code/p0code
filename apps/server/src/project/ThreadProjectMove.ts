import {
  CommandId,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  ThreadId,
  type ThreadMoveToProjectInput,
  type ThreadMoveToProjectResult,
  ThreadMoveToProjectError,
  type ThreadMoveWorkspace,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import { threadHasUnfinishedWork } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";

const DEFAULT_WORKSPACE: ThreadMoveWorkspace = "project-root";

/** A folder is inside a root when it is the root or a path below it. */
function isWithinRoot(path: Path.Path, candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export class ThreadProjectMove extends Context.Service<
  ThreadProjectMove,
  {
    /**
     * Moves a thread into an existing project without changing its id or anything stored on it.
     * The project, workspace and scheduled tasks either all change or none do.
     */
    readonly move: (
      input: ThreadMoveToProjectInput,
    ) => Effect.Effect<ThreadMoveToProjectResult, ThreadMoveToProjectError>;
  }
>()("p0/project/ThreadProjectMove") {}

interface CreatedWorktree {
  readonly path: string;
  readonly branch: string;
  /** Set when the worktree is a task folder, which is removed through its own record. */
  readonly taskFolderRoot?: string;
}

interface MoveTarget {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const git = yield* GitWorkflow.GitWorkflowService;
  const taskFolders = yield* TaskFolders.TaskFolders;
  const random = yield* SecureRandom.SecureRandom;
  const path = yield* Path.Path;

  const fail = (target: MoveTarget, reason: string, cause?: unknown) =>
    new ThreadMoveToProjectError({
      ...target,
      reason,
      ...(cause === undefined ? {} : { cause }),
    });

  const readFailure = (target: MoveTarget, reason: string) => (cause: unknown) =>
    fail(target, reason, cause);

  /** A move to another folder must not strand uncommitted work behind it. */
  const refuseDirty = Effect.fn("ThreadProjectMove.refuseDirty")(function* (
    target: MoveTarget,
    cwd: string,
  ) {
    const status = yield* git
      .localStatus({ cwd })
      .pipe(
        Effect.mapError(
          readFailure(target, "Could not read this thread's folder. Nothing was changed."),
        ),
      );
    if (status.isRepo && status.hasWorkingTreeChanges) {
      return yield* fail(
        target,
        "This thread has uncommitted changes. Commit or stash them before moving it to another folder.",
      );
    }
  });

  const createWorktree = Effect.fn("ThreadProjectMove.createWorktree")(function* (
    target: MoveTarget,
    workspaceRoot: string,
  ) {
    const notRepository = fail(
      target,
      "A new worktree needs a project with a Git repository. Nothing was changed.",
    );
    const status = yield* git
      .localStatus({ cwd: workspaceRoot })
      .pipe(
        Effect.mapError((cause) =>
          fail(
            target,
            "A new worktree needs a project with a Git repository. Nothing was changed.",
            cause,
          ),
        ),
      );
    if (!status.isRepo) return yield* notRepository;

    const currentBranch = yield* git
      .currentBranch(workspaceRoot)
      .pipe(Effect.orElseSucceed(() => null));
    const hasHead = yield* git
      .hasCommit({ cwd: workspaceRoot, refName: "HEAD" })
      .pipe(Effect.orElseSucceed(() => false));
    const baseRef = currentBranch ?? (hasHead ? "HEAD" : null);
    if (baseRef === null) {
      return yield* fail(
        target,
        "That project has no commit to start a worktree from. Nothing was changed.",
      );
    }

    const uuid = yield* random.uuidV4();
    const branch = buildTemporaryWorktreeBranchName(() => uuid.replaceAll("-", ""));
    const plan = yield* taskFolders
      .plan({ projectId: target.projectId })
      .pipe(
        Effect.mapError((cause) =>
          fail(target, "Could not prepare a worktree. Nothing was changed.", cause),
        ),
      );
    if (plan === null) {
      const result = yield* git
        .createWorktree({
          cwd: workspaceRoot,
          refName: baseRef,
          newRefName: branch,
          baseRefName: baseRef,
          path: null,
        })
        .pipe(
          Effect.mapError((cause) =>
            fail(target, "Could not create a worktree. Nothing was changed.", cause),
          ),
        );
      return {
        path: result.worktree.path,
        branch: result.worktree.refName,
      } satisfies CreatedWorktree;
    }
    const created = yield* taskFolders
      .create({
        plan,
        branch,
        projectStart: { refName: baseRef, baseRefName: baseRef },
        startFromOrigin: false,
        projectCommands: "permitted",
      })
      .pipe(
        Effect.mapError((cause) =>
          fail(target, "Could not create a worktree. Nothing was changed.", cause),
        ),
      );
    return {
      path: created.taskFolder.projectPath,
      branch: created.branch,
      taskFolderRoot: created.taskFolder.root,
    } satisfies CreatedWorktree;
  });

  const removeWorktree = Effect.fn("ThreadProjectMove.removeWorktree")(function* (
    created: CreatedWorktree,
    workspaceRoot: string,
  ) {
    if (created.taskFolderRoot !== undefined) {
      yield* taskFolders
        .remove({
          root: created.taskFolderRoot,
          force: true,
          forget: true,
          projectCommands: "permitted",
        })
        .pipe(Effect.ignoreCause({ log: true }));
      return;
    }
    yield* git
      .removeWorktree({ cwd: workspaceRoot, path: created.path, force: true })
      .pipe(Effect.ignoreCause({ log: true }));
  });

  const move: ThreadProjectMove["Service"]["move"] = Effect.fn("ThreadProjectMove.move")(
    function* (input) {
      const workspace = input.workspace ?? DEFAULT_WORKSPACE;
      const target: MoveTarget = { threadId: input.threadId, projectId: input.projectId };

      const thread = yield* threads.getThreadShell(input.threadId).pipe(
        Effect.mapError(readFailure(target, "Could not read the thread.")),
        Effect.filterOrFail(
          (shell): shell is OrchestrationV2ThreadShell => shell !== null,
          () => fail(target, "Thread not found."),
        ),
      );
      const records = yield* threads
        .getThreadRecords(input.threadId, ["runs", "runtimeRequests"], { turnItemTypes: [] })
        .pipe(Effect.mapError(readFailure(target, "Could not read the thread.")));
      if (records.thread.deletedAt !== null) {
        return yield* fail(target, "Thread not found.");
      }
      if (threadHasUnfinishedWork(records)) {
        return yield* fail(target, "This thread is still working. Finish or stop it first.");
      }

      const destination = Option.getOrUndefined(
        yield* projects
          .getById(input.projectId, { includeDeleted: true })
          .pipe(Effect.mapError(readFailure(target, "Could not read that project."))),
      );
      if (destination === undefined || destination.deletedAt !== null) {
        return yield* fail(target, "That project no longer exists.");
      }
      const current = Option.getOrUndefined(
        yield* projects.getById(thread.projectId).pipe(Effect.orElseSucceed(() => Option.none())),
      );
      const currentCwd = thread.worktreePath ?? current?.workspaceRoot ?? null;

      let created: CreatedWorktree | null = null;
      switch (workspace) {
        case "keep": {
          if (
            thread.worktreePath !== null &&
            input.acceptOutOfTree !== true &&
            !isWithinRoot(path, thread.worktreePath, destination.workspaceRoot)
          ) {
            return yield* fail(
              target,
              "This thread's folder is outside that project. Choose the project folder or a new worktree, or accept keeping it outside.",
            );
          }
          break;
        }
        case "project-root": {
          if (currentCwd !== null && !isWithinRoot(path, currentCwd, destination.workspaceRoot)) {
            yield* refuseDirty(target, currentCwd);
          }
          break;
        }
        case "new-worktree": {
          if (currentCwd !== null) yield* refuseDirty(target, currentCwd);
          created = yield* createWorktree(target, destination.workspaceRoot);
          break;
        }
      }

      const worktreePath =
        created !== null ? created.path : workspace === "project-root" ? null : thread.worktreePath;
      const branch =
        created !== null ? created.branch : workspace === "project-root" ? null : thread.branch;
      const projectChanged = thread.projectId !== destination.id;

      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          // Move the tasks first: undoing that is a store update, while the thread's own move is
          // one event that cannot half-apply.
          const tasksMoved = projectChanged
            ? yield* scheduledTasks
                .moveThreadTasks({ threadIds: [thread.id], projectId: destination.id })
                .pipe(
                  Effect.as(true),
                  Effect.mapError(
                    readFailure(
                      target,
                      "Could not move this thread's scheduled tasks. Nothing was changed.",
                    ),
                  ),
                  Effect.catch((error) =>
                    Effect.gen(function* () {
                      if (created !== null) {
                        yield* removeWorktree(created, destination.workspaceRoot);
                      }
                      return yield* error;
                    }),
                  ),
                )
            : false;

          yield* threads
            .dispatch({
              type: "thread.project.adopt-folder",
              commandId: CommandId.make(`thread-project-move:${yield* random.uuidV4()}`),
              threadId: thread.id,
              projectId: destination.id,
              worktreePath,
              branch,
              ...(workspace === "keep" ? { allowOutsideWorkspace: true } : {}),
            })
            .pipe(
              Effect.mapError(
                readFailure(target, "Could not move the thread. Nothing was changed."),
              ),
              Effect.catch((error) =>
                Effect.gen(function* () {
                  if (tasksMoved) {
                    yield* scheduledTasks
                      .moveThreadTasks({
                        threadIds: [thread.id],
                        projectId: thread.projectId,
                      })
                      .pipe(Effect.ignoreCause({ log: true }));
                  }
                  if (created !== null) {
                    yield* removeWorktree(created, destination.workspaceRoot);
                  }
                  return yield* error;
                }),
              ),
            );

          return {
            projectId: destination.id,
            workspace,
            worktreePath,
            branch,
          } satisfies ThreadMoveToProjectResult;
        }),
      );
    },
  );

  return ThreadProjectMove.of({ move });
});

export const layer = Layer.effect(ThreadProjectMove, make);
