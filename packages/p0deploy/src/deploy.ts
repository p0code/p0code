import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  PROXY_NETWORK,
  SSH_CONNECTION_FAILED,
  codecProbeScript,
  containerLabels,
  containerScript,
  contextTarArgv,
  directProbeScript,
  directTransferScript,
  envFileContents,
  healthScript,
  hostFor,
  hostLabel,
  imageIdScript,
  inspectContainersScript,
  listImageTagsScript,
  loadScript,
  localBuildArgv,
  logsScript,
  onHost,
  parseCodec,
  parseContainers,
  parseProbe,
  parseProxy,
  probeScript,
  proxyInspectScript,
  remoteBuildScript,
  removeContainerScript,
  removeImagesScript,
  renameScript,
  resolveDomains,
  routeUrls,
  runScript,
  saveScript,
  setRestartScript,
  tagScript,
  tagsToPrune,
  withIdentity,
  type Codec,
  type ContainerInfo,
  type Host,
  type ProxyInfo,
} from "./commands.ts";
import {
  containerName,
  selectTargets,
  type Engine,
  type LoadedConfig,
  type Target,
} from "./config.ts";
import { DeployError } from "./errors.ts";
import { Shell, type ExecResult } from "./shell.ts";
import { describeAuth, sshAuth } from "./ssh.ts";

export interface BuildResult {
  readonly image: string;
  readonly tag: string;
  readonly imageId: string;
  readonly host: string;
}

export type TransferMode = "skipped" | "local" | "relay" | "direct";

export interface PushResult {
  readonly target: string;
  readonly host: string;
  readonly image: string;
  readonly transferred: boolean;
  readonly mode: TransferMode;
  readonly codec: Codec | null;
}

export interface SwapResult {
  readonly target: string;
  readonly host: string;
  readonly container: string;
  readonly image: string;
  readonly previousImage: string | null;
  readonly urls: ReadonlyArray<string>;
  /** True when published `ports` forced the old container to stop before the new one started. */
  readonly stoppedOldFirst: boolean;
  readonly prunedImages: ReadonlyArray<string>;
}

export interface UpResult {
  readonly build: BuildResult;
  readonly targets: ReadonlyArray<SwapResult & { readonly transfer: PushResult }>;
}

export interface TargetStatus {
  readonly target: string;
  readonly host: string;
  readonly container: string;
  readonly urls: ReadonlyArray<string>;
  readonly current: ContainerInfo | null;
  readonly previous: ContainerInfo | null;
  readonly images: ReadonlyArray<string>;
}

export interface LogsResult {
  readonly target: string;
  readonly host: string;
  readonly container: string;
  readonly logs: string;
}

export interface DoctorCheck {
  readonly host: string;
  readonly check: string;
  readonly ok: boolean;
  readonly required: boolean;
  readonly detail: string;
}

export interface DoctorResult {
  readonly ok: boolean;
  readonly checks: ReadonlyArray<DoctorCheck>;
}

/** Where to build, overriding `build.host`: an ssh destination, or "local" for this machine. */
export interface BuildHostOverride {
  readonly buildHost?: string | undefined;
}

const OUTPUT_TAIL = 4_000;

const tail = (text: string): string =>
  text.length <= OUTPUT_TAIL ? text.trim() : text.slice(-OUTPUT_TAIL).trim();

export const runOn = (host: Host, script: string) =>
  Effect.flatMap(Effect.service(Shell), (shell) =>
    shell.exec(onHost(withIdentity(host, shell.identity), script)),
  );

export const commandFailed = (host: Host, what: string, result: ExecResult, target?: string) =>
  new DeployError({
    code: "COMMAND_FAILED",
    message:
      host.kind === "ssh" && result.exitCode === SSH_CONNECTION_FAILED
        ? `ssh to ${host.address} failed while trying to ${what}`
        : `Failed to ${what} on ${hostLabel(host)} (exit ${result.exitCode})`,
    output: tail(result.stderr || result.stdout),
    ...(target === undefined ? {} : { target }),
  });

export const runOk = Effect.fn("p0deploy.runOk")(function* (
  host: Host,
  script: string,
  what: string,
  target?: string,
) {
  const result = yield* runOn(host, script);
  if (result.exitCode !== 0) return yield* commandFailed(host, what, result, target);
  return result;
});

/** 2026-11-25T10:30:00.000Z → 20261125103000 */
export const timestampTag = (now: DateTime.Utc): string =>
  DateTime.formatIso(now).replace(/\D/gu, "").slice(0, 14);

/** The short git sha for a clean checkout; a dirty tree or no git also gets a timestamp so tags never collide. */
export const resolveTag = Effect.fn("p0deploy.resolveTag")(function* (dir: string) {
  const shell = yield* Shell;
  const stamp = timestampTag(yield* DateTime.now);
  const rev = yield* shell.exec(["git", "-C", dir, "rev-parse", "--short=12", "HEAD"]);
  if (rev.exitCode !== 0) return stamp;
  const status = yield* shell.exec(["git", "-C", dir, "status", "--porcelain"]);
  const sha = rev.stdout.trim();
  return status.exitCode === 0 && status.stdout.trim() === "" ? sha : `${sha}-dirty-${stamp}`;
});

const configDir = (loaded: LoadedConfig) =>
  Effect.map(Effect.service(Path.Path), (path) => path.dirname(loaded.path));

const buildHostOf = (loaded: LoadedConfig, override: BuildHostOverride) =>
  hostFor(override.buildHost ?? loaded.config.build.host);

export const tagOf = (ref: string): string => {
  const colon = ref.lastIndexOf(":");
  return colon > ref.lastIndexOf("/") ? ref.slice(colon + 1) : "latest";
};

export const build = Effect.fn("p0deploy.build")(function* (
  loaded: LoadedConfig,
  options: BuildHostOverride & { readonly tag?: string | undefined } = {},
) {
  const { config } = loaded;
  const shell = yield* Shell;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const tag = options.tag ?? (yield* resolveTag(yield* configDir(loaded)));
  const image = `${config.app}:${tag}`;
  const host = buildHostOf(loaded, options);
  const spec = {
    engine: config.engine,
    image,
    args: config.build.args,
    platform: config.build.platform,
  };
  yield* shell.note(`Building ${image} on ${hostLabel(host)}`);

  let failed: ExecResult | undefined;
  if (host.kind === "local") {
    const result = yield* shell.exec(
      localBuildArgv({ ...spec, dockerfile: loaded.dockerfilePath, context: loaded.contextDir }),
      { stream: true },
    );
    if (result.exitCode !== 0) failed = result;
  } else {
    const dockerfile = path.relative(loaded.contextDir, loaded.dockerfilePath);
    if (dockerfile.startsWith("..") || path.isAbsolute(dockerfile)) {
      return yield* new DeployError({
        code: "CONFIG_INVALID",
        message: "build.dockerfile must be inside build.context when building on a build host",
      });
    }
    const dockerignorePath = path.join(loaded.contextDir, ".dockerignore");
    const hasDockerignore = yield* fs
      .exists(dockerignorePath)
      .pipe(Effect.orElseSucceed(() => false));
    const results = yield* shell.pipe(
      [
        contextTarArgv(loaded.contextDir, hasDockerignore ? dockerignorePath : null),
        onHost(withIdentity(host, shell.identity), remoteBuildScript({ ...spec, dockerfile })),
      ],
      { stream: true },
    );
    failed = results.find((result) => result.exitCode !== 0);
  }
  if (failed) return yield* commandFailed(host, `build ${image}`, failed);

  const inspected = yield* runOk(host, imageIdScript(config.engine, image), `inspect ${image}`);
  const result: BuildResult = {
    image,
    tag,
    imageId: inspected.stdout.trim(),
    host: hostLabel(host),
  };
  return result;
});

const probeCodec = (host: Host) =>
  Effect.map(runOn(host, codecProbeScript), (result) =>
    result.exitCode === 0 ? parseCodec(result.stdout) : "gzip",
  );

const sameHost = (a: Host, b: Host) =>
  a.kind === "local" ? b.kind === "local" : b.kind === "ssh" && a.address === b.address;

export const pushToTarget = Effect.fn("p0deploy.pushToTarget")(function* (
  loaded: LoadedConfig,
  source: { readonly host: Host; readonly image: string; readonly imageId: string },
  target: Target,
) {
  const { engine } = loaded.config;
  const shell = yield* Shell;
  const host = hostFor(target.host);
  const base = { target: target.name, host: hostLabel(host), image: source.image };
  const skipped: PushResult = { ...base, transferred: false, mode: "skipped", codec: null };
  if (sameHost(source.host, host)) return skipped;

  const present = yield* runOn(host, imageIdScript(engine, source.imageId));
  if (present.exitCode === 0) {
    yield* runOk(host, tagScript(engine, source.imageId, source.image), "tag image", target.name);
    yield* shell.note(`${target.name}: already has ${source.image}`);
    return skipped;
  }
  if (host.kind === "ssh" && present.exitCode === SSH_CONNECTION_FAILED) {
    return yield* commandFailed(host, "check for the image", present, target.name);
  }

  const [sourceCodec, targetCodec] = yield* Effect.all([probeCodec(source.host), probeCodec(host)]);
  const codec: Codec = sourceCodec === "zstd" && targetCodec === "zstd" ? "zstd" : "gzip";

  let mode: TransferMode;
  if (source.host.kind === "local") {
    mode = "local";
  } else if (host.kind === "local" || target.transfer === "relay") {
    mode = "relay";
  } else if (target.transfer === "direct") {
    mode = "direct";
  } else {
    const probe = yield* runOn(source.host, directProbeScript(host.address));
    mode = probe.exitCode === 0 ? "direct" : "relay";
  }
  yield* shell.note(
    `${target.name}: sending ${source.image} (${codec}, ${mode === "direct" ? "build host → target" : "through this machine"})`,
  );

  const results =
    mode === "direct" && host.kind === "ssh"
      ? [
          yield* shell.exec(
            onHost(
              withIdentity(source.host, shell.identity),
              directTransferScript(engine, source.image, codec, host.address),
            ),
            { stream: true },
          ),
        ]
      : yield* shell.pipe(
          [
            onHost(
              withIdentity(source.host, shell.identity),
              saveScript(engine, source.image, codec),
            ),
            onHost(withIdentity(host, shell.identity), loadScript(engine, codec)),
          ],
          { stream: true },
        );
  const failed = results.find((result) => result.exitCode !== 0);
  if (failed) return yield* commandFailed(host, `load ${source.image}`, failed, target.name);
  yield* runOk(host, imageIdScript(engine, source.image), "verify the loaded image", target.name);

  const pushed: PushResult = { ...base, transferred: true, mode, codec };
  return pushed;
});

const imageOnBuildHost = Effect.fn("p0deploy.imageOnBuildHost")(function* (
  host: Host,
  engine: Engine,
  image: string,
) {
  const inspected = yield* runOn(host, imageIdScript(engine, image));
  if (inspected.exitCode !== 0) {
    return yield* new DeployError({
      code: "IMAGE_NOT_FOUND",
      message: `${image} is not on ${hostLabel(host)}. Run \`p0deploy build\` or pass --tag.`,
    });
  }
  return { host, image, imageId: inspected.stdout.trim() };
});

export const push = Effect.fn("p0deploy.push")(function* (
  loaded: LoadedConfig,
  options: BuildHostOverride & {
    readonly tag?: string | undefined;
    readonly targets?: ReadonlyArray<string> | undefined;
  } = {},
) {
  const targets = yield* selectTargets(loaded.config, options.targets ?? []);
  const tag = options.tag ?? (yield* resolveTag(yield* configDir(loaded)));
  const source = yield* imageOnBuildHost(
    buildHostOf(loaded, options),
    loaded.config.engine,
    `${loaded.config.app}:${tag}`,
  );
  const results: Array<PushResult> = [];
  for (const target of targets) results.push(yield* pushToTarget(loaded, source, target));
  return results;
});

/** Values come from this process's environment; they reach the target only on ssh's stdin. */
export const resolveForwardedEnv = Effect.fn("p0deploy.resolveForwardedEnv")(function* (
  target: Target,
) {
  const values: Array<readonly [string, string]> = [];
  for (const name of target.forwardEnv) {
    const value = yield* Config.option(Config.String(name)).pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    if (Option.isNone(value)) {
      return yield* new DeployError({
        code: "ENV_MISSING",
        target: target.name,
        message: `${name} is listed in forwardEnv for ${target.name} but is not set here`,
      });
    }
    if (/[\r\n]/u.test(value.value)) {
      return yield* new DeployError({
        code: "ENV_MISSING",
        target: target.name,
        message: `${name} contains a newline, which env files cannot carry`,
      });
    }
    values.push([name, value.value]);
  }
  return values;
});

const inspectContainers = (engine: Engine, host: Host, names: ReadonlyArray<string>) =>
  Effect.map(runOn(host, inspectContainersScript(engine, names)), (result) =>
    parseContainers(result.stdout),
  );

/** Reads the mode and apps domain `server init` stored on the host's Traefik container. */
export const readProxy = Effect.fn("p0deploy.readProxy")(function* (
  engine: Engine,
  host: Host,
  target?: string,
) {
  const result = yield* runOn(host, proxyInspectScript(engine));
  if (host.kind === "ssh" && result.exitCode === SSH_CONNECTION_FAILED) {
    return yield* commandFailed(host, "look for Traefik", result, target);
  }
  const proxy = parseProxy(result.stdout);
  const info: ProxyInfo | null = proxy && { mode: proxy.mode, appsDomain: proxy.appsDomain };
  return info;
});

const prune = Effect.fn("p0deploy.prune")(function* (
  loaded: LoadedConfig,
  host: Host,
  inUse: ReadonlyArray<string>,
) {
  const { engine, app, keepImages } = loaded.config;
  const listed = yield* runOn(host, listImageTagsScript(engine, app));
  if (listed.exitCode !== 0) return [];
  const stale = tagsToPrune(
    listed.stdout.split("\n").map((line) => line.trim()),
    keepImages,
    new Set(inUse.map(tagOf)),
  );
  if (stale.length > 0) {
    yield* runOn(
      host,
      removeImagesScript(
        engine,
        stale.map((tag) => `${app}:${tag}`),
      ),
    );
  }
  return stale;
});

/**
 * `<container>-next` gets the same Traefik labels, so both serve until it is healthy;
 * the old one then stops and stays as `<container>-prev`. Host `ports` cannot be
 * bound twice, so those swaps stop the old one first and restart it on failure.
 */
export const swap = Effect.fn("p0deploy.swap")(function* (
  loaded: LoadedConfig,
  target: Target,
  image: string,
) {
  const { engine, app } = loaded.config;
  const shell = yield* Shell;
  const host = hostFor(target.host);
  const name = containerName(loaded.config, target);
  const next = `${name}-next`;
  const prev = `${name}-prev`;
  const forwarded = yield* resolveForwardedEnv(target);

  const proxy = yield* readProxy(engine, host, target.name);
  if (proxy === null && (target.domains.length > 0 || target.health?.path !== undefined)) {
    return yield* new DeployError({
      code: "SERVER_NOT_INITIALIZED",
      target: target.name,
      message: `${hostLabel(host)} has no p0deploy Traefik. Run \`p0deploy server init ${target.host}\`.`,
    });
  }
  const domains = resolveDomains(target, name, proxy);
  const labels = containerLabels({ app, target, container: name, domains, proxy });
  const routed = labels.includes("traefik.enable=true");

  const current = (yield* inspectContainers(engine, host, [name])).get(name) ?? null;
  const wasRunning = current?.status === "running";
  yield* runOn(host, removeContainerScript(engine, next));
  const stoppedOldFirst = wasRunning && target.ports.length > 0;
  if (stoppedOldFirst) {
    yield* shell.note(`${target.name}: stopping ${name} to free its ports`);
    yield* runOk(host, containerScript(engine, "stop", name), `stop ${name}`, target.name);
  }
  const restoreOld = stoppedOldFirst
    ? Effect.asVoid(runOn(host, containerScript(engine, "start", name)))
    : Effect.void;

  yield* shell.note(`${target.name}: starting ${image}`);
  const started = yield* shell.exec(
    onHost(
      host,
      runScript({
        engine,
        name: next,
        image,
        target,
        network: proxy ? PROXY_NETWORK : null,
        labels,
        forwardedEnv: forwarded.length > 0,
      }),
    ),
    forwarded.length > 0 ? { stdin: envFileContents(forwarded) } : {},
  );
  if (started.exitCode !== 0) {
    yield* runOn(host, removeContainerScript(engine, next));
    yield* restoreOld;
    return yield* commandFailed(host, `start ${image}`, started, target.name);
  }

  yield* shell.note(`${target.name}: waiting for health`);
  const healthy = yield* runOn(
    host,
    healthScript({ engine, container: next, health: target.health, port: target.port }),
  );
  if (healthy.exitCode !== 0) {
    const logs = yield* runOn(host, logsScript(engine, next, { tail: 30 }));
    yield* runOn(host, removeContainerScript(engine, next));
    yield* restoreOld;
    return yield* new DeployError({
      code: "HEALTH_CHECK_FAILED",
      target: target.name,
      message: `${image} did not become healthy on ${target.name}; ${
        wasRunning && current ? `kept ${current.image} running` : "nothing else was running"
      }`,
      output: tail(logs.stdout),
    });
  }

  if (current) {
    yield* runOn(host, removeContainerScript(engine, prev));
    if (wasRunning && !stoppedOldFirst) {
      yield* runOk(host, containerScript(engine, "stop", name), `stop ${name}`, target.name);
    }
    yield* runOn(host, setRestartScript(engine, name, "no"));
    yield* runOk(host, renameScript(engine, name, prev), `rename ${name}`, target.name);
  }
  yield* runOk(host, renameScript(engine, next, name), `rename ${next}`, target.name);

  const prunedImages = yield* prune(loaded, host, current ? [image, current.image] : [image]);
  const result: SwapResult = {
    target: target.name,
    host: hostLabel(host),
    container: name,
    image,
    previousImage: current?.image ?? null,
    urls: routed && proxy ? routeUrls(domains, proxy.mode) : [],
    stoppedOldFirst,
    prunedImages,
  };
  return result;
});

export const up = Effect.fn("p0deploy.up")(function* (
  loaded: LoadedConfig,
  options: BuildHostOverride & {
    readonly tag?: string | undefined;
    readonly targets?: ReadonlyArray<string> | undefined;
  } = {},
) {
  const targets = yield* selectTargets(loaded.config, options.targets ?? []);
  // A missing secret should stop the deploy before a slow build, not after.
  for (const target of targets) yield* resolveForwardedEnv(target);
  const built = yield* build(loaded, options);
  const source = {
    host: buildHostOf(loaded, options),
    image: built.image,
    imageId: built.imageId,
  };
  const results: Array<UpResult["targets"][number]> = [];
  for (const target of targets) {
    const transfer = yield* pushToTarget(loaded, source, target);
    const swapped = yield* swap(loaded, target, built.image);
    results.push({ ...swapped, transfer });
  }
  const result: UpResult = { build: built, targets: results };
  return result;
});

/** Swaps back to the image of `<container>-prev`, or to `<app>:<to>` from the kept tags. Rolling back twice rolls forward. */
export const rollback = Effect.fn("p0deploy.rollback")(function* (
  loaded: LoadedConfig,
  target: Target,
  options: { readonly to?: string | undefined } = {},
) {
  const { engine, app } = loaded.config;
  const host = hostFor(target.host);
  const name = containerName(loaded.config, target);
  let image: string;
  if (options.to !== undefined) {
    image = `${app}:${options.to}`;
  } else {
    const previous = (yield* inspectContainers(engine, host, [`${name}-prev`])).get(`${name}-prev`);
    if (!previous) {
      return yield* new DeployError({
        code: "NOTHING_TO_ROLLBACK",
        target: target.name,
        message: `${target.name} has no previous container. Use --to <tag>; \`p0deploy status\` lists kept tags.`,
      });
    }
    image = previous.image;
  }
  const present = yield* runOn(host, imageIdScript(engine, image));
  if (present.exitCode !== 0) {
    return yield* new DeployError({
      code: "IMAGE_NOT_FOUND",
      target: target.name,
      message: `${image} is not on ${target.name}. \`p0deploy status\` lists the kept tags.`,
    });
  }
  return yield* swap(loaded, target, image);
});

export const status = Effect.fn("p0deploy.status")(function* (
  loaded: LoadedConfig,
  target: Target,
) {
  const { engine, app } = loaded.config;
  const host = hostFor(target.host);
  const name = containerName(loaded.config, target);
  const proxy = yield* readProxy(engine, host, target.name);
  const containers = yield* inspectContainers(engine, host, [name, `${name}-prev`]);
  const images = yield* runOn(host, listImageTagsScript(engine, app));
  const domains = resolveDomains(target, name, proxy);
  const routed = proxy !== null && domains.length > 0 && target.port !== undefined;
  const result: TargetStatus = {
    target: target.name,
    host: hostLabel(host),
    container: name,
    urls: routed ? routeUrls(domains, proxy.mode) : [],
    current: containers.get(name) ?? null,
    previous: containers.get(`${name}-prev`) ?? null,
    images:
      images.exitCode === 0
        ? images.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && line !== "<none>")
        : [],
  };
  return result;
});

export const logs = Effect.fn("p0deploy.logs")(function* (
  loaded: LoadedConfig,
  target: Target,
  options: { readonly tail?: number | undefined; readonly since?: string | undefined } = {},
) {
  const host = hostFor(target.host);
  const name = containerName(loaded.config, target);
  const result = yield* runOk(
    host,
    logsScript(loaded.config.engine, name, { tail: options.tail ?? 100, since: options.since }),
    `read logs of ${name}`,
    target.name,
  );
  const logsResult: LogsResult = {
    target: target.name,
    host: hostLabel(host),
    container: name,
    logs: result.stdout,
  };
  return logsResult;
});

export const doctor = Effect.fn("p0deploy.doctor")(function* (
  loaded: LoadedConfig,
  options: BuildHostOverride & { readonly targets?: ReadonlyArray<string> | undefined } = {},
) {
  const { engine } = loaded.config;
  const shell = yield* Shell;
  const targets = yield* selectTargets(loaded.config, options.targets ?? []);
  const buildHost = buildHostOf(loaded, options);
  const checks: Array<DoctorCheck> = [];

  const hosts = new Map<string, { host: Host; needsProxy: boolean; deploysHere: boolean }>();
  hosts.set(hostLabel(buildHost), { host: buildHost, needsProxy: false, deploysHere: false });
  for (const target of targets) {
    const host = hostFor(target.host);
    const entry = hosts.get(hostLabel(host));
    hosts.set(hostLabel(host), {
      host,
      deploysHere: true,
      needsProxy:
        (entry?.needsProxy ?? false) ||
        target.domains.length > 0 ||
        target.health?.path !== undefined,
    });
  }

  if ([...hosts.values()].some(({ host }) => host.kind === "ssh")) {
    const ssh = yield* shell.exec(["ssh", "-V"]);
    checks.push({
      host: "local",
      check: "ssh",
      ok: ssh.exitCode === 0,
      required: true,
      detail: (ssh.stderr || ssh.stdout).trim() || "ssh not found",
    });
  }

  for (const [label, { host, needsProxy, deploysHere }] of hosts) {
    let probeHost = host;
    if (host.kind === "ssh") {
      const auth = yield* sshAuth(host.address);
      checks.push({
        host: label,
        check: "ssh-auth",
        ok: auth.auth !== "none",
        required: true,
        detail: describeAuth(auth, label),
      });
      if (auth.auth === "none") {
        checks.push({
          host: label,
          check: "ssh",
          ok: false,
          required: true,
          detail: `unreachable; run \`p0deploy ssh setup ${label}\``,
        });
        continue;
      }
      probeHost = { ...host, identity: auth.identity };
    }
    const probe = yield* runOn(probeHost, probeScript(engine));
    if (host.kind === "ssh") {
      const reachable = probe.exitCode !== SSH_CONNECTION_FAILED;
      checks.push({
        host: label,
        check: "ssh",
        ok: reachable,
        required: true,
        detail: reachable ? "reachable" : tail(probe.stderr) || "unreachable",
      });
      if (!reachable) continue;
    }
    const values = parseProbe(probe.stdout);
    checks.push({
      host: label,
      check: engine,
      ok: Boolean(values.engine),
      required: true,
      detail: values.engine ? `version ${values.engine}` : `${engine} missing or not running`,
    });
    checks.push({
      host: label,
      check: "zstd",
      ok: values.zstd === "yes",
      required: false,
      detail: values.zstd === "yes" ? "available" : "missing, transfers fall back to gzip",
    });
    if (deploysHere) {
      checks.push({
        host: label,
        check: "traefik",
        ok: values.proxy === "running",
        required: needsProxy,
        detail:
          values.proxy === "running"
            ? "running"
            : `${values.proxy || "not installed"}; run \`p0deploy server init ${label}\``,
      });
    }
  }

  if (buildHost.kind === "ssh") {
    for (const target of targets) {
      const host = hostFor(target.host);
      if (host.kind !== "ssh" || target.transfer === "relay" || sameHost(host, buildHost)) continue;
      const probe = yield* runOn(buildHost, directProbeScript(host.address));
      checks.push({
        host: buildHost.address,
        check: `direct-transfer:${target.name}`,
        ok: probe.exitCode === 0,
        required: target.transfer === "direct",
        detail:
          probe.exitCode === 0
            ? `can ssh to ${host.address}`
            : `cannot ssh to ${host.address}; images will go through this machine`,
      });
    }
  }

  const result: DoctorResult = {
    ok: checks.every((check) => check.ok || !check.required),
    checks,
  };
  return result;
});
