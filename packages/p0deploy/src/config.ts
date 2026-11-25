import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { DeployError } from "./errors.ts";

export const CONFIG_FILE_NAME = "p0deploy.json";

const pattern = (regex: RegExp, message: string) =>
  Schema.String.check(Schema.isPattern(regex, { message }));

const withDefault = <S extends Schema.Constraint>(value: S["Encoded"]) =>
  Schema.withDecodingDefaultKey<S>(Effect.succeed(value));

// "local" means the machine p0deploy runs on; anything else is handed to `ssh` as is,
// so aliases from ~/.ssh/config work. A leading "-" would be read as an ssh option.
const HostAddress = pattern(/^[^-\s]\S*$/u, "Expected an ssh destination such as user@host");
const ObjectName = pattern(
  /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u,
  "Expected letters, digits, '_', '.' or '-'",
);
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const HealthCheck = Schema.Struct({
  /** HTTP path on `port`, fetched from the Traefik container over the p0deploy network. */
  path: Schema.optionalKey(pattern(/^\/\S*$/u, "Expected a path such as /healthz")),
  /** Becomes the container's Docker HEALTHCHECK (run with `sh -c` inside it), which Traefik also waits for. */
  cmd: Schema.optionalKey(Schema.NonEmptyString),
  timeoutSeconds: PositiveInt.pipe(withDefault(60)),
  intervalSeconds: PositiveInt.pipe(withDefault(2)),
});
export type HealthCheck = typeof HealthCheck.Type;

export const RestartPolicy = Schema.Literals(["no", "always", "unless-stopped", "on-failure"]);
export type RestartPolicy = typeof RestartPolicy.Type;

const HOSTNAME = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*";
const Domain = pattern(
  new RegExp(`^${HOSTNAME}$`, "iu"),
  "Expected a hostname such as app.example.com",
);
/** `apps.example.com` or `*.apps.example.com`: apps without domains get `<container>.apps.example.com`. */
const AppsDomain = pattern(
  new RegExp(`^(?:\\*\\.)?${HOSTNAME}$`, "iu"),
  "Expected a domain such as apps.example.com",
);

export const Target = Schema.Struct({
  name: ObjectName,
  host: HostAddress,
  /** Defaults to the app name. */
  container: Schema.optionalKey(ObjectName),
  /** Hostnames Traefik routes to this container. Empty: `<container>.<appsDomain>` when the server has one. */
  domains: Schema.Array(Domain).pipe(withDefault([])),
  /** Port the app listens on inside the container. */
  port: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }))),
  /** Host port mappings, for non-HTTP services. Published ports cannot be shared, so these swaps stop the old container first. */
  ports: Schema.Array(
    pattern(
      /^(?:[\d.]+:|\[[\da-fA-F:]+\]:)?\d+(?:-\d+)?:\d+(?:-\d+)?(?:\/(?:tcp|udp|sctp))?$/u,
      "Expected a port mapping such as 80:3000 or 127.0.0.1:8080:8080",
    ),
  ).pipe(withDefault([])),
  /** Path of an env file on the target host, passed as --env-file. */
  envFile: Schema.optionalKey(Schema.NonEmptyString),
  /** Names of variables whose values are copied from the local environment at deploy time. */
  forwardEnv: Schema.Array(
    pattern(/^[A-Za-z_][A-Za-z0-9_]*$/u, "Expected an environment variable name"),
  ).pipe(withDefault([])),
  volumes: Schema.Array(Schema.NonEmptyString).pipe(withDefault([])),
  restart: RestartPolicy.pipe(withDefault("unless-stopped")),
  health: Schema.optionalKey(HealthCheck),
  /** How a remotely built image reaches this target: build host straight to target, or through this machine. */
  transfer: Schema.Literals(["auto", "direct", "relay"]).pipe(withDefault("auto")),
});
export type Target = typeof Target.Type;

export const BuildConfig = Schema.Struct({
  context: Schema.NonEmptyString.pipe(withDefault(".")),
  dockerfile: Schema.NonEmptyString.pipe(withDefault("Dockerfile")),
  args: Schema.Record(Schema.String, Schema.String).pipe(withDefault({})),
  platform: Schema.optionalKey(Schema.NonEmptyString),
  /** Build on this ssh host instead of locally. */
  host: Schema.optionalKey(HostAddress),
});
export type BuildConfig = typeof BuildConfig.Type;

export const Engine = Schema.Literals(["docker", "podman"]);
export type Engine = typeof Engine.Type;

/** public: Let's Encrypt on :443. tunnel: TLS ends upstream (e.g. Cloudflare Tunnel), plain HTTP on 127.0.0.1:80. lan: HTTP plus self-signed HTTPS. */
export const ServerMode = Schema.Literals(["public", "tunnel", "lan"]);
export type ServerMode = typeof ServerMode.Type;

/** Defaults for `p0deploy server init`. */
export const ServerSettings = Schema.Struct({
  mode: Schema.optionalKey(ServerMode),
  email: Schema.optionalKey(Schema.NonEmptyString),
  appsDomain: Schema.optionalKey(AppsDomain),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DeployConfig = Schema.Struct({
  $schema: Schema.optionalKey(Schema.String),
  app: pattern(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u, "Expected a lowercase image name such as my-app"),
  engine: Engine.pipe(withDefault("docker")),
  build: BuildConfig.pipe(withDefault({})),
  /** Image tags kept on each target after a deploy, for `rollback --to`. */
  keepImages: PositiveInt.pipe(withDefault(3)),
  server: Schema.optionalKey(ServerSettings),
  targets: Schema.Array(Target).check(Schema.isMinLength(1)),
});
export type DeployConfig = typeof DeployConfig.Type;

export interface LoadedConfig {
  readonly path: string;
  readonly config: DeployConfig;
  readonly contextDir: string;
  readonly dockerfilePath: string;
}

const decodeConfigJson = Schema.decodeUnknownEffect(Schema.fromJsonString(DeployConfig), {
  onExcessProperty: "error",
  errors: "all",
});

export const parseConfig = Effect.fn("p0deploy.parseConfig")(function* (
  source: string,
  configPath: string,
) {
  const config = yield* decodeConfigJson(source).pipe(
    Effect.mapError(
      (error) =>
        new DeployError({
          code: "CONFIG_INVALID",
          message: `${configPath}: ${error.message}`,
        }),
    ),
  );
  const seen = new Set<string>();
  for (const target of config.targets) {
    if (seen.has(target.name)) {
      return yield* new DeployError({
        code: "CONFIG_INVALID",
        message: `${configPath}: target "${target.name}" is defined twice`,
      });
    }
    seen.add(target.name);
    if (
      (target.health?.path !== undefined || target.domains.length > 0) &&
      target.port === undefined
    ) {
      return yield* new DeployError({
        code: "CONFIG_INVALID",
        message: `${configPath}: target "${target.name}" needs "port" (the port the app listens on) for domains or health.path`,
      });
    }
  }
  return config;
});

export const loadConfig = Effect.fn("p0deploy.loadConfig")(function* (configPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolute = path.resolve(configPath);
  const source = yield* fs.readFileString(absolute).pipe(
    Effect.mapError(
      () =>
        new DeployError({
          code: "CONFIG_NOT_FOUND",
          message: `No config at ${absolute}. Run \`p0deploy init\` first.`,
        }),
    ),
  );
  const config = yield* parseConfig(source, absolute);
  const contextDir = path.resolve(path.dirname(absolute), config.build.context);
  const loaded: LoadedConfig = {
    path: absolute,
    config,
    contextDir,
    dockerfilePath: path.resolve(contextDir, config.build.dockerfile),
  };
  return loaded;
});

export const containerName = (config: DeployConfig, target: Target): string =>
  target.container ?? config.app;

export const selectTargets = (
  config: DeployConfig,
  names: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<Target>, DeployError> => {
  if (names.length === 0) return Effect.succeed(config.targets);
  const selected: Array<Target> = [];
  for (const name of names) {
    const target = config.targets.find((candidate) => candidate.name === name);
    if (!target) {
      return Effect.fail(
        new DeployError({
          code: "TARGET_NOT_FOUND",
          message: `Unknown target "${name}". Known: ${config.targets.map((t) => t.name).join(", ")}`,
        }),
      );
    }
    selected.push(target);
  }
  return Effect.succeed(selected);
};

const DOCKERFILE_NAMES = ["Dockerfile", "Containerfile", "dockerfile"];

export function starterConfig(input: {
  readonly app: string;
  readonly dockerfile: string;
  readonly host: string;
  readonly domain: string | undefined;
  readonly exposedPort: number | null;
}): typeof DeployConfig.Encoded {
  return {
    app: input.app,
    engine: "docker",
    build: { context: ".", dockerfile: input.dockerfile },
    keepImages: 3,
    targets: [
      {
        name: "production",
        host: input.host,
        domains: [input.domain ?? `${input.app}.example.com`],
        port: input.exposedPort ?? 3000,
        envFile: `/srv/${input.app}/.env`,
        forwardEnv: [],
        restart: "unless-stopped",
        health: { path: "/", timeoutSeconds: 60 },
      },
    ],
  };
}

export const formatConfig = (config: typeof DeployConfig.Encoded): string =>
  `${JSON.stringify(config, null, 2)}\n`;

export const sanitizeAppName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, "") || "app";

export const exposedPortOf = (dockerfile: string): number | null => {
  const match = /^\s*EXPOSE\s+(\d+)/imu.exec(dockerfile);
  return match?.[1] ? Number(match[1]) : null;
};

export const initConfig = Effect.fn("p0deploy.initConfig")(function* (input: {
  readonly dir: string;
  readonly host?: string | undefined;
  readonly domain?: string | undefined;
  readonly force?: boolean | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.resolve(input.dir);
  const configPath = path.join(dir, CONFIG_FILE_NAME);
  if (!input.force && (yield* fs.exists(configPath).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* new DeployError({
      code: "CONFIG_EXISTS",
      message: `${configPath} already exists. Pass --force to overwrite it.`,
    });
  }
  let dockerfile: string | null = null;
  for (const name of DOCKERFILE_NAMES) {
    if (yield* fs.exists(path.join(dir, name)).pipe(Effect.orElseSucceed(() => false))) {
      dockerfile = name;
      break;
    }
  }
  if (dockerfile === null) {
    return yield* new DeployError({
      code: "NO_DOCKERFILE",
      message: `No Dockerfile or Containerfile in ${dir}.`,
    });
  }
  const dockerfileSource = yield* fs
    .readFileString(path.join(dir, dockerfile))
    .pipe(Effect.orElseSucceed(() => ""));
  const config = starterConfig({
    app: sanitizeAppName(path.basename(dir)),
    dockerfile,
    host: input.host ?? "user@your-server",
    domain: input.domain,
    exposedPort: exposedPortOf(dockerfileSource),
  });
  yield* fs.writeFileString(configPath, formatConfig(config)).pipe(
    Effect.mapError(
      (cause) =>
        new DeployError({
          code: "COMMAND_FAILED",
          message: `Could not write ${configPath}: ${cause.message}`,
        }),
    ),
  );
  return { path: configPath, config };
});
