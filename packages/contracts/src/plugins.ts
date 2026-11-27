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
  /** Exposes a `DeployProvider` the host lists in Settings → Deploy. */
  "deploy:provider",
]);
export type PluginCapability = typeof PluginCapability.Type;

/** Where a running plugin's code came from. */
export const PluginOrigin = Schema.Literals(["bundled", "installed"]);
export type PluginOrigin = typeof PluginOrigin.Type;

const PluginHttpRoutePath = Schema.String.check(Schema.isPattern(/^\/api\/[a-z0-9/-]+$/));

export const PluginHttpRouteAuth = Schema.Literals(["none", "session"]);
export type PluginHttpRouteAuth = typeof PluginHttpRouteAuth.Type;

export const PluginHttpRoute = Schema.Union([
  PluginHttpRoutePath,
  Schema.Struct({
    path: PluginHttpRoutePath,
    /** Defaults to `"session"` (authenticated owner session or per-plugin route secret). Set `"none"` only for self-authenticated public webhooks. */
    auth: Schema.optionalKey(PluginHttpRouteAuth),
  }),
]);
export type PluginHttpRoute = typeof PluginHttpRoute.Type;

export function pluginHttpRoutePath(route: PluginHttpRoute): string {
  return typeof route === "string" ? route : route.path;
}

export function pluginHttpRouteAuth(route: PluginHttpRoute): PluginHttpRouteAuth {
  return typeof route === "string" ? "session" : (route.auth ?? "session");
}

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
  /**
   * Absolute `/api/...` routes the plugin answers while it runs. String entries default to
   * `auth: "session"` (owner session with plugin management scope, or the host-issued per-plugin
   * route secret). Declare `{ path, auth: "none" }` only for routes authenticated by the handler
   * itself (for example, signed webhook proofs).
   */
  httpRoutes: Schema.Array(PluginHttpRoute),
  /**
   * The plugin API this manifest targets, as `PLUGIN_API_VERSION` from `@t3tools/plugin-api`.
   * Absent means the API the server ships; a higher one is refused with a note to update
   * p0code or the plugin. Written into a plugin's `manifest.json` file.
   */
  apiVersion: Schema.optionalKey(Schema.Int),
});
export type PluginManifest = typeof PluginManifest.Type;

export const PluginState = Schema.Literals(["disabled", "starting", "running", "failed"]);
export type PluginState = typeof PluginState.Type;

export const PluginInfo = Schema.Struct({
  manifest: PluginManifest,
  /** Bundled plugins update with the app; installed ones live in the server's plugin folder. */
  origin: PluginOrigin,
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
  Schema.Struct({
    enabled: Schema.Boolean,
    /**
     * Capabilities the person consented to for this plugin, recorded when it is installed or
     * updated. An installed version whose manifest declares more than this stays inactive; the
     * installer writes it, the loader only reads it to pick which installed version may run.
     */
    consentedCapabilities: Schema.optionalKey(Schema.Array(PluginCapability)),
  }),
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
