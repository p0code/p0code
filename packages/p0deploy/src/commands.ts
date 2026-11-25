import type { Engine, HealthCheck, ServerMode, Target } from "./config.ts";

/** Pure builders for every argv and remote script p0deploy runs, so tests can pin them exactly. */

export type Argv = ReadonlyArray<string>;

export type Host =
  | { readonly kind: "local" }
  | {
      readonly kind: "ssh";
      readonly address: string;
      /** Private key to offer first. null means only ~/.ssh/config and the agent; undefined inherits the shell's key. */
      readonly identity?: string | null | undefined;
    };

export const LOCAL_HOST: Host = { kind: "local" };

export const hostFor = (address: string | undefined, identity?: string | null): Host =>
  address === undefined || address === "local"
    ? LOCAL_HOST
    : { kind: "ssh", address, ...(identity === undefined ? {} : { identity }) };

/** Adds the install's deploy key unless the caller already decided which identity to use (null: none). */
export const withIdentity = (host: Host, identity: string | undefined): Host =>
  host.kind === "ssh" && host.identity === undefined ? { ...host, identity } : host;

export const hostLabel = (host: Host): string => (host.kind === "local" ? "local" : host.address);

// BatchMode keeps ssh from ever prompting: an agent has no one to answer.
export const SSH_OPTIONS: Argv = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
];

// Setup connects record a new host key once; scripted ones also stay in BatchMode.
export const SSH_BOOTSTRAP_OPTIONS: Argv = [
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
  "-o",
  "StrictHostKeyChecking=accept-new",
];

/** ssh's exit status when the connection itself failed. */
export const SSH_CONNECTION_FAILED = 255;

const SAFE_ARG = /^[\w@%+=:,./-]+$/u;

export const quoteArg = (value: string): string =>
  SAFE_ARG.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

export const shellJoin = (argv: Argv): string => argv.map(quoteArg).join(" ");

/** Offers the install's key first; config aliases and the agent still work for every other identity. */
export const identityOptions = (identity: string | null | undefined): Argv =>
  identity ? ["-i", identity, "-o", "IdentitiesOnly=yes"] : [];

export const sshArgv = (address: string, script: string, identity?: string | null): Argv => [
  "ssh",
  ...SSH_OPTIONS,
  ...identityOptions(identity),
  address,
  script,
];

/** Used only while setting a key up. BatchMode is on unless the caller is about to answer with askpass. */
export const sshBootstrapArgv = (
  address: string,
  script: string,
  identity?: string | null,
  options: { readonly batchMode?: boolean | undefined } = {},
): Argv => [
  "ssh",
  ...(options.batchMode === false ? [] : ["-o", "BatchMode=yes"]),
  ...SSH_BOOTSTRAP_OPTIONS,
  ...identityOptions(identity),
  address,
  script,
];

/** Runs a POSIX sh script on a host: through `sh -c` locally, or as ssh's remote command. */
export const onHost = (host: Host, script: string): Argv =>
  host.kind === "local" ? ["sh", "-c", script] : sshArgv(host.address, script, host.identity);

// `set -o pipefail` is missing from old dash, where a failing special builtin would end the script.
const PIPEFAIL = "(set -o pipefail) 2>/dev/null && set -o pipefail";

export type Codec = "zstd" | "gzip";

export const codecProbeScript = "command -v zstd >/dev/null 2>&1 && echo zstd || echo gzip";

export const parseCodec = (stdout: string): Codec => (stdout.trim() === "zstd" ? "zstd" : "gzip");

const compressCommand = (codec: Codec) => (codec === "zstd" ? "zstd -q -c -T0" : "gzip -c");
const decompressCommand = (codec: Codec) => (codec === "zstd" ? "zstd -q -d -c" : "gzip -d -c");

export const imageIdScript = (engine: Engine, ref: string): string =>
  shellJoin([engine, "image", "inspect", "--format", "{{.Id}}", ref]);

export const tagScript = (engine: Engine, source: string, image: string): string =>
  shellJoin([engine, "tag", source, image]);

export const saveScript = (engine: Engine, image: string, codec: Codec): string =>
  `${PIPEFAIL}; ${shellJoin([engine, "save", image])} | ${compressCommand(codec)}`;

export const loadScript = (engine: Engine, codec: Codec): string =>
  `${PIPEFAIL}; ${decompressCommand(codec)} | ${engine} load`;

/** Streams the image from the build host straight to the target over the build host's own ssh. */
export const directTransferScript = (
  engine: Engine,
  image: string,
  codec: Codec,
  targetAddress: string,
): string =>
  `${saveScript(engine, image, codec)} | ${shellJoin(sshArgv(targetAddress, loadScript(engine, codec)))}`;

export const directProbeScript = (targetAddress: string): string =>
  shellJoin(sshArgv(targetAddress, "true"));

export interface BuildSpec {
  readonly engine: Engine;
  readonly image: string;
  readonly dockerfile: string;
  readonly context: string;
  readonly args: Readonly<Record<string, string>>;
  readonly platform?: string | undefined;
}

const buildFlags = (spec: Omit<BuildSpec, "context">): Argv => [
  "build",
  "-t",
  spec.image,
  "-f",
  spec.dockerfile,
  ...(spec.platform ? ["--platform", spec.platform] : []),
  ...Object.entries(spec.args).flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]),
];

export const localBuildArgv = (spec: BuildSpec): Argv => [
  spec.engine,
  ...buildFlags(spec),
  spec.context,
];

/** Unpacks the context tar from stdin into a temp dir on the build host and builds there. */
export const remoteBuildScript = (spec: Omit<BuildSpec, "context">): string =>
  [
    "set -e",
    "d=$(mktemp -d)",
    `trap 'rm -rf "$d"' EXIT`,
    'tar -x -C "$d"',
    `cd "$d" && ${shellJoin([spec.engine, ...buildFlags(spec), "."])}`,
  ].join("\n");

/** COPYFILE_DISABLE keeps macOS tar from adding AppleDouble `._*` files. */
export const contextTarArgv = (contextDir: string, dockerignore: string | null): Argv => [
  "env",
  "COPYFILE_DISABLE=1",
  "tar",
  "-c",
  "--exclude=.git",
  ...(dockerignore ? ["-X", dockerignore] : []),
  "-C",
  contextDir,
  ".",
];

export const PROXY_CONTAINER = "p0deploy-traefik";
export const PROXY_NETWORK = "p0deploy";
export const ACME_VOLUME = "p0deploy-acme";
export const CERT_RESOLVER = "letsencrypt";
export const DEFAULT_TRAEFIK_IMAGE = "traefik:v3";

/** What `server init` recorded on the Traefik container; deploys read it instead of a config file. */
export interface ProxyInfo {
  readonly mode: ServerMode;
  readonly appsDomain: string | null;
}

export const routerName = (container: string): string => container.replace(/[^A-Za-z0-9-]/gu, "-");

export const resolveDomains = (
  target: Target,
  container: string,
  proxy: ProxyInfo | null,
): ReadonlyArray<string> => {
  if (target.domains.length > 0) return target.domains;
  if (proxy?.appsDomain) return [`${container}.${proxy.appsDomain.replace(/^\*\./u, "")}`];
  return [];
};

export const routeUrls = (
  domains: ReadonlyArray<string>,
  mode: ServerMode,
): ReadonlyArray<string> =>
  domains.map((domain) => `${mode === "public" ? "https" : "http"}://${domain}`);

export interface LabelSpec {
  readonly app: string;
  readonly target: Target;
  readonly container: string;
  readonly domains: ReadonlyArray<string>;
  readonly proxy: ProxyInfo | null;
}

/**
 * The old and new container carry identical labels, so during a swap Traefik
 * load-balances across both and drops the old one when it stops.
 */
export const containerLabels = (spec: LabelSpec): ReadonlyArray<string> => {
  const labels = [`p0deploy.app=${spec.app}`, `p0deploy.target=${spec.target.name}`];
  const port = spec.target.port;
  if (spec.proxy === null || spec.domains.length === 0 || port === undefined) return labels;
  const service = routerName(spec.container);
  const rule = spec.domains.map((domain) => `Host(\`${domain}\`)`).join(" || ");
  const router = (name: string, entrypoint: string, tls: "none" | "acme" | "self-signed") => [
    `traefik.http.routers.${name}.rule=${rule}`,
    `traefik.http.routers.${name}.entrypoints=${entrypoint}`,
    `traefik.http.routers.${name}.service=${service}`,
    ...(tls === "none" ? [] : [`traefik.http.routers.${name}.tls=true`]),
    ...(tls === "acme" ? [`traefik.http.routers.${name}.tls.certresolver=${CERT_RESOLVER}`] : []),
  ];
  labels.push(
    `p0deploy.domains=${spec.domains.join(",")}`,
    "traefik.enable=true",
    `traefik.docker.network=${PROXY_NETWORK}`,
    ...(spec.proxy.mode === "public"
      ? router(service, "websecure", "acme")
      : spec.proxy.mode === "tunnel"
        ? router(service, "web", "none")
        : [
            ...router(service, "web", "none"),
            ...router(`${service}-tls`, "websecure", "self-signed"),
          ]),
    `traefik.http.services.${service}.loadbalancer.server.port=${port}`,
  );
  const health = spec.target.health;
  if (health?.path !== undefined) {
    labels.push(
      `traefik.http.services.${service}.loadbalancer.healthcheck.path=${health.path}`,
      `traefik.http.services.${service}.loadbalancer.healthcheck.interval=${health.intervalSeconds}s`,
    );
  }
  return labels;
};

export interface RunSpec {
  readonly engine: Engine;
  readonly name: string;
  readonly image: string;
  readonly target: Target;
  /** The proxy network when the host runs p0deploy's Traefik. */
  readonly network: string | null;
  readonly labels: ReadonlyArray<string>;
  /** When true the script reads `NAME=value` lines from stdin into a private temp env file. */
  readonly forwardedEnv: boolean;
}

export const runArgv = (spec: Omit<RunSpec, "forwardedEnv" | "image">): Argv => {
  const health = spec.target.health;
  return [
    spec.engine,
    "run",
    "-d",
    "--name",
    spec.name,
    "--restart",
    spec.target.restart,
    ...(spec.network ? ["--network", spec.network] : []),
    ...spec.target.ports.flatMap((port) => ["-p", port]),
    ...spec.target.volumes.flatMap((volume) => ["-v", volume]),
    ...(spec.target.envFile ? ["--env-file", spec.target.envFile] : []),
    ...spec.labels.flatMap((label) => ["--label", label]),
    ...(health?.cmd
      ? [
          "--health-cmd",
          health.cmd,
          "--health-interval",
          `${health.intervalSeconds}s`,
          "--health-retries",
          "3",
        ]
      : []),
  ];
};

export const runScript = (spec: RunSpec): string => {
  const head = shellJoin(runArgv(spec));
  if (!spec.forwardedEnv) return `${head} ${quoteArg(spec.image)}`;
  return [
    "set -e",
    "umask 077",
    "f=$(mktemp)",
    `trap 'rm -f "$f"' EXIT`,
    'cat > "$f"',
    `${head} --env-file "$f" ${quoteArg(spec.image)}`,
  ].join("\n");
};

export const envFileContents = (values: ReadonlyArray<readonly [string, string]>): string =>
  values.map(([name, value]) => `${name}=${value}\n`).join("");

const DEFAULT_HEALTH = { timeoutSeconds: 60, intervalSeconds: 2 };

/**
 * One remote loop instead of one ssh round trip per attempt. The container must
 * be running, healthy if it has a Docker HEALTHCHECK (health.cmd or the image's),
 * and answer health.path when fetched from the Traefik container. With no health
 * signal at all it only has to survive a short grace period.
 */
export const healthScript = (input: {
  readonly engine: Engine;
  readonly container: string;
  readonly health: HealthCheck | undefined;
  readonly port: number | undefined;
}): string => {
  const { engine, container, health } = input;
  const timing = health ?? DEFAULT_HEALTH;
  const state = `${shellJoin([
    engine,
    "container",
    "inspect",
    "--format",
    "{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{end}}",
    container,
  ])} 2>/dev/null`;
  const pathCheck =
    health?.path !== undefined && input.port !== undefined
      ? `${shellJoin([
          engine,
          "exec",
          PROXY_CONTAINER,
          "wget",
          "-q",
          "-O",
          "/dev/null",
          "-T",
          "5",
          `http://${container}:${input.port}${health.path}`,
        ])} >/dev/null 2>&1`
      : "true";
  const attempts = Math.max(1, Math.ceil(timing.timeoutSeconds / timing.intervalSeconds));
  return [
    ...(health?.path === undefined && health?.cmd === undefined ? ["sleep 2"] : []),
    "n=0",
    "while :; do",
    `  s=$(${state})`,
    '  case "$s" in',
    `    "true healthy"|"true ") if ${pathCheck}; then exit 0; fi ;;`,
    '    "true "*) ;;',
    "    *) exit 1 ;;",
    "  esac",
    "  n=$((n+1))",
    `  [ "$n" -ge ${attempts} ] && exit 1`,
    `  sleep ${timing.intervalSeconds}`,
    "done",
  ].join("\n");
};

export const INSPECT_FORMAT = "{{.Name}}|{{.Config.Image}}|{{.State.Status}}|{{.State.StartedAt}}";

export const inspectContainersScript = (engine: Engine, names: ReadonlyArray<string>): string =>
  `for n in ${names.map(quoteArg).join(" ")}; do ${engine} container inspect --format ${quoteArg(INSPECT_FORMAT)} "$n" 2>/dev/null; done; true`;

export interface ContainerInfo {
  readonly name: string;
  readonly image: string;
  readonly status: string;
  readonly startedAt: string;
}

export const parseContainers = (stdout: string): ReadonlyMap<string, ContainerInfo> => {
  const containers = new Map<string, ContainerInfo>();
  for (const line of stdout.split("\n")) {
    const [rawName, image, status, startedAt] = line.trim().split("|");
    if (!rawName || image === undefined || status === undefined) continue;
    const name = rawName.replace(/^\//u, "");
    containers.set(name, { name, image, status, startedAt: startedAt ?? "" });
  }
  return containers;
};

export const listImageTagsScript = (engine: Engine, app: string): string =>
  shellJoin([engine, "images", "--format", "{{.Tag}}", app]);

/** Tags beyond the newest `keep`, skipping any a container still uses. Input is newest first. */
export const tagsToPrune = (
  tags: ReadonlyArray<string>,
  keep: number,
  inUse: ReadonlySet<string>,
): ReadonlyArray<string> =>
  tags
    .filter((tag) => tag.length > 0 && tag !== "<none>")
    .slice(keep)
    .filter((tag) => !inUse.has(tag));

export const removeImagesScript = (engine: Engine, images: ReadonlyArray<string>): string =>
  `${shellJoin([engine, "rmi", ...images])} >/dev/null 2>&1 || true`;

export const containerScript = (engine: Engine, verb: "start" | "stop", name: string): string =>
  shellJoin([engine, verb, name]);

export const removeContainerScript = (engine: Engine, name: string): string =>
  `${shellJoin([engine, "rm", "-f", name])} >/dev/null 2>&1 || true`;

export const renameScript = (engine: Engine, from: string, to: string): string =>
  shellJoin([engine, "rename", from, to]);

// Older podman has no `update --restart`; the policy then stays as it was.
export const setRestartScript = (engine: Engine, name: string, policy: Target["restart"]): string =>
  `${shellJoin([engine, "update", "--restart", policy, name])} >/dev/null 2>&1 || true`;

export const logsScript = (
  engine: Engine,
  name: string,
  options: { readonly tail: number; readonly since?: string | undefined },
): string =>
  `${shellJoin([
    engine,
    "logs",
    "--tail",
    String(options.tail),
    ...(options.since ? ["--since", options.since] : []),
    name,
  ])} 2>&1`;

export const probeScript = (engine: Engine): string =>
  [
    `echo "engine=$(${
      engine === "docker"
        ? shellJoin(["docker", "info", "--format", "{{.ServerVersion}}"])
        : shellJoin(["podman", "info", "--format", "{{.Version.Version}}"])
    } 2>/dev/null)"`,
    "command -v zstd >/dev/null 2>&1 && echo zstd=yes || echo zstd=no",
    `echo "proxy=$(${shellJoin([engine, "container", "inspect", "--format", "{{.State.Status}}", PROXY_CONTAINER])} 2>/dev/null)"`,
  ].join("\n");

export const parseProbe = (stdout: string): Readonly<Record<string, string>> => {
  const values: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return values;
};

export interface ProxySpec {
  readonly engine: Engine;
  readonly mode: ServerMode;
  /** Required in public mode, for Let's Encrypt. */
  readonly email: string | null;
  readonly appsDomain: string | null;
  readonly image: string;
}

const DOCKER_SOCKET: Record<Engine, string> = {
  docker: "/var/run/docker.sock",
  // Rootful podman's Docker-compatible API; needs `systemctl enable --now podman.socket`.
  podman: "/run/podman/podman.sock",
};

export const traefikArgs = (spec: ProxySpec): Argv => {
  const args = [
    "--providers.docker=true",
    "--providers.docker.exposedbydefault=false",
    `--providers.docker.network=${PROXY_NETWORK}`,
    "--entrypoints.web.address=:80",
  ];
  if (spec.mode === "tunnel") {
    // TLS ends at the tunnel, which also sets X-Forwarded-*; only it can reach 127.0.0.1:80.
    args.push("--entrypoints.web.forwardedheaders.insecure=true");
    return args;
  }
  args.push("--entrypoints.websecure.address=:443");
  if (spec.mode === "public") {
    args.push(
      "--entrypoints.web.http.redirections.entrypoint.to=websecure",
      "--entrypoints.web.http.redirections.entrypoint.scheme=https",
      `--certificatesresolvers.${CERT_RESOLVER}.acme.email=${spec.email ?? ""}`,
      `--certificatesresolvers.${CERT_RESOLVER}.acme.storage=/acme/acme.json`,
      `--certificatesresolvers.${CERT_RESOLVER}.acme.httpchallenge.entrypoint=web`,
    );
  }
  return args;
};

const proxyPorts = (mode: ServerMode): Argv =>
  mode === "tunnel" ? ["-p", "127.0.0.1:80:80"] : ["-p", "80:80", "-p", "443:443"];

/** Small stable fingerprint of the Traefik settings, so `server init` can skip a needless restart. */
export const fingerprint = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

export const traefikRunArgv = (spec: ProxySpec): Argv => {
  const body = [
    "--restart",
    "unless-stopped",
    "--network",
    PROXY_NETWORK,
    ...proxyPorts(spec.mode),
    "-v",
    `${DOCKER_SOCKET[spec.engine]}:/var/run/docker.sock:ro`,
    "-v",
    `${ACME_VOLUME}:/acme`,
    "--label",
    `p0deploy.mode=${spec.mode}`,
    "--label",
    `p0deploy.apps-domain=${spec.appsDomain ?? ""}`,
  ];
  const command = [spec.image, ...traefikArgs(spec)];
  return [
    spec.engine,
    "run",
    "-d",
    "--name",
    PROXY_CONTAINER,
    ...body,
    "--label",
    `p0deploy.spec=${fingerprint(JSON.stringify([...body, ...command]))}`,
    ...command,
  ];
};

export const proxyNetworkScript = (engine: Engine): string =>
  [
    `${shellJoin([engine, "network", "inspect", PROXY_NETWORK])} >/dev/null 2>&1 || ${shellJoin([engine, "network", "create", PROXY_NETWORK])} >/dev/null`,
    `${shellJoin([engine, "volume", "inspect", ACME_VOLUME])} >/dev/null 2>&1 || ${shellJoin([engine, "volume", "create", ACME_VOLUME])} >/dev/null`,
  ].join("\n");

export const pullScript = (engine: Engine, image: string): string =>
  shellJoin([engine, "pull", "-q", image]);

const PROXY_FORMAT =
  '{{index .Config.Labels "p0deploy.mode"}}|{{index .Config.Labels "p0deploy.apps-domain"}}|{{index .Config.Labels "p0deploy.spec"}}|{{.Image}}|{{.State.Status}}';

export const proxyInspectScript = (engine: Engine): string =>
  `${shellJoin([engine, "container", "inspect", "--format", PROXY_FORMAT, PROXY_CONTAINER])} 2>/dev/null || true`;

export interface ProxyState extends ProxyInfo {
  readonly spec: string;
  readonly imageId: string;
  readonly status: string;
}

export const parseProxy = (stdout: string): ProxyState | null => {
  const [mode, appsDomain, spec, imageId, status] = stdout.trim().split("|");
  if (mode !== "public" && mode !== "tunnel" && mode !== "lan") return null;
  return {
    mode,
    appsDomain: appsDomain ? appsDomain : null,
    spec: spec ?? "",
    imageId: imageId ?? "",
    status: status ?? "",
  };
};

export const specOf = (argv: Argv): string =>
  argv.find((arg) => arg.startsWith("p0deploy.spec="))?.slice("p0deploy.spec=".length) ?? "";

const APP_FORMAT =
  '{{.Name}}|{{.Config.Image}}|{{.State.Status}}|{{index .Config.Labels "p0deploy.app"}}|{{index .Config.Labels "p0deploy.target"}}|{{index .Config.Labels "p0deploy.domains"}}';

export const appContainersScript = (engine: Engine): string =>
  `for n in $(${shellJoin([engine, "ps", "-a", "--filter", "label=p0deploy.app", "--format", "{{.Names}}"])}); do ${shellJoin([engine, "container", "inspect", "--format", APP_FORMAT])} "$n" 2>/dev/null; done; true`;

export interface AppContainer {
  readonly name: string;
  readonly image: string;
  readonly status: string;
  readonly app: string;
  readonly target: string;
  readonly domains: ReadonlyArray<string>;
}

export const parseAppContainers = (stdout: string): ReadonlyArray<AppContainer> =>
  stdout
    .split("\n")
    .map((line) => line.trim().split("|"))
    .flatMap(([name, image, status, app, target, domains]) =>
      name && image !== undefined && status !== undefined
        ? [
            {
              name: name.replace(/^\//u, ""),
              image,
              status,
              app: app ?? "",
              target: target ?? "",
              domains: domains ? domains.split(",") : [],
            },
          ]
        : [],
    );
