#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as CliError from "effect/cli/CliError";
import { Argument, Command, Flag } from "effect/cli";

import {
  CONFIG_FILE_NAME,
  Engine,
  ServerMode,
  initConfig,
  loadConfig,
  selectTargets,
  type LoadedConfig,
  type Target,
} from "./config.ts";
import { build, doctor, logs, push, rollback, status, up, type SwapResult } from "./deploy.ts";
import { DeployError, exitCodeFor } from "./errors.ts";
import { serverInit, serverStatus } from "./server.ts";
import { layerShell, type Shell } from "./shell.ts";

const configFlag = Flag.String("config").pipe(
  Flag.withAlias("c"),
  Flag.withDescription(`Config file. Default: ./${CONFIG_FILE_NAME}`),
  Flag.withDefault(CONFIG_FILE_NAME),
);
const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print one JSON document on stdout: { ok, command, data | error }."),
  Flag.withDefault(false),
);
const targetFlag = Flag.String("target").pipe(
  Flag.withAlias("t"),
  Flag.atLeast(0),
  Flag.withDescription("Target name from the config; repeatable. Default: all targets."),
);
const tagFlag = Flag.String("tag").pipe(
  Flag.withDescription(
    "Image tag. Default: the git sha (plus a timestamp when the tree is dirty).",
  ),
  Flag.optional,
);
const buildHostFlag = Flag.String("build-host").pipe(
  Flag.withDescription('Build on this ssh host instead of build.host; "local" builds here.'),
  Flag.optional,
);

const errorPayload = (error: DeployError) => ({
  code: error.code,
  message: error.message,
  exitCode: exitCodeFor(error.code),
  ...(error.target === undefined ? {} : { target: error.target }),
  ...(error.output ? { output: error.output } : {}),
});

/** Every command ends here: JSON or short text on stdout, and an exit code agents can branch on. */
const respond = <A, R>(
  command: string,
  json: boolean,
  program: Effect.Effect<A, DeployError, R | Shell>,
  human: (data: A) => string,
  succeeded: (data: A) => boolean = () => true,
) =>
  program.pipe(
    Effect.provide(layerShell({ verbose: !json })),
    Effect.matchEffect({
      onSuccess: (data) => {
        const ok = succeeded(data);
        return Effect.andThen(
          json ? Console.log(JSON.stringify({ ok, command, data })) : Console.log(human(data)),
          Effect.sync(() => {
            if (!ok) process.exitCode = 1;
          }),
        );
      },
      onFailure: (error) =>
        Effect.andThen(
          json
            ? Console.log(JSON.stringify({ ok: false, command, error: errorPayload(error) }))
            : Console.error(
                `error ${error.code}: ${error.message}${error.output ? `\n${error.output}` : ""}`,
              ),
          Effect.sync(() => {
            process.exitCode = exitCodeFor(error.code);
          }),
        ),
    }),
  );

const forTargets = Effect.fn("p0deploy.forTargets")(function* <A, R>(
  configPath: string,
  names: ReadonlyArray<string>,
  run: (loaded: LoadedConfig, target: Target) => Effect.Effect<A, DeployError, R>,
) {
  const loaded = yield* loadConfig(configPath);
  const targets = yield* selectTargets(loaded.config, names);
  const results: Array<A> = [];
  for (const target of targets) results.push(yield* run(loaded, target));
  return results;
});

const describeSwap = (result: SwapResult) =>
  [
    `${result.target}: ${result.image} is live${result.previousImage ? ` (was ${result.previousImage})` : ""}`,
    ...result.urls.map((url) => `  ${url}`),
  ].join("\n");

const initCommand = Command.make(
  "init",
  {
    dir: Flag.String("dir").pipe(
      Flag.withDescription("Project directory with the Dockerfile."),
      Flag.withDefault("."),
    ),
    host: Flag.String("host").pipe(Flag.withDescription("Target ssh host."), Flag.optional),
    domain: Flag.String("domain").pipe(Flag.withDescription("Domain to serve."), Flag.optional),
    force: Flag.Boolean("force").pipe(
      Flag.withDescription("Overwrite an existing config."),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
  },
  (flags) =>
    respond(
      "init",
      flags.json,
      initConfig({
        dir: flags.dir,
        host: Option.getOrUndefined(flags.host),
        domain: Option.getOrUndefined(flags.domain),
        force: flags.force,
      }),
      (result) =>
        `Wrote ${result.path}. Set targets[0].host and domains, then run \`p0deploy server init <host>\` and \`p0deploy doctor\`.`,
    ),
).pipe(Command.withDescription("Write a starter p0deploy.json next to the Dockerfile."));

const buildCommand = Command.make(
  "build",
  { config: configFlag, json: jsonFlag, tag: tagFlag, buildHost: buildHostFlag },
  (flags) =>
    respond(
      "build",
      flags.json,
      Effect.flatMap(loadConfig(flags.config), (loaded) =>
        build(loaded, {
          tag: Option.getOrUndefined(flags.tag),
          buildHost: Option.getOrUndefined(flags.buildHost),
        }),
      ),
      (result) => `Built ${result.image} (${result.imageId.slice(0, 19)}) on ${result.host}`,
    ),
).pipe(Command.withDescription("Build the image locally or on the build host."));

const pushCommand = Command.make(
  "push",
  {
    config: configFlag,
    json: jsonFlag,
    tag: tagFlag,
    buildHost: buildHostFlag,
    target: targetFlag,
  },
  (flags) =>
    respond(
      "push",
      flags.json,
      Effect.flatMap(loadConfig(flags.config), (loaded) =>
        push(loaded, {
          tag: Option.getOrUndefined(flags.tag),
          buildHost: Option.getOrUndefined(flags.buildHost),
          targets: flags.target,
        }),
      ),
      (results) =>
        results
          .map((result) =>
            result.transferred
              ? `${result.target}: sent ${result.image} (${result.mode}, ${result.codec})`
              : `${result.target}: already has ${result.image}`,
          )
          .join("\n"),
    ),
).pipe(
  Command.withDescription("Copy a built image to the targets over ssh; skips hosts that have it."),
);

const upCommand = Command.make(
  "up",
  {
    config: configFlag,
    json: jsonFlag,
    tag: tagFlag,
    buildHost: buildHostFlag,
    target: targetFlag,
  },
  (flags) =>
    respond(
      "up",
      flags.json,
      Effect.flatMap(loadConfig(flags.config), (loaded) =>
        up(loaded, {
          tag: Option.getOrUndefined(flags.tag),
          buildHost: Option.getOrUndefined(flags.buildHost),
          targets: flags.target,
        }),
      ),
      (result) => result.targets.map(describeSwap).join("\n"),
    ),
).pipe(Command.withDescription("Build, push, and swap in the new container once it is healthy."));

const statusCommand = Command.make(
  "status",
  { config: configFlag, json: jsonFlag, target: targetFlag },
  (flags) =>
    respond("status", flags.json, forTargets(flags.config, flags.target, status), (results) =>
      results
        .map((result) =>
          [
            `${result.target} (${result.host}): ${
              result.current
                ? `${result.current.image} ${result.current.status} since ${result.current.startedAt}`
                : "not deployed"
            }`,
            ...result.urls.map((url) => `  ${url}`),
            ...(result.previous ? [`  previous: ${result.previous.image}`] : []),
            `  kept tags: ${result.images.join(", ") || "none"}`,
          ].join("\n"),
        )
        .join("\n"),
    ),
).pipe(Command.withDescription("Show the running and previous container per target."));

const logsCommand = Command.make(
  "logs",
  {
    config: configFlag,
    json: jsonFlag,
    target: targetFlag,
    tail: Flag.Int("tail").pipe(Flag.withDescription("Lines per target."), Flag.withDefault(100)),
    since: Flag.String("since").pipe(
      Flag.withDescription("Only newer lines, e.g. 10m or an RFC 3339 time."),
      Flag.optional,
    ),
  },
  (flags) =>
    respond(
      "logs",
      flags.json,
      forTargets(flags.config, flags.target, (loaded, target) =>
        logs(loaded, target, { tail: flags.tail, since: Option.getOrUndefined(flags.since) }),
      ),
      (results) =>
        results.length === 1
          ? (results[0]?.logs.trimEnd() ?? "")
          : results.map((result) => `== ${result.target}\n${result.logs.trimEnd()}`).join("\n"),
    ),
).pipe(Command.withDescription("Print recent container logs."));

const rollbackCommand = Command.make(
  "rollback",
  {
    config: configFlag,
    json: jsonFlag,
    target: targetFlag,
    to: Flag.String("to").pipe(
      Flag.withDescription("Kept image tag to go to. Default: the previous container's image."),
      Flag.optional,
    ),
  },
  (flags) =>
    respond(
      "rollback",
      flags.json,
      forTargets(flags.config, flags.target, (loaded, target) =>
        rollback(loaded, target, { to: Option.getOrUndefined(flags.to) }),
      ),
      (results) => results.map(describeSwap).join("\n"),
    ),
).pipe(
  Command.withDescription("Swap back to the previous image (rolling back twice rolls forward)."),
);

const doctorCommand = Command.make(
  "doctor",
  { config: configFlag, json: jsonFlag, target: targetFlag, buildHost: buildHostFlag },
  (flags) =>
    respond(
      "doctor",
      flags.json,
      Effect.flatMap(loadConfig(flags.config), (loaded) =>
        doctor(loaded, {
          targets: flags.target,
          buildHost: Option.getOrUndefined(flags.buildHost),
        }),
      ),
      (result) =>
        result.checks
          .map(
            (check) =>
              `${check.ok ? "ok  " : check.required ? "FAIL" : "warn"} ${check.host} ${check.check}: ${check.detail}`,
          )
          .join("\n"),
      (result) => result.ok,
    ),
).pipe(Command.withDescription("Check ssh, docker/podman, zstd and Traefik on every host."));

/** Server commands work without a project; a config, when present, supplies the engine and defaults. */
const optionalConfig = (configPath: string) =>
  loadConfig(configPath).pipe(
    Effect.map((loaded) => loaded.config),
    Effect.catchIf(
      (error) => error.code === "CONFIG_NOT_FOUND",
      () => Effect.succeed(null),
    ),
  );

const hostArgument = Argument.String("host").pipe(
  Argument.withDescription('ssh destination (user@host or an ~/.ssh/config alias), or "local".'),
);
const engineFlag = Flag.Literals("engine", Engine.literals).pipe(
  Flag.withDescription("Container engine on the host. Default: the config's, else docker."),
  Flag.optional,
);

const serverInitCommand = Command.make(
  "init",
  {
    host: hostArgument,
    config: configFlag,
    json: jsonFlag,
    engine: engineFlag,
    mode: Flag.Literals("mode", ServerMode.literals).pipe(
      Flag.withDescription(
        "public: Let's Encrypt on :443. tunnel: plain HTTP on 127.0.0.1:80 behind e.g. Cloudflare Tunnel. lan: HTTP + self-signed HTTPS.",
      ),
      Flag.optional,
    ),
    email: Flag.String("email").pipe(
      Flag.withDescription("Let's Encrypt account email (public mode)."),
      Flag.optional,
    ),
    appsDomain: Flag.String("apps-domain").pipe(
      Flag.withDescription("Apps without domains get <container>.<apps-domain>."),
      Flag.optional,
    ),
    image: Flag.String("image").pipe(
      Flag.withDescription("Traefik image. Default: traefik:v3"),
      Flag.optional,
    ),
  },
  (flags) =>
    respond(
      "server init",
      flags.json,
      Effect.flatMap(optionalConfig(flags.config), (config) =>
        serverInit({
          host: flags.host,
          engine: Option.getOrUndefined(flags.engine) ?? config?.engine,
          mode: Option.getOrUndefined(flags.mode) ?? config?.server?.mode,
          email: Option.getOrUndefined(flags.email) ?? config?.server?.email,
          appsDomain: Option.getOrUndefined(flags.appsDomain) ?? config?.server?.appsDomain,
          image: Option.getOrUndefined(flags.image),
        }),
      ),
      (result) =>
        `${result.host}: Traefik ${result.action} (${result.mode}${result.appsDomain ? `, *.${result.appsDomain}` : ""})`,
    ),
).pipe(Command.withDescription("Install or update the host's Traefik reverse proxy. Idempotent."));

const serverStatusCommand = Command.make(
  "status",
  { host: hostArgument, config: configFlag, json: jsonFlag, engine: engineFlag },
  (flags) =>
    respond(
      "server status",
      flags.json,
      Effect.flatMap(optionalConfig(flags.config), (config) =>
        serverStatus({
          host: flags.host,
          engine: Option.getOrUndefined(flags.engine) ?? config?.engine,
        }),
      ),
      (result) =>
        [
          `${result.host}: Traefik ${result.proxy ? `${result.proxy.status} (${result.proxy.mode})` : "not installed"}`,
          ...result.apps.map(
            (app) =>
              `  ${app.name} ${app.status} ${app.image}${app.domains.length ? ` ${app.domains.join(", ")}` : ""}`,
          ),
        ].join("\n"),
    ),
).pipe(Command.withDescription("Show Traefik and every p0deploy container on a host."));

const serverCommand = Command.make("server").pipe(
  Command.withDescription("Manage the Traefik proxy on a deploy host."),
  Command.withSubcommands([serverInitCommand, serverStatusCommand]),
);

export const cli = Command.make("p0deploy").pipe(
  Command.withDescription(
    "Build a container image, copy it over ssh, and swap it in behind Traefik. Exit codes: 0 ok, 1 failed, 2 bad config or usage, 3 new version unhealthy (old one kept).",
  ),
  Command.withSubcommands([
    initCommand,
    buildCommand,
    pushCommand,
    upCommand,
    statusCommand,
    logsCommand,
    rollbackCommand,
    doctorCommand,
    serverCommand,
  ]),
);

if (import.meta.main) {
  Command.run(cli, { version: "0.1.0" }).pipe(
    Effect.catchIf(CliError.isCliError, () =>
      Effect.sync(() => {
        process.exitCode = 2;
      }),
    ),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
