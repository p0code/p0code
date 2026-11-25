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
import { parse as parseJsonc } from "jsonc-parser";

const DEFAULT_OUTPUT_TOKENS = 16_384;

/**
 * OpenCode config holding only p0code's providers. Keys stay `{env:…}` references that OpenCode
 * resolves when it loads the file.
 */
function renderOpenCodeCustomProvidersConfig(
  providers: ReadonlyArray<CustomModelProvider>,
): string {
  const provider = Object.fromEntries(
    providers.map((entry) => [
      entry.id,
      {
        name: entry.name,
        npm: entry.kind === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible",
        options: {
          baseURL: entry.baseUrl,
          apiKey: `{env:${customModelProviderApiKeyEnvName(entry.id)}}`,
        },
        models: Object.fromEntries(
          entry.models.map((model) => [
            model.id,
            {
              name: model.name ?? model.id,
              ...(model.contextWindow !== undefined
                ? {
                    limit: {
                      context: model.contextWindow,
                      output: Math.min(DEFAULT_OUTPUT_TOKENS, model.contextWindow),
                    },
                  }
                : {}),
              ...(model.inputCost !== undefined || model.outputCost !== undefined
                ? { cost: { input: model.inputCost ?? 0, output: model.outputCost ?? 0 } }
                : {}),
            },
          ]),
        ),
      },
    ]),
  );
  return `${JSON.stringify({ $schema: "https://opencode.ai/config.json", provider }, null, 2)}\n`;
}

/**
 * Writes the overlay and returns the variables that make OpenCode merge it over the user's own
 * config. A user who already points `OPENCODE_CONFIG` at a file keeps it; the overlay then goes
 * inline, and only when that slot is free too.
 */
export const openCodeCustomProvidersEnvironment = Effect.fn("OpenCodeCustomProviders.environment")(
  function* (input: {
    readonly providers: ReadonlyArray<CustomModelProvider>;
    readonly stateDir: string;
    readonly instanceId: string;
    readonly baseEnvironment: NodeJS.ProcessEnv;
  }) {
    if (input.providers.length === 0) return [] satisfies ResolvedProviderInstanceEnvironment;
    const config = renderOpenCodeCustomProvidersConfig(input.providers);
    if (input.baseEnvironment.OPENCODE_CONFIG) {
      if (input.baseEnvironment.OPENCODE_CONFIG_CONTENT) {
        yield* Effect.logWarning(
          "OpenCode custom providers are skipped: OPENCODE_CONFIG and OPENCODE_CONFIG_CONTENT are both set",
        );
        return [];
      }
      return [{ name: "OPENCODE_CONFIG_CONTENT", value: config, sensitive: false }];
    }
    const pathService = yield* Path.Path;
    const path = customModelProviderOverlayPath(
      pathService,
      input.stateDir,
      `opencode-${input.instanceId}.json`,
    );
    yield* writeCustomModelProviderOverlay(path, config);
    return [{ name: "OPENCODE_CONFIG", value: path, sensitive: false }];
  },
);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** The `provider` entries of one OpenCode config file. */
function parseOpenCodeUserModelProviders(
  contents: string,
  source: string,
): ReadonlyArray<UserModelProvider> {
  const config: unknown = parseJsonc(contents, [], { allowTrailingComma: true });
  const providers = isRecord(config) ? config.provider : undefined;
  if (!isRecord(providers)) return [];
  return Object.entries(providers).flatMap(([id, entry]) => {
    if (!isRecord(entry) || id.trim() === "") return [];
    const options = isRecord(entry.options) ? entry.options : {};
    const name = nonEmptyString(entry.name);
    const baseUrl = nonEmptyString(options.baseURL);
    return [
      {
        id: id.trim(),
        ...(name ? { name } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        models: isRecord(entry.models)
          ? Object.keys(entry.models).filter((model) => model.trim() !== "")
          : [],
        source,
      },
    ];
  });
}

/** Providers in the user's global OpenCode config files and any `OPENCODE_CONFIG` they set. */
export const readOpenCodeUserModelProviders = Effect.fn("OpenCodeCustomProviders.readUser")(
  function* (environment: NodeJS.ProcessEnv, home: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const configDir = pathService.join(
      environment.XDG_CONFIG_HOME || pathService.join(home, ".config"),
      "opencode",
    );
    const files = [
      ...["config.json", "opencode.json", "opencode.jsonc"].map((name) =>
        pathService.join(configDir, name),
      ),
      ...(environment.OPENCODE_CONFIG ? [environment.OPENCODE_CONFIG] : []),
    ];
    const providers = yield* Effect.forEach(files, (file) =>
      fileSystem.readFileString(file).pipe(
        Effect.map((contents) => parseOpenCodeUserModelProviders(contents, file)),
        Effect.orElseSucceed(() => []),
      ),
    );
    return providers.flat();
  },
);
