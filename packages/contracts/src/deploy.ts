import * as Schema from "effect/Schema";

import { AccountProfileId } from "./accountProfile.ts";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PluginId } from "./plugins.ts";

/**
 * Deploys run through built-in deploy providers (such as Vercel and Cloudflare) or third-party
 * `deploy:provider` plugins. The host owns account names, profiles, mappings, history and
 * approvals; credentials stay in the host's secret store keyed by provider and `accountId`.
 * Tokens only travel inward once in `DeployLinkInput` and are never stored or returned here.
 */

/** Where a deployment goes. */
export const DeployEnvironment = Schema.Literals(["preview", "production"]);
export type DeployEnvironment = typeof DeployEnvironment.Type;

/** How deployment artifacts are supplied to a provider. */
export const DeploySourceKind = Schema.Literals(["local-build", "git"]);
export type DeploySourceKind = typeof DeploySourceKind.Type;

/** Where a deploy provider comes from. */
export const DeployProviderOrigin = Schema.Literals(["builtin", "plugin"]);
export type DeployProviderOrigin = typeof DeployProviderOrigin.Type;

/** Operations a deploy provider can advertise support for. */
export const DeployProviderOperation = Schema.Literals([
  "link",
  "unlink",
  "status",
  "list-projects",
  "deploy",
  "deployment-status",
  "logs",
  "rollback",
  "list-domains",
  "set-env",
]);
export type DeployProviderOperation = typeof DeployProviderOperation.Type;

export const ALL_DEPLOY_PROVIDER_OPERATIONS: ReadonlyArray<DeployProviderOperation> = [
  "link",
  "unlink",
  "status",
  "list-projects",
  "deploy",
  "deployment-status",
  "logs",
  "rollback",
  "list-domains",
  "set-env",
];

/** Which environment a variable applies to; `development` is never deployed to. */
export const DeployEnvTarget = Schema.Literals(["production", "preview", "development"]);
export type DeployEnvTarget = typeof DeployEnvTarget.Type;

export const DeployEnvVars = Schema.Record(Schema.String, Schema.String);
export type DeployEnvVars = typeof DeployEnvVars.Type;

/** What a provider project is, so nothing has to guess from an id prefix. */
export const DeployTargetKind = Schema.Literals(["pages", "worker", "vercel-project"]);
export type DeployTargetKind = typeof DeployTargetKind.Type;

/** One linked account of a provider, made by the host when someone links it. */
export const DeployAccountId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type DeployAccountId = typeof DeployAccountId.Type;

/** Something worth showing that does not stop the account working, e.g. a missing scope. */
export const DeployWarning = Schema.Struct({
  code: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type DeployWarning = typeof DeployWarning.Type;

// ── What a provider plugin implements ──────────────────────────────────────────────────────────

/**
 * The account a call is for. The plugin keys its stored credential by `accountId`; `teamId` is
 * the provider's team or account id when the person gave one (or the link result named one).
 */
export const DeployAccountRef = Schema.Struct({
  accountId: DeployAccountId,
  teamId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type DeployAccountRef = typeof DeployAccountRef.Type;

/** A token typed into Settings, or nothing to start (or finish) the provider's own sign-in. */
export const DeployLinkInput = Schema.Struct({
  account: DeployAccountRef,
  token: Schema.optionalKey(Schema.String),
});
export type DeployLinkInput = typeof DeployLinkInput.Type;

/** Linked now, or waiting for the person to finish signing in at `authorizeUrl`. */
export const DeployLinkResult = Schema.Union([
  Schema.TaggedStruct("linked", {
    accountLabel: TrimmedNonEmptyString,
    /** The team or account id the credential belongs to, when the provider found one. */
    teamId: Schema.optionalKey(TrimmedNonEmptyString),
    warnings: Schema.optionalKey(Schema.Array(DeployWarning)),
  }),
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
  warnings: Schema.optionalKey(Schema.Array(DeployWarning)),
});
export type DeployProviderStatus = typeof DeployProviderStatus.Type;

export const DeployProviderProject = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  kind: DeployTargetKind,
  url: Schema.optionalKey(Schema.String),
});
export type DeployProviderProject = typeof DeployProviderProject.Type;

/** A provider project, as the host mapped it. */
export const DeployTarget = Schema.Struct({ kind: DeployTargetKind, id: TrimmedNonEmptyString });
export type DeployTarget = typeof DeployTarget.Type;

export const DeploySource = Schema.Struct({
  kind: DeploySourceKind,
  branch: Schema.optionalKey(TrimmedNonEmptyString),
  /** Absolute: the project's (or the thread's worktree's) root on this machine. */
  projectRoot: Schema.optionalKey(TrimmedNonEmptyString),
  /** Absolute: where to build or upload from; the root, or a folder inside it. */
  directory: Schema.optionalKey(TrimmedNonEmptyString),
  /** Build-time variables. */
  env: Schema.optionalKey(DeployEnvVars),
});
export type DeploySource = typeof DeploySource.Type;

export const DeployProviderDeployInput = Schema.Struct({
  account: DeployAccountRef,
  target: DeployTarget,
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

export const DeployDeploymentRequest = Schema.Struct({
  account: DeployAccountRef,
  deploymentId: TrimmedNonEmptyString,
});
export type DeployDeploymentRequest = typeof DeployDeploymentRequest.Type;

export const DeployLogsRequest = Schema.Struct({
  account: DeployAccountRef,
  deploymentId: TrimmedNonEmptyString,
  follow: Schema.optionalKey(Schema.Boolean),
});
export type DeployLogsRequest = typeof DeployLogsRequest.Type;

export const DeployTargetRequest = Schema.Struct({
  account: DeployAccountRef,
  target: DeployTarget,
});
export type DeployTargetRequest = typeof DeployTargetRequest.Type;

export const DeployRollbackInput = Schema.Struct({
  account: DeployAccountRef,
  target: DeployTarget,
  /** The deployment to restore; absent rolls back to the one before the current. */
  deploymentId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type DeployRollbackInput = typeof DeployRollbackInput.Type;

/** Sets `vars` and deletes `remove` for one environment of a target. */
export const DeployProviderSetEnvInput = Schema.Struct({
  account: DeployAccountRef,
  target: DeployTarget,
  environment: DeployEnvTarget,
  vars: DeployEnvVars,
  /** Store the values as secrets (write-only on the provider) instead of plain text. */
  secret: Schema.Boolean,
  remove: Schema.Array(TrimmedNonEmptyString),
});
export type DeployProviderSetEnvInput = typeof DeployProviderSetEnvInput.Type;

export const DeployDomain = Schema.Struct({
  name: TrimmedNonEmptyString,
  verified: Schema.optionalKey(Schema.Boolean),
});
export type DeployDomain = typeof DeployDomain.Type;

// ── Host state and RPCs ────────────────────────────────────────────────────────────────────────

/** A linked account as the host keeps it: names and profiles, never a credential. */
export const DeployAccount = Schema.Struct({
  id: DeployAccountId,
  pluginId: PluginId,
  /** The person's name for it, e.g. "Business-A"; null shows the provider's own label. */
  label: Schema.NullOr(TrimmedNonEmptyString),
  teamId: Schema.NullOr(TrimmedNonEmptyString),
  /** The account profiles it shows in; empty shows it in every profile. */
  profileIds: Schema.Array(AccountProfileId),
  createdAt: IsoDateTime,
});
export type DeployAccount = typeof DeployAccount.Type;

export const DeployAccountSummary = Schema.Struct({
  ...DeployAccount.fields,
  status: DeployProviderStatus,
});
export type DeployAccountSummary = typeof DeployAccountSummary.Type;

/** Where a local project deploys: one target of one linked account. */
export const DeployMappingTarget = Schema.Struct({
  accountId: DeployAccountId,
  targetKind: DeployTargetKind,
  targetId: TrimmedNonEmptyString,
  targetName: TrimmedNonEmptyString,
  defaultEnvironment: DeployEnvironment,
  /** A folder inside the project to deploy from, relative to its root. */
  directory: Schema.optionalKey(TrimmedNonEmptyString),
});
export type DeployMappingTarget = typeof DeployMappingTarget.Type;

export const DeployProjectMapping = Schema.Struct({
  projectId: ProjectId,
  ...DeployMappingTarget.fields,
});
export type DeployProjectMapping = typeof DeployProjectMapping.Type;

export const DeployProviderSummary = Schema.Struct({
  pluginId: PluginId,
  label: TrimmedNonEmptyString,
  icon: Schema.NullOr(Schema.String),
  /** Always true for built-in providers; for plugins, false when off in Plugins or failed to start. */
  running: Schema.Boolean,
  /** Whether this provider ships built into p0code or comes from an installed/bundled plugin. */
  origin: Schema.optionalKey(DeployProviderOrigin),
  /** Provider version (built-in package version or plugin manifest version). */
  version: Schema.optionalKey(TrimmedNonEmptyString),
  /** Short description shown in Settings → Deploy. */
  description: Schema.optionalKey(TrimmedNonEmptyString),
  /** Operations the provider supports. */
  supportedOperations: Schema.optionalKey(Schema.Array(DeployProviderOperation)),
  /** Target kinds this provider can deploy to (e.g. `vercel-project`, `pages`, `worker`). */
  supportedTargetKinds: Schema.optionalKey(Schema.Array(DeployTargetKind)),
  /** Source kinds this provider accepts (e.g. `git`, `local-build`). */
  supportedSourceKinds: Schema.optionalKey(Schema.Array(DeploySourceKind)),
});
export type DeployProviderSummary = typeof DeployProviderSummary.Type;

export const DeployRecord = Schema.Struct({
  pluginId: PluginId,
  accountId: DeployAccountId,
  deploymentId: TrimmedNonEmptyString,
  projectId: ProjectId,
  /** The thread that shipped it, when one asked. */
  threadId: Schema.NullOr(ThreadId),
  targetKind: DeployTargetKind,
  targetName: Schema.String,
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
  accountId: DeployAccountId,
  targetName: Schema.String,
  environment: DeployEnvironment,
  branch: Schema.NullOr(Schema.String),
  /** The folder it would deploy from, so the person sees what an agent asked for. */
  directory: Schema.NullOr(Schema.String),
  threadId: ThreadId,
  requestedAt: IsoDateTime,
});
export type DeployPendingApproval = typeof DeployPendingApproval.Type;

/** Everything the active account profile can see; other profiles' accounts are left out. */
export const DeployOverview = Schema.Struct({
  activeProfileId: Schema.NullOr(AccountProfileId),
  providers: Schema.Array(DeployProviderSummary),
  accounts: Schema.Array(DeployAccountSummary),
  mappings: Schema.Record(ProjectId, DeployProjectMapping),
  /** Recent deployments, newest first, kept across restarts and capped per project. */
  deployments: Schema.Array(DeployRecord),
  approvals: Schema.Array(DeployPendingApproval),
});
export type DeployOverview = typeof DeployOverview.Type;

export const DeployAccountInput = Schema.Struct({ accountId: DeployAccountId });
export type DeployAccountInput = typeof DeployAccountInput.Type;

/** Links a new account, or relinks `accountId`. */
export const DeployLinkRpcInput = Schema.Struct({
  pluginId: PluginId,
  accountId: Schema.optionalKey(DeployAccountId),
  label: Schema.optionalKey(TrimmedNonEmptyString),
  teamId: Schema.optionalKey(TrimmedNonEmptyString),
  token: Schema.optionalKey(Schema.String),
  /** Absent puts a new account in the active profile (or every profile when none is active). */
  profileIds: Schema.optionalKey(Schema.Array(AccountProfileId)),
});
export type DeployLinkRpcInput = typeof DeployLinkRpcInput.Type;

export const DeployLinkRpcResult = Schema.Struct({
  accountId: DeployAccountId,
  result: DeployLinkResult,
});
export type DeployLinkRpcResult = typeof DeployLinkRpcResult.Type;

export const DeployUpdateAccountInput = Schema.Struct({
  accountId: DeployAccountId,
  label: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  profileIds: Schema.optionalKey(Schema.Array(AccountProfileId)),
});
export type DeployUpdateAccountInput = typeof DeployUpdateAccountInput.Type;

export const DeployMapProjectInput = Schema.Struct({
  projectId: ProjectId,
  mapping: Schema.NullOr(DeployMappingTarget),
});
export type DeployMapProjectInput = typeof DeployMapProjectInput.Type;

export const DeployStartInput = Schema.Struct({
  projectId: ProjectId,
  /** The account the deploy targets; it must be the one the project is mapped to. */
  accountId: DeployAccountId,
  /** Absent uses the mapping's default environment. */
  environment: Schema.optionalKey(DeployEnvironment),
  sourceKind: DeploySourceKind,
  branch: Schema.optionalKey(TrimmedNonEmptyString),
  /** Relative to the project root (or absolute inside it); absent uses the mapping's. */
  directory: Schema.optionalKey(TrimmedNonEmptyString),
  /** Lets `directory` point outside the project. */
  allowOutsideProject: Schema.optionalKey(Schema.Boolean),
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
  accountId: DeployAccountId,
  deploymentId: TrimmedNonEmptyString,
});
export type DeployDeploymentInput = typeof DeployDeploymentInput.Type;

export const DeployLogsInput = Schema.Struct({
  accountId: DeployAccountId,
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

export const DeploySetEnvInput = Schema.Struct({
  projectId: ProjectId,
  environment: DeployEnvTarget,
  vars: DeployEnvVars,
  secret: Schema.optionalKey(Schema.Boolean),
  remove: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
});
export type DeploySetEnvInput = typeof DeploySetEnvInput.Type;

export const DeployErrorReason = Schema.Literals([
  "unknown-provider",
  "provider-off",
  "unknown-account",
  "not-in-profile",
  "account-mismatch",
  "not-mapped",
  "unknown-project",
  "outside-project",
  "unknown-approval",
  "provider-failed",
  "storage-failed",
]);
export type DeployErrorReason = typeof DeployErrorReason.Type;

export class DeployError extends Schema.TaggedError<DeployError>()("DeployError", {
  reason: DeployErrorReason,
  message: Schema.String,
}) {}

/** Whether an account shows while `activeProfileId` is active; untagged accounts show in all. */
export const isDeployAccountInProfile = (
  account: Pick<DeployAccount, "profileIds">,
  activeProfileId: AccountProfileId | null,
): boolean =>
  activeProfileId === null ||
  account.profileIds.length === 0 ||
  account.profileIds.includes(activeProfileId);
