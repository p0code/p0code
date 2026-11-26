import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettingsService from "../../../serverSettings.ts";
import * as PublicTunnels from "../../../tunnels/PublicTunnels.ts";
import * as ProjectCostService from "../../../usage/ProjectCostService.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const P0_CODE_TOOL = "p0_code";

const P0CodeTool = Tool.make(P0_CODE_TOOL, {
  description:
    'Use p0code itself by running a short async JS snippet against a `p0` object: read provider account usage limits and quota, token spend and cost per chat, project and model; publish a dev server, file or folder at a public URL (the user approves unless they allowed it). Filter and total in code. Get the API first: `tool_search` query "p0", or `return await p0.help()`.',
  parameters: Schema.Struct({
    code: Schema.String.check(Schema.isMaxLength(8_000)).annotate({
      description: "Async function body using `p0`. `return` the answer (JSON).",
    }),
  }),
  success: Schema.Struct({
    result: Schema.Unknown,
    logs: Schema.optionalKey(Schema.Array(Schema.String)),
    logsDropped: Schema.optionalKey(Schema.Int),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ServerEnvironment.ServerEnvironment,
    ProviderRegistry.ProviderRegistry,
    UsageLimitSources.UsageLimitSources,
    ThreadManagementService.ThreadManagementService,
    ProjectCostService.ProjectCostService,
    ServerSettingsService.ServerSettingsService,
    PublicTunnels.PublicTunnels,
  ],
})
  // p0.tunnels can publish; its write methods check the caller per call.
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const P0CodeToolkit = Toolkit.make(P0CodeTool);
