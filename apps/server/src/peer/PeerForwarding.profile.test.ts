import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  EnvironmentId,
  OrchestratorMcpEnvironmentTarget,
  type OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { EnvironmentToolkit } from "../mcp/toolkits/environment/tools.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import { PullRequestsToolkit } from "../mcp/toolkits/pullRequests/tools.ts";
import { ThreadToolkit } from "../mcp/toolkits/thread/tools.ts";
import { WorktreeToolkit } from "../mcp/toolkits/worktree/tools.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
import { restrictProfileTo } from "./profile.testkit.ts";

// Enumerate the actual declarations so new tools in these families inherit this regression check.
const tools = [
  EnvironmentToolkit,
  OrchestratorToolkit,
  ProjectToolkit,
  PullRequestsToolkit,
  ThreadToolkit,
  WorktreeToolkit,
]
  .flatMap((toolkit) => Object.values(toolkit.tools))
  .filter((tool) => {
    const params: unknown = tool.parametersSchema;
    return (
      Predicate.hasProperty(params, "fields") &&
      Predicate.hasProperty(params.fields, "environmentId") &&
      params.fields.environmentId === OrchestratorMcpEnvironmentTarget
    );
  });

it.effect("all environment-taking MCP tool families refuse excluded targets before peer I/O", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const localId = EnvironmentId.make("local");
    const remoteId = EnvironmentId.make("remote");
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId: localId,
      requestNamespace: "client:profile-test",
      thread: undefined,
      client: { sessionId: "session", label: "Test", access: "full-access" },
      capabilities: new Set(["orchestration"]),
      issuedAt: 0,
    };
    const forwarder = yield* PeerForwarding.PeerForwarding.pipe(
      Effect.provide(
        PeerForwarding.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeCrypto.layer,
              Layer.mock(ThreadManagement.ThreadManagementService)({}),
              Layer.mock(PeerLinks.PeerLinks)({ enabled: Effect.succeed(true) }),
              Layer.mock(PeerMcpClient.PeerMcpClient)({
                call: (input) =>
                  Ref.update(calls, (seen) => [...seen, input.tool]).pipe(Effect.as({} as never)),
              }),
            ),
          ),
        ),
      ),
    );
    yield* restrictProfileTo(settings, localId);
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "schedule_task",
        "run_scheduled_task_now",
        "pull_request_read",
        "t3_worktree_list",
        "t3_environment_read",
        "t3_thread_search",
      ]),
    );
    for (const tool of tools) {
      expect(
        yield* forwarder.call(scope, tool, remoteId, {} as never).pipe(Effect.result),
        tool.name,
      ).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "OrchestratorMcpFailure",
          code: "invalid_request",
          message: expect.stringContaining("not allowed in the active profile"),
        },
      });
    }
    // The delegate follower's direct read/wait/interrupt methods use the same gate.
    const direct: ReadonlyArray<Effect.Effect<unknown, OrchestratorMcpFailure>> = [
      forwarder.readThread(scope, remoteId, {} as never),
      forwarder.waitForThread(scope, remoteId, {} as never),
      forwarder.interruptThread(scope, remoteId, {} as never),
    ];
    for (const call of direct)
      expect(yield* call.pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { code: "invalid_request" },
      });
    expect(yield* Ref.get(calls)).toEqual([]);
    yield* restrictProfileTo(settings, remoteId);
    yield* forwarder.call(scope, EnvironmentToolkit.tools.t3_environment_read, remoteId, {});
    expect(yield* Ref.get(calls)).toEqual(["t3_environment_read"]);
  }).pipe(Effect.provide(ServerSettings.layerTest())),
);
