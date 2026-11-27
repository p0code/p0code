/**
 * Built-in deploy providers (Vercel, Cloudflare). Secrets live under `deploy-builtin:<id>:<key>`,
 * isolated from `plugin-<id>-*`. Reads perform a one-time read-through copy from legacy plugin
 * secrets without deleting them, so already-linked accounts keep working across upgrades.
 */
import {
  type DeployProviderOperation,
  type DeploySourceKind,
  type DeployTargetKind,
} from "@t3tools/contracts";
import {
  CLOUDFLARE_PROVIDER_INFO,
  createCloudflareDeployProvider,
} from "@t3tools/deploy-cloudflare";
import { createVercelDeployProvider, VERCEL_PROVIDER_INFO } from "@t3tools/deploy-vercel";
import {
  type DeployProviderStorage,
  PluginError,
  type StartedDeployProvider,
} from "@t3tools/plugin-api";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export interface BuiltinDeployProviderInfo {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly version: string;
  readonly description: string;
  readonly supportedOperations: ReadonlyArray<DeployProviderOperation>;
  readonly supportedTargetKinds: ReadonlyArray<DeployTargetKind>;
  readonly supportedSourceKinds: ReadonlyArray<DeploySourceKind>;
}

export interface BuiltinDeployProvider {
  readonly info: BuiltinDeployProviderInfo;
  readonly provider: StartedDeployProvider;
}

export class BuiltinDeployProviders extends Context.Service<
  BuiltinDeployProviders,
  ReadonlyArray<BuiltinDeployProvider>
>()("p0/deploy/BuiltinDeployProviders") {}

/** Dedicated secret prefix for built-in deploy providers, isolated from `plugin-<id>-*`. */
export const BUILTIN_DEPLOY_SECRET_PREFIX = "deploy-builtin:";

/** Ids reserved by built-in deploy providers; installed plugins cannot claim them. */
export const BUILTIN_DEPLOY_PROVIDER_IDS: ReadonlyArray<string> = [
  VERCEL_PROVIDER_INFO.id,
  CLOUDFLARE_PROVIDER_INFO.id,
];

export const isBuiltinDeployProviderId = (id: string): boolean =>
  BUILTIN_DEPLOY_PROVIDER_IDS.includes(id);

/**
 * Secret name under the dedicated built-in prefix (`deploy-builtin:<id>:<key>`).
 * Uses `:` as delimiter so hyphenated plugin ids (e.g. `vercel-<uuidseg>`) cannot collide.
 */
export const builtinSecretName = (providerId: string, key: string) =>
  `${BUILTIN_DEPLOY_SECRET_PREFIX}${providerId}:${key}`;

/**
 * Legacy secret name written by the former `vercel` / `cloudflare` plugins (`plugin-<id>-<key>`).
 * Used only as a read-through fallback on `get` (and cleaned up on explicit `unlink`).
 */
export const legacyPluginSecretName = (providerId: string, key: string) =>
  `plugin-${providerId}-${key}`;

const secretStorage = (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  providerId: string,
): DeployProviderStorage => {
  const failed = (message: string) => (cause: unknown) => new PluginError({ message, cause });
  return {
    get: Effect.fn("BuiltinDeployProviders.storage.get")(function* (key: string) {
      const dedicated = builtinSecretName(providerId, key);
      const current = yield* secrets
        .get(dedicated)
        .pipe(Effect.mapError(failed("Could not read deploy credentials.")));
      if (Option.isSome(current)) {
        return Option.some(new TextDecoder().decode(current.value));
      }
      // One-time read-through migration from legacy `plugin-<id>-<key>`:
      // copy into `deploy-builtin:` and intentionally leave the legacy secret untouched.
      const legacy = yield* secrets
        .get(legacyPluginSecretName(providerId, key))
        .pipe(Effect.mapError(failed("Could not read deploy credentials.")));
      if (Option.isNone(legacy)) {
        return Option.none();
      }
      yield* secrets.set(dedicated, legacy.value).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not copy legacy deploy secret to built-in namespace", {
            providerId,
            cause,
          }),
        ),
      );
      return Option.some(new TextDecoder().decode(legacy.value));
    }),
    set: (key, value) =>
      secrets
        .set(builtinSecretName(providerId, key), new TextEncoder().encode(value))
        .pipe(Effect.mapError(failed("Could not write deploy credentials."))),
    remove: (key) =>
      secrets
        .remove(builtinSecretName(providerId, key))
        .pipe(
          Effect.andThen(secrets.remove(legacyPluginSecretName(providerId, key))),
          Effect.mapError(failed("Could not write deploy credentials.")),
        ),
  };
};

export const layer = Layer.effect(
  BuiltinDeployProviders,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const vercel = yield* createVercelDeployProvider({
      storage: secretStorage(secrets, VERCEL_PROVIDER_INFO.id),
    });
    const cloudflare = yield* createCloudflareDeployProvider({
      storage: secretStorage(secrets, CLOUDFLARE_PROVIDER_INFO.id),
    });
    return BuiltinDeployProviders.of([
      { info: VERCEL_PROVIDER_INFO, provider: vercel },
      { info: CLOUDFLARE_PROVIDER_INFO, provider: cloudflare },
    ]);
  }),
);
