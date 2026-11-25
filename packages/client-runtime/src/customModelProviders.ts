import {
  CustomModelProvider,
  customModelProviderSettingsFields,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeSettings = Schema.decodeUnknownOption(Schema.Struct(customModelProviderSettingsFields));
const decodeProvider = Schema.decodeUnknownOption(CustomModelProvider);

type Config = Readonly<Record<string, unknown>>;

const asConfig = (config: unknown): Config =>
  config !== null && typeof config === "object" && !Array.isArray(config) ? (config as Config) : {};

export function readCustomModelProviders(config: unknown): {
  readonly providers: ReadonlyArray<CustomModelProvider>;
  readonly keys: Readonly<Record<string, SettingsSecretValue>>;
} {
  const settings = Option.getOrUndefined(decodeSettings(asConfig(config)));
  return {
    providers: settings?.customProviders ?? [],
    keys: settings?.customProviderApiKeys ?? {},
  };
}

/** A lower-case slug of the name that no other provider uses. */
export function suggestCustomProviderId(name: string, taken: ReadonlySet<string>): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 48);
  const base = slug || "provider";
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

export interface ModelDraft {
  readonly id: string;
  readonly name?: string | undefined;
  readonly contextWindow: string;
  readonly inputCost: string;
  readonly outputCost: string;
}

export interface ProviderDraft {
  readonly id: string;
  readonly name: string;
  readonly kind: CustomModelProvider["kind"];
  readonly baseUrl: string;
  readonly models: ReadonlyArray<ModelDraft>;
}

const optionalNumber = (value: string) => {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : Number(trimmed);
};

export function modelDraftOf(model: CustomModelProvider["models"][number]): ModelDraft {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow?.toString() ?? "",
    inputCost: model.inputCost?.toString() ?? "",
    outputCost: model.outputCost?.toString() ?? "",
  };
}

/** The provider the form describes, or none while a field is invalid. */
export function providerFromDraft(draft: ProviderDraft): CustomModelProvider | undefined {
  return Option.getOrUndefined(
    decodeProvider({
      id: draft.id.trim(),
      name: draft.name.trim(),
      kind: draft.kind,
      baseUrl: draft.baseUrl.trim().replace(/\/+$/, ""),
      models: draft.models.map((model) => {
        const contextWindow = optionalNumber(model.contextWindow);
        const inputCost = optionalNumber(model.inputCost);
        const outputCost = optionalNumber(model.outputCost);
        return {
          id: model.id,
          ...(model.name !== undefined && model.name !== model.id ? { name: model.name } : {}),
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(inputCost !== undefined ? { inputCost } : {}),
          ...(outputCost !== undefined ? { outputCost } : {}),
        };
      }),
    }),
  );
}

/**
 * The config with `provider` added or replaced. A blank key keeps the saved one, which clients
 * only ever see as the redaction marker.
 */
export function withCustomModelProvider(
  config: unknown,
  provider: CustomModelProvider,
  apiKey: string,
): Config {
  const current = asConfig(config);
  const { providers, keys } = readCustomModelProviders(current);
  const index = providers.findIndex((entry) => entry.id === provider.id);
  return {
    ...current,
    customProviders: index === -1 ? [...providers, provider] : providers.with(index, provider),
    customProviderApiKeys: apiKey.trim() === "" ? keys : { ...keys, [provider.id]: apiKey.trim() },
  };
}

/** Dropping the key's slot has the server delete the stored secret too. */
export function withoutCustomModelProvider(config: unknown, id: string): Config {
  const current = asConfig(config);
  const { providers, keys } = readCustomModelProviders(current);
  const { [id]: _removed, ...rest } = keys;
  return {
    ...current,
    customProviders: providers.filter((entry) => entry.id !== id),
    customProviderApiKeys: rest,
  };
}
