/**
 * Deploy providers that ship with p0code (Vercel, Cloudflare). They need no plugin consent, shop
 * entry or relay scope. Credentials live in the server secret store under the same names the
 * former `vercel` / `cloudflare` plugins used (`plugin-<id>-<key>`), so accounts linked through
 * those plugins keep working unchanged.
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

/** The secret name the former plugin of the same id used, so existing credentials still resolve. */
export const builtinSecretName = (providerId: string, key: string) => `plugin-${providerId}-${key}`;

const secretStorage = (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  providerId: string,
): DeployProviderStorage => {
  const failed = (message: string) => (cause: unknown) => new PluginError({ message, cause });
  return {
    get: (key) =>
      secrets
        .get(builtinSecretName(providerId, key))
        .pipe(
          Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
          Effect.mapError(failed("Could not read deploy credentials.")),
        ),
    set: (key, value) =>
      secrets
        .set(builtinSecretName(providerId, key), new TextEncoder().encode(value))
        .pipe(Effect.mapError(failed("Could not write deploy credentials."))),
    remove: (key) =>
      secrets
        .remove(builtinSecretName(providerId, key))
        .pipe(Effect.mapError(failed("Could not write deploy credentials."))),
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
