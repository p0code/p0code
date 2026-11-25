import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolExposure from "../../McpToolExposure.ts";

const ToolSearchTool = Tool.make(McpToolExposure.TOOL_SEARCH, {
  description:
    "Load p0code tools you do not have yet, then call them by name. Search by name or purpose: threads (t3_thread_*), projects (t3_project_*), worktrees, preview_* browser, device_*, html_preview/html_render, schedule_task, pull requests and guides, attachments, request_secret, environment links. Exact names work too. Asking about usage limits, quota, spend, or cost also returns the `p0` API declarations that `p0_code` runs scripts against.",
  parameters: Schema.Struct({ query: Schema.String.check(Schema.isMaxLength(500)) }),
  success: Schema.Struct({
    tools: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
    api: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "TypeScript declarations of the `p0` namespaces the query matched, for `p0_code`.",
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, McpToolExposure.McpToolExposure],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const ToolSearchToolkit = Toolkit.make(ToolSearchTool);
