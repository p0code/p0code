import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PositiveInt, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { secretSetting, TextGeneratorBaseUrl, TextGeneratorKind } from "./settings.ts";
import { SettingsSecretValue } from "./settingsSecretValue.ts";

/** Lower case, so each id maps to exactly one environment variable and secret slot. */
export const CustomModelProviderId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][a-z0-9-]*$/),
);
export type CustomModelProviderId = typeof CustomModelProviderId.Type;

/** USD per million tokens, the unit both OpenCode and Pi configs use. */
const UsdPerMillionTokens = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

export const CustomModelProviderModel = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.optional(TrimmedNonEmptyString),
  contextWindow: Schema.optional(PositiveInt),
  inputCost: Schema.optional(UsdPerMillionTokens),
  outputCost: Schema.optional(UsdPerMillionTokens),
});
export type CustomModelProviderModel = typeof CustomModelProviderModel.Type;

/** A model API an agent reaches through p0code's own config overlay; its key is kept apart. */
export const CustomModelProvider = Schema.Struct({
  id: CustomModelProviderId,
  name: TrimmedNonEmptyString,
  kind: TextGeneratorKind,
  baseUrl: TextGeneratorBaseUrl,
  models: Schema.Array(CustomModelProviderModel),
});
export type CustomModelProvider = typeof CustomModelProvider.Type;

/** Settings fields of a driver whose agent can take custom model providers. */
export const customModelProviderSettingsFields = {
  customProviders: Schema.Array(CustomModelProvider).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
  customProviderApiKeys: Schema.Record(CustomModelProviderId, SettingsSecretValue).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
    secretSetting,
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
};

/** The variable the agent process reads a custom provider's key from. */
export const customModelProviderApiKeyEnvName = (id: CustomModelProviderId): string =>
  `P0CODE_PROVIDER_${id.toUpperCase().replaceAll("-", "_")}_API_KEY`;

export const ListCustomProviderModelsInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  provider: Schema.Struct({
    id: CustomModelProviderId,
    kind: TextGeneratorKind,
    baseUrl: TextGeneratorBaseUrl,
  }),
  /** Typed in the form; the redaction marker or blank uses the key saved for the same base URL. */
  apiKey: TrimmedString,
  /** Also have a model answer a tiny prompt, which proves the key, endpoint, and model. */
  test: Schema.optional(Schema.Boolean),
  model: Schema.optional(TrimmedNonEmptyString),
});
export type ListCustomProviderModelsInput = typeof ListCustomProviderModelsInput.Type;

/** A provider the user configured in the agent's own files, which p0code shows but never edits. */
export const UserModelProvider = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.optional(TrimmedNonEmptyString),
  baseUrl: Schema.optional(TrimmedNonEmptyString),
  models: Schema.Array(TrimmedNonEmptyString),
  source: TrimmedNonEmptyString,
});
export type UserModelProvider = typeof UserModelProvider.Type;

export const ListUserModelProvidersInput = Schema.Struct({ instanceId: ProviderInstanceId });
export type ListUserModelProvidersInput = typeof ListUserModelProvidersInput.Type;

export const ListUserModelProvidersResult = Schema.Struct({
  providers: Schema.Array(UserModelProvider),
});
export type ListUserModelProvidersResult = typeof ListUserModelProvidersResult.Type;
