import * as Effect from "effect/Effect";

import {
  DEFAULT_TRAEFIK_IMAGE,
  PROXY_CONTAINER,
  appContainersScript,
  hostFor,
  hostLabel,
  imageIdScript,
  parseAppContainers,
  parseProxy,
  proxyInspectScript,
  proxyNetworkScript,
  pullScript,
  removeContainerScript,
  shellJoin,
  specOf,
  traefikRunArgv,
  type AppContainer,
  type ProxyState,
} from "./commands.ts";
import type { Engine, ServerMode } from "./config.ts";
import { commandFailed, runOk, runOn } from "./deploy.ts";
import { DeployError } from "./errors.ts";
import { Shell } from "./shell.ts";

export interface ServerInitOptions {
  /** ssh destination, or "local". */
  readonly host: string;
  readonly engine?: Engine | undefined;
  readonly mode?: ServerMode | undefined;
  readonly email?: string | undefined;
  /** `apps.example.com` or `*.apps.example.com`. */
  readonly appsDomain?: string | undefined;
  readonly image?: string | undefined;
}

export interface ServerInitResult {
  readonly host: string;
  readonly mode: ServerMode;
  readonly appsDomain: string | null;
  readonly container: string;
  readonly image: string;
  readonly action: "created" | "updated" | "unchanged";
}

export interface ServerStatus {
  readonly host: string;
  readonly proxy: Omit<ProxyState, "spec"> | null;
  readonly apps: ReadonlyArray<AppContainer>;
}

/** Installs or updates the host's single Traefik container. Safe to rerun: unchanged settings and image leave it running. */
export const serverInit = Effect.fn("p0deploy.serverInit")(function* (options: ServerInitOptions) {
  const shell = yield* Shell;
  const engine = options.engine ?? "docker";
  const mode = options.mode ?? "public";
  const image = options.image ?? DEFAULT_TRAEFIK_IMAGE;
  const host = hostFor(options.host);
  if (mode === "public" && !options.email) {
    return yield* new DeployError({
      code: "CONFIG_INVALID",
      message: "public mode needs an email for Let's Encrypt (--email or server.email)",
    });
  }
  const appsDomain = options.appsDomain?.replace(/^\*\./u, "") ?? null;
  const argv = traefikRunArgv({ engine, mode, email: options.email ?? null, appsDomain, image });

  yield* runOk(host, proxyNetworkScript(engine), "create the p0deploy network and volume");
  yield* shell.note(`${hostLabel(host)}: pulling ${image}`);
  yield* runOk(host, pullScript(engine, image), `pull ${image}`);
  const imageId = (yield* runOk(
    host,
    imageIdScript(engine, image),
    `inspect ${image}`,
  )).stdout.trim();
  const current = parseProxy((yield* runOn(host, proxyInspectScript(engine))).stdout);

  const base = { host: hostLabel(host), mode, appsDomain, container: PROXY_CONTAINER, image };
  if (
    current &&
    current.spec === specOf(argv) &&
    current.imageId === imageId &&
    current.status === "running"
  ) {
    const unchanged: ServerInitResult = { ...base, action: "unchanged" };
    return unchanged;
  }
  yield* runOn(host, removeContainerScript(engine, PROXY_CONTAINER));
  const started = yield* runOn(host, shellJoin(argv));
  if (started.exitCode !== 0) return yield* commandFailed(host, "start Traefik", started);
  const result: ServerInitResult = { ...base, action: current ? "updated" : "created" };
  return result;
});

export const serverStatus = Effect.fn("p0deploy.serverStatus")(function* (options: {
  readonly host: string;
  readonly engine?: Engine | undefined;
}) {
  const engine = options.engine ?? "docker";
  const host = hostFor(options.host);
  const proxy = parseProxy(
    (yield* runOk(host, proxyInspectScript(engine), "inspect Traefik")).stdout,
  );
  const apps = parseAppContainers(
    (yield* runOk(host, appContainersScript(engine), "list app containers")).stdout,
  );
  const result: ServerStatus = {
    host: hostLabel(host),
    proxy: proxy && {
      mode: proxy.mode,
      appsDomain: proxy.appsDomain,
      imageId: proxy.imageId,
      status: proxy.status,
    },
    apps,
  };
  return result;
});
