import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PluginId } from "./plugins.ts";

/**
 * Deploys run through plugins that declare `deploy:provider`. The host owns the UI, the
 * project mapping, and approvals; the provider plugin owns its account credentials (kept in its
 * own `PluginContext.storage`) and every call to the provider's API. Nothing here carries a
 * stored token: a token only travels inward, once, in `DeployLinkInput`.
 */

export const DeployEnvironment = Schema.Literals(["preview", "production"]);
export type DeployEnvironment = typeof DeployEnvironment.Type;

export const DeployEnvVars = Schema.Record(Schema.String, Schema.String);
export type DeployEnvVars = typeof DeployEnvVars.Type;

// ── What a provider plugin implements ──────────────────────────────────────────────────────────

/** A token typed into Settings, or nothing to start (or finish) the provider's own sign-in. */
export const DeployLinkInput = Schema.Struct({ token: Schema.optionalKey(Schema.String) });
export type DeployLinkInput = typeof DeployLinkInput.Type;

/** Linked now, or waiting for the person to finish signing in at `authorizeUrl`. */
export const DeployLinkResult = Schema.Union([
  Schema.TaggedStruct("linked", { accountLabel: TrimmedNonEmptyString }),
  Schema.TaggedStruct("pending", { authorizeUrl: TrimmedNonEmptyString }),
]);
export type DeployLinkResult = typeof DeployLinkResult.Type;

export const DeployLinkState = Schema.Literals(["unlinked", "linked", "expired", "error"]);
export type DeployLinkState = typeof DeployLinkState.Type;

export const DeployProviderStatus = Schema.Struct({
  state: DeployLinkState,
  accountLabel: Schema.NullOr(Schema.String),
  /** The provider's own line about the account, e.g. why it is in error. */
  message: Schema.NullOr(Schema.String),
});
export type DeployProviderStatus = typeof DeployProviderStatus.Type;

export const DeployProviderProject = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  url: Schema.optionalKey(Schema.String),
});
export type DeployProviderProject = typeof DeployProviderProject.Type;

export const DeploySource = Schema.Struct({
  kind: Schema.Literals(["local-build", "git"]),
  branch: Schema.optionalKey(TrimmedNonEmptyString),
  /** A directory inside the project to deploy from. */
  directory: Schema.optionalKey(TrimmedNonEmptyString),
  /** Build-time variables. */
  env: Schema.optionalKey(DeployEnvVars),
});
export type DeploySource = typeof DeploySource.Type;

export const DeployProviderDeployInput = Schema.Struct({
  /** The provider's project id, from `listProjects`. */
  projectId: TrimmedNonEmptyString,
  source: DeploySource,
  environment: DeployEnvironment,
  /** Runtime variables for this deployment. */
  envVars: Schema.optionalKey(DeployEnvVars),
});
export type DeployProviderDeployInput = typeof DeployProviderDeployInput.Type;

export const DeployResult = Schema.Struct({
  deploymentId: TrimmedNonEmptyString,
  url: Schema.optionalKey(Schema.String),
});
export type DeployResult = typeof DeployResult.Type;

export const DeploymentState = Schema.Literals([
  "queued",
  "building",
  "ready",
  "error",
  "canceled",
]);
export type DeploymentState = typeof DeploymentState.Type;

export const isFinalDeploymentState = (state: DeploymentState): boolean =>
  state === "ready" || state === "error" || state === "canceled";

export const DeploymentStatus = Schema.Struct({
  deploymentId: TrimmedNonEmptyString,
  state: DeploymentState,
  url: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});
export type DeploymentStatus = typeof DeploymentStatus.Type;

export const DeployRollbackInput = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  /** The deployment to restore; absent rolls back to the one before the current. */
  deploymentId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type DeployRollbackInput = typeof DeployRollbackInput.Type;

export const DeployDomain = Schema.Struct({
  name: TrimmedNonEmptyString,
  verified: Schema.optionalKey(Schema.Boolean),
});
export type DeployDomain = typeof DeployDomain.Type;

export const DeployLogsOptions = Schema.Struct({ follow: Schema.optionalKey(Schema.Boolean) });
export type DeployLogsOptions = typeof DeployLogsOptions.Type;

// ── Host state and RPCs ────────────────────────────────────────────────────────────────────────

/** Which provider project a local project deploys to; kept in server settings. */
export const DeployProjectMapping = Schema.Struct({
  pluginId: PluginId,
  providerProjectId: TrimmedNonEmptyString,
  providerProjectName: TrimmedNonEmptyString,
});
export type DeployProjectMapping = typeof DeployProjectMapping.Type;

export const DeployProviderSummary = Schema.Struct({
  pluginId: PluginId,
  label: TrimmedNonEmptyString,
  icon: Schema.NullOr(Schema.String),
  /** Off in Plugins, or failed to start: listed so the card can say so. */
  running: Schema.Boolean,
  status: DeployProviderStatus,
});
export type DeployProviderSummary = typeof DeployProviderSummary.Type;

export const DeployRecord = Schema.Struct({
  pluginId: PluginId,
  deploymentId: TrimmedNonEmptyString,
  projectId: ProjectId,
  environment: DeployEnvironment,
  branch: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  state: DeploymentState,
  createdAt: IsoDateTime,
});
export type DeployRecord = typeof DeployRecord.Type;

export const DeployApprovalId = TrimmedNonEmptyString;

export const DeployPendingApproval = Schema.Struct({
  id: DeployApprovalId,
  projectId: ProjectId,
  pluginId: PluginId,
  providerProjectName: Schema.String,
  environment: DeployEnvironment,
  branch: Schema.NullOr(Schema.String),
  threadId: ThreadId,
  requestedAt: IsoDateTime,
});
export type DeployPendingApproval = typeof DeployPendingApproval.Type;

export const DeployOverview = Schema.Struct({
  providers: Schema.Array(DeployProviderSummary),
  mappings: Schema.Record(ProjectId, DeployProjectMapping),
  /** Deployments started from this server since it started, newest first. */
  deployments: Schema.Array(DeployRecord),
  approvals: Schema.Array(DeployPendingApproval),
});
export type DeployOverview = typeof DeployOverview.Type;

export const DeployPluginInput = Schema.Struct({ pluginId: PluginId });
export type DeployPluginInput = typeof DeployPluginInput.Type;

export const DeployLinkRpcInput = Schema.Struct({
  pluginId: PluginId,
  token: Schema.optionalKey(Schema.String),
});
export type DeployLinkRpcInput = typeof DeployLinkRpcInput.Type;

export const DeployMapProjectInput = Schema.Struct({
  projectId: ProjectId,
  mapping: Schema.NullOr(DeployProjectMapping),
});
export type DeployMapProjectInput = typeof DeployMapProjectInput.Type;

export const DeployStartInput = Schema.Struct({
  projectId: ProjectId,
  environment: DeployEnvironment,
  sourceKind: Schema.Literals(["local-build", "git"]),
  branch: Schema.optionalKey(TrimmedNonEmptyString),
  directory: Schema.optionalKey(TrimmedNonEmptyString),
  envVars: Schema.optionalKey(DeployEnvVars),
  /** The thread asking. A thread below Full access gets an approval request instead. */
  threadId: Schema.optionalKey(ThreadId),
});
export type DeployStartInput = typeof DeployStartInput.Type;

export const DeployStartResult = Schema.Union([
  Schema.TaggedStruct("started", { deployment: DeployRecord }),
  Schema.TaggedStruct("approval-required", { approval: DeployPendingApproval }),
]);
export type DeployStartResult = typeof DeployStartResult.Type;

export const DeployDecideApprovalInput = Schema.Struct({
  approvalId: DeployApprovalId,
  approve: Schema.Boolean,
});
export type DeployDecideApprovalInput = typeof DeployDecideApprovalInput.Type;

export const DeployDeploymentInput = Schema.Struct({
  pluginId: PluginId,
  deploymentId: TrimmedNonEmptyString,
});
export type DeployDeploymentInput = typeof DeployDeploymentInput.Type;

export const DeployLogsInput = Schema.Struct({
  pluginId: PluginId,
  deploymentId: TrimmedNonEmptyString,
  follow: Schema.optionalKey(Schema.Boolean),
});
export type DeployLogsInput = typeof DeployLogsInput.Type;

export const DeployProjectInput = Schema.Struct({ projectId: ProjectId });
export type DeployProjectInput = typeof DeployProjectInput.Type;

export const DeployProjectRollbackInput = Schema.Struct({
  projectId: ProjectId,
  deploymentId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type DeployProjectRollbackInput = typeof DeployProjectRollbackInput.Type;

export const DeploySetEnvInput = Schema.Struct({ projectId: ProjectId, vars: DeployEnvVars });
export type DeploySetEnvInput = typeof DeploySetEnvInput.Type;

export const DeployErrorReason = Schema.Literals([
  "unknown-provider",
  "provider-off",
  "not-mapped",
  "unknown-approval",
  "provider-failed",
  "settings-failed",
]);
export type DeployErrorReason = typeof DeployErrorReason.Type;

export class DeployError extends Schema.TaggedError<DeployError>()("DeployError", {
  reason: DeployErrorReason,
  message: Schema.String,
}) {}
