import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PluginId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/));
export type PluginId = typeof PluginId.Type;

/**
 * What a plugin may do, shown before enabling it. Host APIs that serve routes, let devices in, read
 * agent activity, or read usage refuse a plugin that did not declare them; outbound network and
 * helper processes are declarations only, since bundled plugins run in the server process.
 */
export const PluginCapability = Schema.Literals([
  "network:outbound",
  "process:spawn",
  "http:routes",
  "auth:issue-device-credentials",
  "orchestration:read-activity",
  "usage:read",
  "data:backup",
  "agent:instructions",
]);
export type PluginCapability = typeof PluginCapability.Type;

export const PluginManifest = Schema.Struct({
  id: PluginId,
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  /** Not built or endorsed by the service it talks to. */
  unofficial: Schema.Boolean,
  /** Hosts outside this machine the plugin sends data to. */
  externalServices: Schema.Array(TrimmedNonEmptyString),
  capabilities: Schema.Array(PluginCapability),
  /** Absolute paths the plugin answers while it runs, outside any session auth. */
  httpRoutes: Schema.Array(Schema.String.check(Schema.isPattern(/^\/api\/[a-z0-9/-]+$/))),
});
export type PluginManifest = typeof PluginManifest.Type;

export const PluginState = Schema.Literals(["disabled", "starting", "running", "failed"]);
export type PluginState = typeof PluginState.Type;

export const PluginInfo = Schema.Struct({
  manifest: PluginManifest,
  enabled: Schema.Boolean,
  state: PluginState,
  /** A plugin's own one-line status while it runs, or why it failed. */
  message: Schema.NullOr(Schema.String),
});
export type PluginInfo = typeof PluginInfo.Type;

export const PluginsSnapshot = Schema.Struct({ plugins: Schema.Array(PluginInfo) });
export type PluginsSnapshot = typeof PluginsSnapshot.Type;

export const PluginSetEnabledInput = Schema.Struct({ pluginId: PluginId, enabled: Schema.Boolean });
export type PluginSetEnabledInput = typeof PluginSetEnabledInput.Type;

/** A plugin's settings panel calls the actions its plugin declares; each decodes its own input. */
export const PluginInvokeInput = Schema.Struct({
  pluginId: PluginId,
  action: TrimmedNonEmptyString,
  input: Schema.Unknown,
});
export type PluginInvokeInput = typeof PluginInvokeInput.Type;

export class PluginOperationError extends Schema.TaggedError<PluginOperationError>()(
  "PluginOperationError",
  { pluginId: Schema.String, message: Schema.String },
) {}

export const PluginSettings = Schema.Record(
  Schema.String,
  Schema.Struct({ enabled: Schema.Boolean }),
);
export type PluginSettings = typeof PluginSettings.Type;

export const DataSnapshotManifest = Schema.Struct({
  format: Schema.Literal(1),
  createdAt: Schema.String,
  environmentId: Schema.String,
  appVersion: Schema.String,
  migrationHead: Schema.Number,
  sourceBaseDir: Schema.optionalKey(Schema.String),
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, bytes: Schema.Number, sha256: Schema.String }),
  ),
});
export type DataSnapshotManifest = typeof DataSnapshotManifest.Type;

export const PendingRestore = Schema.Struct({
  id: Schema.String,
  stagedAt: Schema.String,
  snapshotCreatedAt: Schema.String,
  sourceEnvironmentId: Schema.String,
  files: Schema.Number,
  bytes: Schema.Number,
});
export type PendingRestore = typeof PendingRestore.Type;

export class DataRestoreError extends Schema.TaggedError<DataRestoreError>()("DataRestoreError", {
  message: Schema.String,
}) {}
