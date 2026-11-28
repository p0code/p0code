import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  ThreadMetadataMcpUpdateResult,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const sourceProjectId = ProjectId.make("project:source");
const targetProjectId = ProjectId.make("project:target");
const deletedProjectId = ProjectId.make("project:deleted");
const missingProjectId = ProjectId.make("project:missing");
const decodeUpdateResult = Schema.decodeUnknownEffect(ThreadMetadataMcpUpdateResult);

const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "thread-metadata-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "thread-metadata-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const outsideScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:test"),
  requestNamespace: "client:metadata-test",
  thread: undefined,
  client: {
    sessionId: "metadata-test",
    label: "Test client",
    access: "full-access",
    linked: false,
  },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const threadScope = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:test"),
  requestNamespace: `thread:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `session:${threadId}`,
    providerInstanceId: instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

interface TaskMoveCall {
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly projectId: ProjectId;
}

const makeHarness = () =>
  Effect.gen(function* () {
    const taskMoves = yield* Ref.make<ReadonlyArray<TaskMoveCall>>([]);
    const layerDatabase = SqlitePersistence.layerMemory;
    const layerOrchestrator = Layer.mergeAll(
      layerDatabase,
      ProjectStore.layer.pipe(Layer.provide(layerDatabase)),
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-metadata-mcp" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    );
    const layerOrchestration = ThreadManagement.layer.pipe(
      Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
      Layer.provideMerge(Layer.merge(layerOrchestrator, ServerSettings.layerTest())),
    );
    const layerTest = McpHttpServer.layerOrchestratorToolkit.pipe(
      Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
      Layer.provideMerge(layerOrchestration),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      ),
      Layer.provide(
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
      ),
      Layer.provide(
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          moveThreadTasks: (input) => Ref.update(taskMoves, (entries) => [...entries, input]),
        }),
      ),
      Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
      Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
      Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
      Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
      Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-metadata-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provide(NodeServices.layer),
    );
    return { layerTest, taskMoves };
  });

const seedProjects = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const createdAt = "2026-10-01T00:00:00.000Z";
  const baseEvent = {
    aggregateKind: "project" as const,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
  };
  let sequence = 1;
  for (const [id, title, workspaceRoot] of [
    [sourceProjectId, "Source", "/tmp/source-project"],
    [targetProjectId, "Target", "/tmp/target-project"],
    [deletedProjectId, "Deleted", "/tmp/deleted-project"],
  ] as const) {
    yield* projects.apply({
      ...baseEvent,
      sequence: sequence++,
      eventId: EventId.make(`event:create:${id}`),
      aggregateId: id,
      occurredAt: createdAt,
      type: "project.created",
      payload: {
        projectId: id,
        title,
        workspaceRoot,
        defaultModelSelection: null,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
      },
    });
  }
  const deletedAt = "2026-10-02T00:00:00.000Z";
  yield* projects.apply({
    ...baseEvent,
    sequence: sequence++,
    eventId: EventId.make(`event:delete:${deletedProjectId}`),
    aggregateId: deletedProjectId,
    occurredAt: deletedAt,
    type: "project.deleted",
    payload: {
      projectId: deletedProjectId,
      deletedAt,
    },
  });
});

const createThread = (input: {
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId;
  readonly title?: string;
  readonly worktreePath?: string | null;
  readonly branch?: string | null;
}) =>
  Orchestrator.OrchestratorV2.pipe(
    Effect.flatMap((orchestrator) =>
      orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`create:${input.threadId}`),
        threadId: input.threadId,
        projectId: input.projectId ?? sourceProjectId,
        title: input.title ?? "Movable thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        worktreePath:
          input.worktreePath === undefined ? "/tmp/worktrees/feature-x" : input.worktreePath,
        branch: input.branch === undefined ? "feat/feature-x" : input.branch,
      }),
    ),
  );

const callUpdate = (
  args: Record<string, unknown>,
  scope: McpInvocationContext.McpInvocationScope = outsideScope,
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: "t3_thread_update", arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const declaredFailure = (
  result: McpSchema.CallToolResult,
): { readonly code: string; readonly message: string } | undefined => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

describe("t3_thread_update move_project", () => {
  it.effect("moves an idle thread to another project, keeping worktree, branch, and history", () =>
    Effect.gen(function* () {
      const { layerTest, taskMoves } = yield* makeHarness();
      yield* Effect.gen(function* () {
        yield* seedProjects;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("thread:move-idle");
        yield* createThread({
          threadId,
          worktreePath: "/tmp/worktrees/feature-x",
          branch: "feat/feature-x",
        });

        // Add message history and settle the run so the thread is idle with history.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("msg:move-idle"),
          threadId,
          messageId: MessageId.make("msg:move-idle"),
          text: "Keep this conversation intact.",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "defer_start" },
        });
        const withRun = yield* orchestrator.getThreadProjection(threadId);
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("interrupt:move-idle"),
          threadId,
          runId: withRun.runs[0]!.id,
          reason: "settle before move",
        });
        const beforeSequence = yield* orchestrator.getThreadEventSequence(threadId);

        const response = yield* callUpdate({
          threadId,
          action: "move_project",
          projectId: targetProjectId,
          clientRequestId: "move-idle-1",
        });
        assert.equal(response.isError, false, JSON.stringify(response.content));
        const decoded = yield* decodeUpdateResult(response.structuredContent);
        assert.equal(decoded.threadId, threadId);
        assert.equal(decoded.projectId, targetProjectId);
        assert.equal(decoded.action, "move_project");

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(projection.thread.projectId, targetProjectId);
        assert.equal(projection.thread.worktreePath, "/tmp/worktrees/feature-x");
        assert.equal(projection.thread.branch, "feat/feature-x");
        assert.equal(projection.messages.length, 1);
        assert.equal(projection.messages[0]?.text, "Keep this conversation intact.");

        const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (candidate) => candidate.id === threadId,
        );
        assert.equal(shell?.projectId, targetProjectId);
        assert.equal(shell?.worktreePath, "/tmp/worktrees/feature-x");
        assert.equal(shell?.branch, "feat/feature-x");

        // Normal event stream reflects the move via thread.metadata-updated.
        const emitted = yield* orchestrator
          .streamStoredEventsFrom({ threadId, afterSequence: beforeSequence })
          .pipe(Stream.take(1), Stream.runCollect);
        const event = [...emitted][0]?.event;
        assert.equal(event?.type, "thread.metadata-updated");
        if (event?.type === "thread.metadata-updated") {
          assert.equal(event.payload.projectId, targetProjectId);
          assert.equal(event.payload.worktreePath, "/tmp/worktrees/feature-x");
          assert.equal(event.payload.branch, "feat/feature-x");
        }

        // Scheduled tasks bound to the thread also move to the target project.
        assert.deepEqual(yield* Ref.get(taskMoves), [
          { threadIds: [threadId], projectId: targetProjectId },
        ]);

        // Retrying with the same clientRequestId is idempotent.
        const retry = yield* callUpdate({
          threadId,
          action: "move_project",
          projectId: targetProjectId,
          clientRequestId: "move-idle-1",
        });
        assert.equal(retry.isError, false);
        const retried = yield* decodeUpdateResult(retry.structuredContent);
        assert.equal(retried.sequence, decoded.sequence);
        assert.equal(retried.projectId, targetProjectId);
      }).pipe(Effect.provide(layerTest));
    }),
  );

  it.effect("keeps null worktreePath and branch when moving a project-root thread", () =>
    Effect.gen(function* () {
      const { layerTest } = yield* makeHarness();
      yield* Effect.gen(function* () {
        yield* seedProjects;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("thread:move-root");
        yield* createThread({ threadId, worktreePath: null, branch: null });

        const response = yield* callUpdate({
          threadId,
          action: "move_project",
          projectId: targetProjectId,
        });
        assert.equal(response.isError, false, JSON.stringify(response.content));

        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.thread.projectId, targetProjectId);
        assert.isNull(after.thread.worktreePath);
        assert.isNull(after.thread.branch);
      }).pipe(Effect.provide(layerTest));
    }),
  );

  it.effect("refuses missing or deleted target projects without changing the thread", () =>
    Effect.gen(function* () {
      const { layerTest, taskMoves } = yield* makeHarness();
      yield* Effect.gen(function* () {
        yield* seedProjects;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("thread:move-bad-target");
        yield* createThread({ threadId });

        const missing = declaredFailure(
          yield* callUpdate({
            threadId,
            action: "move_project",
            projectId: missingProjectId,
          }),
        );
        assert.equal(missing?.code, "invalid_request");
        assert.match(missing?.message ?? "", /missing project/);

        const deleted = declaredFailure(
          yield* callUpdate({
            threadId,
            action: "move_project",
            projectId: deletedProjectId,
          }),
        );
        assert.equal(deleted?.code, "invalid_request");
        assert.match(deleted?.message ?? "", /missing project/);

        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.thread.projectId, sourceProjectId);
        assert.deepEqual(yield* Ref.get(taskMoves), []);
      }).pipe(Effect.provide(layerTest));
    }),
  );

  it.effect("refuses moving a thread that is running or has a queued pending turn", () =>
    Effect.gen(function* () {
      const { layerTest, taskMoves } = yield* makeHarness();
      yield* Effect.gen(function* () {
        yield* seedProjects;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const runningThreadId = ThreadId.make("thread:move-running");
        const queuedThreadId = ThreadId.make("thread:move-queued");
        const idleThreadId = ThreadId.make("thread:move-idle-by-agent");
        yield* createThread({ threadId: runningThreadId });
        yield* createThread({ threadId: queuedThreadId });
        yield* createThread({ threadId: idleThreadId });

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("msg:running"),
          threadId: runningThreadId,
          messageId: MessageId.make("msg:running"),
          text: "Running turn.",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("msg:queued"),
          threadId: queuedThreadId,
          messageId: MessageId.make("msg:queued"),
          text: "Queued turn.",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "defer_start" },
        });

        const runningFailure = declaredFailure(
          yield* callUpdate({
            threadId: runningThreadId,
            action: "move_project",
            projectId: targetProjectId,
          }),
        );
        assert.equal(runningFailure?.code, "invalid_request");
        assert.match(runningFailure?.message ?? "", /work in progress/);

        const selfFailure = declaredFailure(
          yield* callUpdate(
            {
              action: "move_project",
              projectId: targetProjectId,
            },
            threadScope(runningThreadId),
          ),
        );
        assert.equal(selfFailure?.code, "invalid_request");
        assert.match(selfFailure?.message ?? "", /work in progress/);

        const queuedFailure = declaredFailure(
          yield* callUpdate({
            threadId: queuedThreadId,
            action: "move_project",
            projectId: targetProjectId,
          }),
        );
        assert.equal(queuedFailure?.code, "invalid_request");
        assert.match(queuedFailure?.message ?? "", /work in progress/);

        assert.equal(
          (yield* orchestrator.getThreadProjection(runningThreadId)).thread.projectId,
          sourceProjectId,
        );
        assert.equal(
          (yield* orchestrator.getThreadProjection(queuedThreadId)).thread.projectId,
          sourceProjectId,
        );
        assert.deepEqual(yield* Ref.get(taskMoves), []);

        // A live agent thread can move another idle thread to a different project.
        const movedByAgent = yield* callUpdate(
          {
            threadId: idleThreadId,
            action: "move_project",
            projectId: targetProjectId,
          },
          threadScope(runningThreadId),
        );
        assert.equal(movedByAgent.isError, false, JSON.stringify(movedByAgent.content));
        assert.equal(
          (yield* orchestrator.getThreadProjection(idleThreadId)).thread.projectId,
          targetProjectId,
        );
      }).pipe(Effect.provide(layerTest));
    }),
  );
});
