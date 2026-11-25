import {
  type CustomModelProvider,
  customModelProviderApiKeyEnvName,
  type ResolvedProviderInstanceEnvironment,
  type UserModelProvider,
} from "@t3tools/contracts";
import {
  customModelProviderOverlayPath,
  writeCustomModelProviderOverlay,
} from "@t3tools/provider-core/server/customModelProviders";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Names the extension that registers p0code's providers; every Pi launch loads it explicitly. */
export const PI_CUSTOM_PROVIDERS_EXTENSION_ENV = "P0CODE_PI_PROVIDERS_EXTENSION";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_OUTPUT_TOKENS = 16_384;
// Pi lists a provider's models only once it can resolve a key; keyless local servers ignore this.
const NO_KEY = "p0code-no-key";

/**
 * A Pi extension that registers only p0code's providers, leaving the user's models.json alone.
 * Keys stay `$VAR` references that Pi resolves at request time.
 */
function renderPiCustomProvidersExtension(
  providers: ReadonlyArray<CustomModelProvider>,
  keyed: ReadonlySet<string>,
): string {
  const registrations = Object.fromEntries(
    providers.map((provider) => [
      provider.id,
      {
        name: provider.name,
        // The Anthropic SDK adds /v1 itself; OpenCode and the model list keep it in the base URL.
        baseUrl:
          provider.kind === "anthropic"
            ? provider.baseUrl.replace(/\/v1\/?$/, "")
            : provider.baseUrl,
        api: provider.kind === "anthropic" ? "anthropic-messages" : "openai-completions",
        apiKey: keyed.has(provider.id)
          ? `$${customModelProviderApiKeyEnvName(provider.id)}`
          : NO_KEY,
        models: provider.models.map((model) => {
          const contextWindow = model.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
          return {
            id: model.id,
            name: model.name ?? model.id,
            reasoning: false,
            input: ["text"],
            cost: {
              input: model.inputCost ?? 0,
              output: model.outputCost ?? 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
            contextWindow,
            maxTokens: Math.min(DEFAULT_OUTPUT_TOKENS, contextWindow),
          };
        }),
      },
    ]),
  );
  return `// Written by p0code from Settings → Providers; edits here are replaced.
const PROVIDERS = ${JSON.stringify(registrations, null, 2)};

export default function p0codeCustomProviders(pi) {
  for (const [id, config] of Object.entries(PROVIDERS)) pi.registerProvider(id, config);
}
`;
}

/** Writes the extension and returns the variable that has every Pi launch load it. */
export const piCustomProvidersEnvironment = Effect.fn("PiCustomProviders.environment")(
  function* (input: {
    readonly providers: ReadonlyArray<CustomModelProvider>;
    readonly keyEnvironment: ResolvedProviderInstanceEnvironment;
    readonly stateDir: string;
    readonly instanceId: string;
  }) {
    if (input.providers.length === 0) return [] satisfies ResolvedProviderInstanceEnvironment;
    const keyNames = new Set(input.keyEnvironment.map((variable) => variable.name));
    const keyed = new Set(
      input.providers
        .filter((provider) => keyNames.has(customModelProviderApiKeyEnvName(provider.id)))
        .map((provider) => provider.id),
    );
    const pathService = yield* Path.Path;
    const path = customModelProviderOverlayPath(
      pathService,
      input.stateDir,
      `pi-${input.instanceId}.js`,
    );
    yield* writeCustomModelProviderOverlay(
      path,
      renderPiCustomProvidersExtension(input.providers, keyed),
    );
    return [{ name: PI_CUSTOM_PROVIDERS_EXTENSION_ENV, value: path, sensitive: false }];
  },
);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** The `providers` entries of Pi's models.json. */
export function parsePiUserModelProviders(
  contents: string,
  source: string,
): ReadonlyArray<UserModelProvider> {
  let config: unknown;
  try {
    config = JSON.parse(contents);
  } catch {
    return [];
  }
  const providers = isRecord(config) ? config.providers : undefined;
  if (!isRecord(providers)) return [];
  return Object.entries(providers).flatMap(([id, entry]) => {
    if (!isRecord(entry) || id.trim() === "") return [];
    const name = nonEmptyString(entry.name);
    const baseUrl = nonEmptyString(entry.baseUrl);
    return [
      {
        id: id.trim(),
        ...(name ? { name } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        models: Array.isArray(entry.models)
          ? entry.models.flatMap((model) => {
              const modelId = isRecord(model) ? nonEmptyString(model.id) : undefined;
              return modelId ? [modelId] : [];
            })
          : [],
        source,
      },
    ];
  });
}

export const readPiUserModelProviders = Effect.fn("PiCustomProviders.readUser")(function* (
  environment: NodeJS.ProcessEnv,
  home: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const file = pathService.join(
    environment.PI_CODING_AGENT_DIR || pathService.join(home, ".pi", "agent"),
    "models.json",
  );
  return yield* fileSystem.readFileString(file).pipe(
    Effect.map((contents) => parsePiUserModelProviders(contents, file)),
    Effect.orElseSucceed(() => []),
  );
});
