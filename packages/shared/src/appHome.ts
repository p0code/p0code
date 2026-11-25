import * as Config from "effect/Config";
import * as Option from "effect/Option";

/** p0code owns `~/.p0code` so it never shares a database with a stock T3 Code install in `~/.t3`. */
export const APP_HOME_DIRECTORY_NAME = ".p0code";
/** The home folder from before the rename to p0code; see `appHomeMigration.ts`. */
export const PREVIOUS_APP_HOME_DIRECTORY_NAME = ".hhh";
export const STOCK_T3_HOME_DIRECTORY_NAME = ".t3";
export const APP_HOME_ENV = "P0CODE_HOME";
/** The pre-rename name, still honored when set. */
export const PREVIOUS_APP_HOME_ENV = "HHHCODE_HOME";
/** Still honored when set, and used by p0code's own launchers to hand the resolved home to children. */
export const LEGACY_APP_HOME_ENV = "T3CODE_HOME";

const nonEmpty = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

export const appHomeFromEnv = (env: Readonly<Record<string, string | undefined>>) =>
  nonEmpty(env[APP_HOME_ENV]) ??
  nonEmpty(env[PREVIOUS_APP_HOME_ENV]) ??
  nonEmpty(env[LEGACY_APP_HOME_ENV]);

const optionalHomeConfig = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map(Option.flatMap((value) => Option.fromUndefinedOr(nonEmpty(value)))),
  );

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
