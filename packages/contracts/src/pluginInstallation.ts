import * as Schema from "effect/Schema";
import { PluginCapability, PluginId, PluginManifest, PluginsSnapshot } from "./plugins.ts";

export const PluginVersion = Schema.String.check(
  Schema.isPattern(/^(?!installed\.json$)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
);
export const PluginInstallSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local"), path: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("catalog"), id: PluginId }),
  Schema.Struct({ kind: Schema.Literal("github"), url: Schema.String }),
]);
export const PluginInstalledVersion = Schema.Struct({
  version: PluginVersion,
  source: PluginInstallSource,
  installedAt: Schema.String,
  bundleSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  consentedCapabilities: Schema.Array(PluginCapability),
  consented: Schema.Boolean,
});
export const PluginInstallRecord = Schema.Struct({
  id: PluginId,
  activeVersion: Schema.NullOr(PluginVersion),
  previousVersion: Schema.NullOr(PluginVersion),
  versions: Schema.Array(PluginInstalledVersion),
  stagedVersion: Schema.NullOr(PluginVersion),
  removedDataAt: Schema.NullOr(Schema.String),
});
export type PluginInstallRecord = typeof PluginInstallRecord.Type;
const PluginUpload = Schema.Struct({
  name: Schema.String,
  data: Schema.String.check(Schema.isMaxLength(45 * 1024 * 1024)),
});
export const PluginInstallInput = Schema.Struct({
  source: Schema.String,
  upload: Schema.optionalKey(PluginUpload),
});
export const PluginUpdateInput = Schema.Struct({
  id: PluginId,
  source: Schema.optionalKey(Schema.String),
  upload: Schema.optionalKey(PluginUpload),
});
export const PluginConsentInput = Schema.Struct({
  id: PluginId,
  version: PluginVersion,
  capabilities: Schema.Array(PluginCapability),
});
export const PluginRemoveInput = Schema.Struct({ id: PluginId, purgeData: Schema.Boolean });
export const PluginRollbackInput = Schema.Struct({ id: PluginId });
export const PluginInstallationResult = Schema.Struct({
  record: PluginInstallRecord,
  manifest: Schema.NullOr(PluginManifest),
  restartRequired: Schema.Boolean,
});
export const PluginsInstalledList = Schema.Struct({
  snapshot: PluginsSnapshot,
  installations: Schema.Array(PluginInstallRecord),
  stagedManifests: Schema.Array(PluginManifest),
});

export type PluginInstallationResult = typeof PluginInstallationResult.Type;
