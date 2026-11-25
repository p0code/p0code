import {
  customModelProviderSettingsFields,
  type ListCustomProviderModelsInput,
  type ListTextGeneratorModelsResult,
  type ListUserModelProvidersInput,
  type ListUserModelProvidersResult,
  AuthProvidersManageScope,
  type SettingsSecretValue,
  TextGeneratorError,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient } from "effect/http";

import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as ServerSettings from "../serverSettings.ts";
import { RpcCallerScopes } from "../auth/RpcCallerScopes.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import {
  TEXT_GENERATOR_DRIVERS,
  TextGeneratorRequestError,
} from "../textGeneration/textGeneratorDrivers.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";

/** Model APIs added to an agent's settings (OpenCode, Pi), checked before and after saving. */
export class CustomModelProviders extends Context.Service<
  CustomModelProviders,
  {
    /** Lists the endpoint's models and, with `test`, has one answer a tiny prompt. */
    readonly listModels: (
      input: ListCustomProviderModelsInput,
    ) => Effect.Effect<ListTextGeneratorModelsResult, TextGeneratorError>;
    readonly listUserProviders: (
      input: ListUserModelProvidersInput,
    ) => Effect.Effect<ListUserModelProvidersResult>;
  }
>()("p0/provider/CustomModelProviders") {}

const decodeCustomProviderSettings = Schema.decodeUnknownOption(
  Schema.Struct(customModelProviderSettingsFields),
);

const hostOf = (baseUrl: string) => {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "The model API";
  }
};

/** @public */
export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const http = yield* HttpClient.HttpClient;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  const savedProvider = Effect.fn("CustomModelProviders.savedProvider")(function* (
    input: ListCustomProviderModelsInput,
  ) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        () =>
          new TextGeneratorRequestError({ detail: "Couldn't read this environment's settings." }),
      ),
    );
    const saved = decodeCustomProviderSettings(
      settings.providerInstances[input.instanceId]?.config ?? {},
    ).pipe(Option.getOrUndefined);
    return {
      provider: saved?.customProviders.find((entry) => entry.id === input.provider.id),
      key: saved?.customProviderApiKeys[input.provider.id],
    };
  });

  const savedKey = (
    input: ListCustomProviderModelsInput,
    saved: {
      readonly provider: { readonly baseUrl: string } | undefined;
      readonly key: SettingsSecretValue | undefined;
    },
  ) => {
    // The saved key goes only to the endpoint it was saved for.
    if (saved.provider?.baseUrl !== input.provider.baseUrl || saved.key === undefined) {
      return Effect.succeed("");
    }
    return requireSettingsSecret(secrets, saved.key).pipe(
      Effect.mapError((cause) => new TextGeneratorRequestError({ detail: cause.message, cause })),
    );
  };

  // A saved endpoint keeps working with settings:write alone; a caller-named one is a manager's
  // call, so a narrow token cannot make the server probe arbitrary hosts.
  const requireProviderManager = (adHoc: boolean) =>
    adHoc
      ? Effect.serviceOption(RpcCallerScopes).pipe(
          Effect.flatMap((caller) =>
            Option.isNone(caller) || caller.value.scopes.includes(AuthProvidersManageScope)
              ? Effect.void
              : Effect.fail(
                  new TextGeneratorRequestError({
                    detail:
                      "Checking an unsaved model endpoint needs the providers:manage permission.",
                  }),
                ),
          ),
        )
      : Effect.void;

  const listModels = Effect.fn("CustomModelProviders.listModels")(
    function* (input: ListCustomProviderModelsInput) {
      const saved = yield* savedProvider(input);
      yield* requireProviderManager(saved.provider?.baseUrl !== input.provider.baseUrl);
      const typed = input.apiKey !== "" && input.apiKey !== SECRET_REDACTED;
      const connection = {
        baseUrl: input.provider.baseUrl,
        apiKey: typed ? input.apiKey : yield* savedKey(input, saved),
        label: hostOf(input.provider.baseUrl),
      };
      const driver = TEXT_GENERATOR_DRIVERS[input.provider.kind];
      // Some APIs list models without checking the key, so only a request proves it.
      if (input.test === true && input.model !== undefined) {
        yield* driver.generate(connection, input.model, "Reply with OK.");
        return { models: [], testedModel: input.model };
      }
      const models = yield* driver.listModels(connection);
      if (input.test !== true) return { models };
      const model = models[0]?.id;
      if (model === undefined) {
        return yield* new TextGeneratorRequestError({
          detail: `${connection.label} lists no models to test with.`,
        });
      }
      yield* driver.generate(connection, model, "Reply with OK.");
      return { models, testedModel: model };
    },
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.mapError((error) => new TextGeneratorError({ detail: error.detail })),
  );

  const listUserProviders = Effect.fn("CustomModelProviders.listUserProviders")(function* (
    input: ListUserModelProvidersInput,
  ) {
    const instance = yield* registry.getInstance(input.instanceId);
    const providers = yield* instance?.listUserModelProviders ?? Effect.succeed([]);
    return { providers };
  });

  return CustomModelProviders.of({ listModels, listUserProviders });
});

export const layer = Layer.effect(CustomModelProviders, make).pipe(
  Layer.provide([SecretResolverLayer.layer, FetchHttpClient.layer]),
);
