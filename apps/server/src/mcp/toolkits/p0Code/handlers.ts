import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { assertNotLinked } from "../../linkOrigin.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertLiveCaller, loadCaller, readCaller, unavailable } from "../../threadAccess.ts";
import { P0ApiError, declarationsFor, findMethod, methodPaths } from "./api.ts";
import { P0_NAMESPACES, type P0Services } from "./namespaces.ts";
import { runSandbox, type SandboxError } from "./sandbox.ts";
import { P0CodeToolkit } from "./tools.ts";

const HELP = "help";
const MAX_FAILURE_LOG_CHARS = 1_000;

const decodeResult = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * What `McpToolAccess.actsAsCaller` checks, per call: the tool as a whole only reads, so a
 * snippet that only reads still works from a read-only client.
 */
const assertMayWrite = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.client?.access === "read-only") {
    return yield* new P0ApiError({
      detail: "This MCP client was approved for read-only access, so it cannot change anything.",
    });
  }
  const caller = yield* loadCaller();
  yield* assertLiveCaller(caller);
  yield* assertNotLinked(caller, "publish from this environment");
}).pipe(
  Effect.catchTags({
    OrchestratorMcpFailure: (error) => Effect.fail(new P0ApiError({ detail: error.message })),
  }),
);

const call = (path: string, options: unknown): Effect.Effect<unknown, P0ApiError, P0Services> => {
  if (path === HELP) {
    return Effect.succeed(
      declarationsFor(P0_NAMESPACES, typeof options === "string" ? options : "") ??
        `No p0 API matches. Namespaces: ${P0_NAMESPACES.map(({ name }) => name).join(", ")}.`,
    );
  }
  const found = findMethod(P0_NAMESPACES, path);
  return found === undefined
    ? Effect.fail(new P0ApiError({ detail: `p0.${path} does not exist. Try p0.help().` }))
    : found.access === "write"
      ? assertMayWrite.pipe(Effect.andThen(found.run(options)))
      : found.run(options);
};

const failure = (error: SandboxError) =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message:
      error.logs.length === 0
        ? error.detail
        : `${error.detail}\nconsole:\n${error.logs.join("\n").slice(0, MAX_FAILURE_LOG_CHARS)}`,
  });

export const layer = McpToolAccess.toLayer(P0CodeToolkit, {
  // Reads cost across every thread and project, as the orchestration-read RPCs do, so it needs
  // the same orchestration capability that thread listing does.
  p0_code: McpToolAccess.readsAsCaller(({ code }) =>
    Effect.gen(function* () {
      yield* readCaller();
      const output = yield* runSandbox({
        code,
        paths: [...methodPaths(P0_NAMESPACES), HELP],
        call,
      }).pipe(Effect.mapError(failure));
      return {
        result: yield* decodeResult(output.json).pipe(Effect.mapError(unavailable)),
        ...(output.logs.length === 0 ? {} : { logs: output.logs }),
        ...(output.logsDropped === 0 ? {} : { logsDropped: output.logsDropped }),
      };
    }),
  ),
});
