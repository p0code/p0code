import {
  type CustomModelProvider,
  customModelProviderApiKeyEnvName,
  type ResolvedProviderInstanceEnvironment,
  settingsSecretLiteral,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export interface CustomModelProviderSettings {
  readonly customProviders: ReadonlyArray<CustomModelProvider>;
  readonly customProviderApiKeys: Readonly<Record<string, SettingsSecretValue>>;
}

/**
 * One sensitive variable per provider with a saved key. Overlays name the variable, so keys never
 * reach a config file. The instance registry has already read referenced keys into literals.
 */
export const customModelProviderKeyEnvironment = (
  settings: CustomModelProviderSettings,
): ResolvedProviderInstanceEnvironment =>
  settings.customProviders.flatMap((provider) => {
    const value = settingsSecretLiteral(settings.customProviderApiKeys[provider.id]);
    return value === ""
      ? []
      : [{ name: customModelProviderApiKeyEnvName(provider.id), value, sensitive: true }];
  });

/** Where an instance's overlay lives: p0code's own state, never the agent's config directory. */
export const customModelProviderOverlayPath = (
  pathService: Path.Path,
  stateDir: string,
  fileName: string,
) => pathService.join(stateDir, "custom-providers", fileName);

/** Running agents may read the overlay at any time, so it is replaced whole, never rewritten. */
export const writeCustomModelProviderOverlay = Effect.fn("CustomModelProviders.writeOverlay")(
  function* (path: string, contents: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const directory = pathService.dirname(path);
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    const existing = yield* fileSystem
      .readFileString(path)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (existing === contents) return;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const staging = yield* fileSystem.makeTempDirectoryScoped({ directory });
        const staged = pathService.join(staging, pathService.basename(path));
        yield* fileSystem.writeFileString(staged, contents);
        yield* fileSystem.rename(staged, path);
      }),
    );
  },
);
