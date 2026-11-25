import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolExposure from "../../McpToolExposure.ts";
import { declarationsFor } from "../p0Code/api.ts";
import { P0_NAMESPACES } from "../p0Code/namespaces.ts";
import { P0_CODE_TOOL } from "../p0Code/tools.ts";
import { ToolSearchToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ToolSearchToolkit, {
  tool_search: McpToolAccess.readsAsCaller(({ query }) =>
    Effect.gen(function* () {
      const { thread } = yield* McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "tool_search")),
      );
      const exposure = yield* McpToolExposure.McpToolExposure;
      const tools = yield* exposure.search(thread.providerSessionId, query);
      const api = declarationsFor(P0_NAMESPACES, query);
      if (api === undefined) return { tools };
      // The declarations are for p0_code, so a deferring client must be able to list it too.
      const code = tools.some((tool) => tool.name === P0_CODE_TOOL)
        ? []
        : yield* exposure.search(thread.providerSessionId, P0_CODE_TOOL);
      return { tools: [...tools, ...code], api };
    }),
  ),
});
