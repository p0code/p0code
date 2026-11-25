import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

/** p0code's data directory, the same one the rest of p0code uses. */
export const APP_HOME_ENV = "P0CODE_HOME";
export const PREVIOUS_APP_HOME_ENV = "HHHCODE_HOME";
export const LEGACY_APP_HOME_ENV = "T3CODE_HOME";
export const APP_HOME_DIRECTORY_NAME = ".p0code";

export const SSH_KEY_FILE_NAME = "p0deploy_ed25519";
export const SSH_KEY_DIRECTORIES = ["deploy", "keys"] as const;

const nonEmpty = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

export const appHomeFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): string | undefined =>
  nonEmpty(env[APP_HOME_ENV]) ??
  nonEmpty(env[PREVIOUS_APP_HOME_ENV]) ??
  nonEmpty(env[LEGACY_APP_HOME_ENV]);

const optionalHomeConfig = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map(Option.flatMap((value) => Option.fromUndefinedOr(nonEmpty(value)))),
  );

/** P0CODE_HOME first, then the names p0code used before; none means ~/.p0code. */
export const AppHomeConfig = Config.all([
  optionalHomeConfig(APP_HOME_ENV),
  optionalHomeConfig(PREVIOUS_APP_HOME_ENV),
  optionalHomeConfig(LEGACY_APP_HOME_ENV),
]).pipe(
  Config.map(([current, previous, legacy]) =>
    Option.orElse(
      Option.orElse(current, () => previous),
      () => legacy,
    ),
  ),
);

export const sshKeyPath = (path: Path.Path, home: string): string =>
  path.join(home, ...SSH_KEY_DIRECTORIES, SSH_KEY_FILE_NAME);

export const resolveAppHome = Effect.fn("p0deploy.sshKey.resolveAppHome")(function* () {
  const path = yield* Path.Path;
  const configured = yield* AppHomeConfig.pipe(Effect.orElseSucceed(() => Option.none<string>()));
  return Option.getOrElse(configured, () => path.join(NodeOS.homedir(), APP_HOME_DIRECTORY_NAME));
});

/** Absolute path of the install's dedicated ssh key, whether or not it exists yet. */
export const resolveSshKeyPath = Effect.fn("p0deploy.ssh.resolveSshKeyPath")(function* () {
  const path = yield* Path.Path;
  return sshKeyPath(path, yield* resolveAppHome());
});

/** The key path once `ssh setup` or `ssh key` has created it; undefined keeps old ssh behaviour. */
export const findDeployKey = Effect.fn("p0deploy.ssh.findDeployKey")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const privateKeyPath = yield* resolveSshKeyPath();
  const exists = yield* fs.exists(privateKeyPath).pipe(Effect.orElseSucceed(() => false));
  return exists ? privateKeyPath : undefined;
});
