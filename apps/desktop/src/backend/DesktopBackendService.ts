import {
  DesktopBackendBootstrap,
  type DesktopBackendAction,
  type DesktopBackendConfigUpdate,
  type DesktopBackendMode,
  type DesktopBackendStatus,
} from "@t3tools/contracts";
import {
  DESKTOP_READINESS_CHALLENGE_PARAM,
  DESKTOP_READINESS_PROOF_PATH,
  isValidDesktopReadinessProof,
} from "@t3tools/shared/desktopReadinessProof";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopCliShim from "../app/DesktopCliShim.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";

const DEFAULT_SERVICE_HOST = "127.0.0.1";
const DEFAULT_SERVICE_PORT = 3773;
const HEALTHZ_PATH = "/healthz";
const LEGACY_HEALTH_PATH = "/.well-known/t3/environment";
const HEALTH_PROBE_TIMEOUT = Duration.seconds(1);
const SERVICE_START_WAIT_TIMEOUT = Duration.seconds(30);
const SERVICE_START_POLL_INTERVAL = Duration.millis(200);
const COMMAND_TIMEOUT = Duration.seconds(15);
// p0d gives its Node sidecar up to 10 seconds to stop before it exits itself.
const P0D_STOP_GRACE = Duration.seconds(15);
const P0D_OUTPUT_TAIL_BYTES = 4_000;
const P0D_LOG_ROTATE_BYTES = 10 * 1024 * 1024;
const P0D_READY_FILE_NAME = "p0d-ready.json";
const P0D_DESKTOP_SECRET_FILE = ["secrets", "desktop-bootstrap-secret"] as const;
const P0D_LOG_FILE = ["logs", "p0d.log"] as const;
const LEGACY_SERVICE_READY_FILE_NAME = "p0d-legacy-service.json";
const LEGACY_SERVICE_SECRETS_FILE_NAME = "p0d-legacy-service-secrets.json";

const { logInfo: logServiceInfo, logWarning: logServiceWarning } =
  DesktopObservability.makeComponentLogger("desktop-backend-service");

export class BackendServiceDriverError extends Schema.TaggedError<BackendServiceDriverError>()(
  "BackendServiceDriverError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export interface BackendReadyFileData {
  readonly pid: number | null;
  readonly port: number | null;
  readonly url: string | null;
  readonly version?: string | null;
}

export interface ParsedP0dServiceStatus {
  readonly running: boolean;
  readonly installed: boolean;
  readonly pid: number | null;
  readonly port: number | null;
  readonly url: string | null;
  readonly version: string | null;
}

export interface BackendServiceInfo {
  readonly running: boolean;
  readonly installed: boolean;
  readonly pid: number | null;
  readonly version: string | null;
  readonly url: URL | null;
  readonly binaryPath: string | null;
  readonly managedByService: boolean;
  readonly driverKind: "p0d" | "legacy-node";
}

/**
 * Pluggable interface for running a decoupled local backend service.
 * Implemented by `p0d` (user service via launchd/systemd/Task Scheduler) and by the
 * legacy Node server fallback so both share the exact same attach/start/stop/restart lifecycle.
 */
export interface BackendServiceDriver {
  readonly kind: "p0d" | "legacy-node";
  readonly binaryPath: string | null;
  /** Derives the desktop's sign-in tokens; null when the service cannot accept them. */
  readonly desktopBootstrapSecret: string | null;
  /** Why this driver can never start, e.g. no p0d binary was found. */
  readonly unavailableReason: string | null;
  readonly status: Effect.Effect<BackendServiceInfo>;
  readonly ensureRunning: Effect.Effect<BackendServiceInfo, BackendServiceDriverError>;
  readonly start: Effect.Effect<BackendServiceInfo, BackendServiceDriverError>;
  readonly stop: Effect.Effect<void, BackendServiceDriverError>;
  readonly restart: Effect.Effect<BackendServiceInfo, BackendServiceDriverError>;
  /** Completes with a reason when a backend this app started exits; never for one it attached to. */
  readonly exited: Effect.Effect<string>;
}

const ReadyFileSchema = Schema.Struct({
  pid: Schema.optional(Schema.NullOr(Schema.Number)),
  port: Schema.optional(Schema.NullOr(Schema.Number)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  version: Schema.optional(Schema.NullOr(Schema.String)),
});

const P0dServiceStatusJsonSchema = Schema.Struct({
  running: Schema.optional(Schema.Boolean),
  installed: Schema.optional(Schema.Boolean),
  status: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  pid: Schema.optional(Schema.NullOr(Schema.Number)),
  port: Schema.optional(Schema.NullOr(Schema.Number)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  version: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeReadyFileJson = Schema.decodeUnknownOption(Schema.fromJsonString(ReadyFileSchema));
const encodeReadyFileJson = Schema.encodeEffect(Schema.fromJsonString(ReadyFileSchema));
const decodeStatusJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(P0dServiceStatusJsonSchema),
);

export function isExternalBackendMode(mode: DesktopBackendMode): boolean {
  return mode === "local-service" || mode === "remote";
}

/**
 * Adopts a local service that answers for this home, so a recovered catalog still finds its
 * projects instead of starting an embedded backend that would only lose the home lock.
 */
export const adoptRunningLocalService = Effect.fn(
  "desktop.backendService.adoptRunningLocalService",
)(function* (input: {
  readonly driver: BackendServiceDriver;
  readonly settings: Pick<DesktopAppSettings.DesktopSettings, "backendMode">;
  readonly setMode: (mode: DesktopBackendMode) => Effect.Effect<boolean>;
}): Effect.fn.Return<boolean> {
  const info = yield* input.driver.status;
  if (!info.running || info.url === null) {
    yield* logServiceInfo("no running local backend service to reattach after catalog recovery", {
      driverKind: input.driver.kind,
    });
    return false;
  }
  if (input.settings.backendMode === "local-service") {
    return true;
  }
  yield* logServiceInfo("reattaching the running local backend service", {
    driverKind: input.driver.kind,
    url: info.url.href,
  });
  return yield* input.setMode("local-service");
});

/**
 * p0d is the backend unless the user explicitly picked another mode. The legacy Node backend
 * ("embedded") is only an escape hatch: it is never chosen for the user.
 */
export function resolveEffectiveBackendMode(
  settings: Pick<DesktopAppSettings.DesktopSettings, "backendMode" | "backendModeConfiguredByUser">,
): DesktopBackendMode {
  if (settings.backendModeConfiguredByUser) {
    return settings.backendMode;
  }
  return DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS.backendMode;
}

function p0dBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "p0d.exe" : "p0d";
}

/** The `<goos>-<goarch>` folder apps/p0d/scripts/build.sh writes for this host. */
function p0dDistTarget(platform: NodeJS.Platform, arch: string): string {
  const goos = platform === "win32" ? "windows" : platform;
  const goarch = arch === "x64" ? "amd64" : arch;
  return `${goos}-${goarch}`;
}

export function p0dBinaryCandidates(input: {
  readonly path: Pick<Path.Path, "join">;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly rootDir: string;
  readonly homeDirectory: string;
  readonly configuredBinaryPath: string | null;
  readonly pathEnv: string | undefined;
}): readonly string[] {
  const candidates: string[] = [];
  const pushUnique = (candidate: string) => {
    const trimmed = candidate.trim();
    if (trimmed.length > 0 && !candidates.includes(trimmed)) {
      candidates.push(trimmed);
    }
  };
  const binaryName = p0dBinaryName(input.platform);

  // The bundled binary is built from this app's commit, so it always speaks its protocol.
  pushUnique(input.path.join(input.resourcesPath, "p0d", binaryName));
  if (input.configuredBinaryPath) {
    pushUnique(input.configuredBinaryPath);
  }
  pushUnique(input.path.join(input.homeDirectory, ".p0code", "bin", binaryName));
  if (!input.isPackaged) {
    pushUnique(
      input.path.join(
        input.rootDir,
        "apps",
        "p0d",
        "dist",
        p0dDistTarget(input.platform, input.arch),
        binaryName,
      ),
    );
  }
  const delimiter = input.platform === "win32" ? ";" : ":";
  for (const directory of (input.pathEnv ?? "").split(delimiter)) {
    if (directory.trim().length > 0) {
      pushUnique(input.path.join(directory, binaryName));
    }
  }
  return candidates;
}

/** The Node server's own launch arguments, shared by the in-app backend and p0d's sidecar. */
export function nodeServerArgs(input: {
  readonly isPackaged: boolean;
  readonly compileCachePath: string;
  readonly entryPath: string;
}): readonly string[] {
  return [
    "--title=p0code-backend",
    // Packaged builds have a separate cache; --require prevents cache settings leaking to provider subprocesses.
    ...(input.isPackaged ? ["--require", input.compileCachePath] : []),
    input.entryPath,
  ];
}

/** Quotes for p0d's `--legacy-server` splitter: inside double quotes only \" and \\ escape. */
function formatLegacyServerCommand(argv: ReadonlyArray<string>): string {
  return argv.map((arg) => `"${arg.replace(/["\\]/g, (char) => `\\${char}`)}"`).join(" ");
}

/**
 * The command p0d runs to start its lazy Node sidecar. Web mode, because a desktop-mode server
 * expects this GUI's control fds; p0d appends --host, --port and --base-dir.
 */
export function p0dLegacyServerCommand(input: {
  readonly executablePath: string;
  readonly isPackaged: boolean;
  readonly compileCachePath: string;
  readonly entryPath: string;
}): string {
  return formatLegacyServerCommand([
    input.executablePath,
    ...nodeServerArgs(input),
    "--mode",
    "web",
    "--no-browser",
  ]);
}

export function parseReadyFile(raw: string): BackendReadyFileData | null {
  const decoded = decodeReadyFileJson(raw.trim());
  if (Option.isNone(decoded)) {
    return null;
  }
  const value = decoded.value;
  const pid =
    typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0
      ? value.pid
      : null;
  const port =
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    value.port > 0 &&
    value.port <= 65_535
      ? value.port
      : null;
  const normalizedUrl = DesktopAppSettings.normalizeBackendRemoteUrl(value.url ?? null);
  const url = normalizedUrl ?? (port !== null ? `http://${DEFAULT_SERVICE_HOST}:${port}` : null);
  const version =
    typeof value.version === "string" && value.version.trim().length > 0
      ? value.version.trim()
      : null;
  if (pid === null && port === null && url === null) {
    return null;
  }
  return { pid, port, url, version };
}

export function parseP0dVersion(output: string): string | null {
  const firstLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return null;
  return firstLine.replace(/^p0d\s+/i, "").trim() || null;
}

export function parseP0dServiceStatus(output: string): ParsedP0dServiceStatus {
  const trimmed = output.trim();
  const decodedJson = decodeStatusJson(trimmed);
  if (Option.isSome(decodedJson)) {
    const value = decodedJson.value;
    const stateText = (value.status ?? value.state ?? "").toLowerCase();
    const running = value.running ?? (stateText === "running" || stateText === "active");
    const installed =
      value.installed ??
      (running || (stateText !== "not-installed" && stateText !== "uninstalled"));
    const pid =
      typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0
        ? value.pid
        : null;
    const port =
      typeof value.port === "number" &&
      Number.isInteger(value.port) &&
      value.port > 0 &&
      value.port <= 65_535
        ? value.port
        : null;
    const normalizedUrl = DesktopAppSettings.normalizeBackendRemoteUrl(value.url ?? null);
    const url = normalizedUrl ?? (port !== null ? `http://${DEFAULT_SERVICE_HOST}:${port}` : null);
    const version =
      typeof value.version === "string" && value.version.trim().length > 0
        ? value.version.trim()
        : null;
    return { running, installed, pid, port, url, version };
  }

  const lower = trimmed.toLowerCase();
  const notInstalled =
    lower.includes("not installed") || lower.includes("uninstalled") || lower.includes("missing");
  const running =
    !notInstalled &&
    /\b(running|active|started|healthy)\b/i.test(trimmed) &&
    !/\b(not running|stopped|inactive|failed)\b/i.test(trimmed);
  const installed =
    !notInstalled && (running || /\b(installed|stopped|inactive|loaded)\b/i.test(trimmed));
  const pidMatch = /\bpid[:=\s]+(\d+)\b/i.exec(trimmed);
  const portMatch = /\bport[:=\s]+(\d+)\b/i.exec(trimmed);
  const urlMatch = /(https?:\/\/[^\s"'<>]+)/i.exec(trimmed);
  const versionMatch = /\bversion[:=\s]+([^\s,]+)/i.exec(trimmed);
  const pid = pidMatch ? Number.parseInt(pidMatch[1]!, 10) : null;
  const port = portMatch ? Number.parseInt(portMatch[1]!, 10) : null;
  const normalizedUrl = urlMatch ? DesktopAppSettings.normalizeBackendRemoteUrl(urlMatch[1]) : null;
  const url =
    normalizedUrl ??
    (port !== null && Number.isInteger(port) && port > 0 && port <= 65_535
      ? `http://${DEFAULT_SERVICE_HOST}:${port}`
      : null);
  return {
    running,
    installed,
    pid: pid !== null && Number.isInteger(pid) && pid > 0 ? pid : null,
    port: port !== null && Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null,
    url,
    version: versionMatch ? versionMatch[1]!.trim() : null,
  };
}

const collectText = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
    Effect.orElseSucceed(() => ""),
  );

interface CommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runShortCommand = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  executable: string,
  args: ReadonlyArray<string>,
  options?: { readonly cwd?: string; readonly env?: Record<string, string | undefined> },
): Effect.Effect<CommandOutput, BackendServiceDriverError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner
        .spawn(
          ChildProcess.make(executable, args, {
            ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
            ...(options?.env === undefined ? {} : { env: options.env }),
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new BackendServiceDriverError({
                operation: `${executable} ${args.join(" ")}`,
                message: `Failed to spawn ${executable}: ${cause.message}`,
                cause,
              }),
          ),
        );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectText(handle.stdout),
          collectText(handle.stderr),
          handle.exitCode.pipe(
            Effect.map(Number),
            Effect.mapError(
              (cause) =>
                new BackendServiceDriverError({
                  operation: `${executable} ${args.join(" ")}`,
                  message: `Failed waiting for ${executable}: ${cause.message}`,
                  cause,
                }),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );
      return { exitCode, stdout, stderr };
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: COMMAND_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new BackendServiceDriverError({
            operation: `${executable} ${args.join(" ")}`,
            message: `Timed out running ${executable} ${args.join(" ")}.`,
          }),
        ),
    }),
  );

export const probeBackendHealth = (
  httpClient: HttpClient.HttpClient,
  baseUrl: URL,
  options?: { readonly allowLegacyWellKnown?: boolean },
): Effect.Effect<boolean> => {
  const probePath = (pathname: string) =>
    httpClient.execute(HttpClientRequest.get(new URL(pathname, baseUrl))).pipe(
      Effect.map((response) => response.status >= 200 && response.status < 300),
      Effect.timeoutOption(HEALTH_PROBE_TIMEOUT),
      Effect.map((result) => Option.getOrElse(result, () => false)),
      Effect.orElseSucceed(() => false),
    );

  return Effect.gen(function* () {
    if (yield* probePath(HEALTHZ_PATH)) {
      return true;
    }
    if (options?.allowLegacyWellKnown) {
      return yield* probePath(LEGACY_HEALTH_PATH);
    }
    return false;
  });
};

const readReadyFileFromDisk = (
  fileSystem: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<BackendReadyFileData | null> =>
  fileSystem.readFileString(filePath).pipe(
    Effect.map(parseReadyFile),
    Effect.orElseSucceed(() => null),
  );

const parseUrlOrNull = (value: string | null): URL | null => {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

export interface MakeP0dServiceDriverInput {
  readonly binaryPath: string;
  readonly stateDir: string;
  readonly readyFilePath: string;
  readonly legacyServerCommand: string | null;
  readonly desktopSecretFilePath: string;
  readonly desktopBootstrapSecret: string;
  readonly host: string;
  readonly defaultPort: number;
  readonly fileSystem: FileSystem.FileSystem;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly httpClient: HttpClient.HttpClient;
  readonly waitTimeout?: Duration.Duration;
  readonly pollInterval?: Duration.Duration;
}

/** True when the user installed p0d as a launchd/systemd/Task Scheduler service themselves. */
const isP0dUserServiceInstalled = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  binaryPath: string,
): Effect.Effect<boolean> =>
  runShortCommand(spawner, binaryPath, ["service", "status"]).pipe(
    Effect.map(
      (output) =>
        output.exitCode === 0 &&
        parseP0dServiceStatus(`${output.stdout}\n${output.stderr}`).installed,
    ),
    Effect.orElseSucceed(() => false),
  );

/** Drives a p0d user service; only used once the user has installed one. */
export function makeP0dServiceDriver(input: MakeP0dServiceDriverInput): BackendServiceDriver {
  const defaultUrl = new URL(`http://${input.host}:${input.defaultPort}`);
  const waitTimeout = input.waitTimeout ?? SERVICE_START_WAIT_TIMEOUT;
  const pollInterval = input.pollInterval ?? SERVICE_START_POLL_INTERVAL;

  const readVersion = runShortCommand(input.spawner, input.binaryPath, ["version"]).pipe(
    Effect.map((output) => (output.exitCode === 0 ? parseP0dVersion(output.stdout) : null)),
    Effect.orElseSucceed(() => null),
  );

  const readServiceStatus = runShortCommand(input.spawner, input.binaryPath, [
    "service",
    "status",
  ]).pipe(
    Effect.map((output) => parseP0dServiceStatus(`${output.stdout}\n${output.stderr}`)),
    Effect.orElseSucceed((): ParsedP0dServiceStatus => ({
      running: false,
      installed: false,
      pid: null,
      port: null,
      url: null,
      version: null,
    })),
  );

  const probeStatus: Effect.Effect<BackendServiceInfo> = Effect.gen(function* () {
    const [readyFile, serviceStatus, versionFromCli] = yield* Effect.all(
      [
        readReadyFileFromDisk(input.fileSystem, input.readyFilePath),
        readServiceStatus,
        readVersion,
      ],
      { concurrency: "unbounded" },
    );
    const candidateUrl =
      parseUrlOrNull(serviceStatus.url) ?? parseUrlOrNull(readyFile?.url ?? null) ?? defaultUrl;
    const healthy = yield* probeBackendHealth(input.httpClient, candidateUrl);
    return {
      running: healthy,
      installed: serviceStatus.installed,
      pid: serviceStatus.pid ?? readyFile?.pid ?? null,
      version: serviceStatus.version ?? readyFile?.version ?? versionFromCli,
      url: healthy ? candidateUrl : parseUrlOrNull(serviceStatus.url ?? readyFile?.url ?? null),
      binaryPath: input.binaryPath,
      managedByService: true,
      driverKind: "p0d",
    };
  });

  const waitUntilHealthy = Effect.gen(function* () {
    const pollOnce = Effect.gen(function* () {
      const readyFile = yield* readReadyFileFromDisk(input.fileSystem, input.readyFilePath);
      const serviceStatus = yield* readServiceStatus;
      const candidateUrl =
        parseUrlOrNull(readyFile?.url ?? null) ?? parseUrlOrNull(serviceStatus.url) ?? defaultUrl;
      const healthy = yield* probeBackendHealth(input.httpClient, candidateUrl);
      if (!healthy) {
        return Option.none<BackendServiceInfo>();
      }
      const version = serviceStatus.version ?? readyFile?.version ?? (yield* readVersion);
      return Option.some<BackendServiceInfo>({
        running: true,
        installed: true,
        pid: readyFile?.pid ?? serviceStatus.pid ?? null,
        version,
        url: candidateUrl,
        binaryPath: input.binaryPath,
        managedByService: true,
        driverKind: "p0d",
      });
    });

    const result = yield* pollOnce.pipe(
      Effect.repeat({
        until: Option.isSome,
        schedule: Schedule.spaced(pollInterval),
      }),
      Effect.timeoutOption(waitTimeout),
    );
    if (Option.isNone(result) || Option.isNone(result.value)) {
      return yield* new BackendServiceDriverError({
        operation: "waitForHealthz",
        message: `Timed out waiting for p0d to respond on ${HEALTHZ_PATH}.`,
      });
    }
    return result.value.value;
  });

  const installService = Effect.gen(function* () {
    const installArgs = [
      "service",
      "install",
      "--home",
      input.stateDir,
      "--host",
      input.host,
      "--port",
      String(input.defaultPort),
      "--ready-file",
      input.readyFilePath,
      "--desktop-bootstrap-secret-file",
      input.desktopSecretFilePath,
      ...(input.legacyServerCommand ? ["--legacy-server", input.legacyServerCommand] : []),
    ];
    const withFlags = yield* runShortCommand(input.spawner, input.binaryPath, installArgs);
    if (withFlags.exitCode === 0) {
      return;
    }
    const bare = yield* runShortCommand(input.spawner, input.binaryPath, ["service", "install"]);
    if (bare.exitCode !== 0) {
      return yield* new BackendServiceDriverError({
        operation: "service install",
        message:
          (bare.stderr || bare.stdout || withFlags.stderr || withFlags.stdout).trim() ||
          `p0d service install exited with code ${bare.exitCode}`,
      });
    }
  });

  const start: Effect.Effect<BackendServiceInfo, BackendServiceDriverError> = Effect.gen(
    function* () {
      const current = yield* probeStatus;
      if (!current.installed) {
        yield* installService;
      }
      const started = yield* runShortCommand(input.spawner, input.binaryPath, ["service", "start"]);
      if (started.exitCode !== 0) {
        return yield* new BackendServiceDriverError({
          operation: "service start",
          message:
            (started.stderr || started.stdout).trim() ||
            `p0d service start exited with code ${started.exitCode}`,
        });
      }
      return yield* waitUntilHealthy;
    },
  );

  const ensureRunning: Effect.Effect<BackendServiceInfo, BackendServiceDriverError> = Effect.gen(
    function* () {
      const current = yield* probeStatus;
      if (current.running && current.url !== null) {
        return current;
      }
      return yield* start;
    },
  );

  const stop: Effect.Effect<void, BackendServiceDriverError> = Effect.gen(function* () {
    const result = yield* runShortCommand(input.spawner, input.binaryPath, ["service", "stop"]);
    if (result.exitCode !== 0) {
      return yield* new BackendServiceDriverError({
        operation: "service stop",
        message:
          (result.stderr || result.stdout).trim() ||
          `p0d service stop exited with code ${result.exitCode}`,
      });
    }
  });

  const restart: Effect.Effect<BackendServiceInfo, BackendServiceDriverError> = Effect.gen(
    function* () {
      yield* stop.pipe(Effect.ignore);
      return yield* start;
    },
  );

  return {
    kind: "p0d",
    binaryPath: input.binaryPath,
    desktopBootstrapSecret: input.desktopBootstrapSecret,
    unavailableReason: null,
    status: probeStatus,
    ensureRunning,
    start,
    stop,
    restart,
    exited: Effect.never,
  };
}

const DESKTOP_SECRET_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The secret p0d signs the desktop in with. It must survive relaunches, because a p0d left
 * running by an earlier launch only knows the secret it read at its own start.
 */
export const readOrCreateDesktopSecretFile = Effect.fn(
  "desktop.backendService.readOrCreateDesktopSecretFile",
)(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Pick<Path.Path, "dirname">;
  readonly random: SecureRandom.SecureRandom["Service"];
  readonly secretPath: string;
}): Effect.fn.Return<string, BackendServiceDriverError> {
  const fail = (message: string) => (cause: unknown) =>
    new BackendServiceDriverError({ operation: "desktopSecret", message, cause });
  const existing = (yield* input.fileSystem
    .readFileString(input.secretPath)
    .pipe(Effect.orElseSucceed(() => ""))).trim();
  if (DESKTOP_SECRET_PATTERN.test(existing)) {
    // p0d refuses a secret others can read; repair the mode rather than rotate the secret.
    yield* input.fileSystem.chmod(input.secretPath, 0o600).pipe(Effect.ignore);
    return existing;
  }
  const secret = Hex.encode(yield* input.random.randomBytes(32).pipe(Effect.orDie));
  const temporary = `${input.secretPath}.tmp`;
  yield* Effect.gen(function* () {
    yield* input.fileSystem.makeDirectory(input.path.dirname(input.secretPath), {
      recursive: true,
      mode: 0o700,
    });
    yield* input.fileSystem.remove(temporary, { force: true });
    yield* input.fileSystem.writeFileString(temporary, `${secret}\n`, { mode: 0o600 });
    yield* input.fileSystem.chmod(temporary, 0o600);
    yield* input.fileSystem.rename(temporary, input.secretPath);
  }).pipe(Effect.mapError(fail(`Could not write the p0d sign-in secret at ${input.secretPath}.`)));
  return secret;
});

/**
 * The p0d process this app started, if any. Shared by every driver the service hands out so a
 * relaunch through any of them sees (and stops) the same child.
 */
export interface P0dChildState {
  readonly parentScope: Scope.Scope;
  readonly current: SynchronizedRef.SynchronizedRef<Option.Option<OwnedP0dChild>>;
}

interface OwnedP0dChild {
  readonly scope: Scope.Closeable;
  readonly pid: number;
  readonly exited: Deferred.Deferred<string>;
}

export const makeP0dChildState = (parentScope: Scope.Scope) =>
  SynchronizedRef.make(Option.none<OwnedP0dChild>()).pipe(
    Effect.map((current): P0dChildState => ({ parentScope, current })),
  );

export interface MakeP0dChildDriverInput {
  readonly binaryPath: string;
  /** p0d's --home; the Node sidecar keeps its data in the same folder. */
  readonly home: string;
  readonly readyFilePath: string;
  readonly desktopSecretFilePath: string;
  readonly desktopBootstrapSecret: string;
  readonly legacyServerCommand: string | null;
  readonly host: string;
  readonly port: number;
  readonly cwd: string;
  /** Resolved at each start; p0d's sidecar inherits it. Never carries the desktop secret. */
  readonly env: Effect.Effect<Record<string, string | undefined>>;
  readonly logFilePath: string;
  readonly path: Pick<Path.Path, "basename" | "dirname">;
  readonly fileSystem: FileSystem.FileSystem;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly httpClient: HttpClient.HttpClient;
  readonly child: P0dChildState;
  /** Runs before a new p0d starts, e.g. to stop an older backend holding this home. */
  readonly beforeStart?: Effect.Effect<void>;
  readonly killProcess?: (pid: number) => Effect.Effect<void>;
  readonly processAlive?: (pid: number) => Effect.Effect<boolean>;
  readonly waitTimeout?: Duration.Duration;
  readonly pollInterval?: Duration.Duration;
}

export function p0dServeArgs(
  input: Pick<
    MakeP0dChildDriverInput,
    "home" | "host" | "port" | "readyFilePath" | "desktopSecretFilePath" | "legacyServerCommand"
  >,
): readonly string[] {
  return [
    "serve",
    "--home",
    input.home,
    "--host",
    input.host,
    "--port",
    String(input.port),
    "--ready-file",
    input.readyFilePath,
    "--desktop-bootstrap-secret-file",
    input.desktopSecretFilePath,
    ...(input.legacyServerCommand === null ? [] : ["--legacy-server", input.legacyServerCommand]),
  ];
}

/**
 * Runs `p0d serve` as a child of this app: it attaches to a healthy p0d already serving this
 * home (one an earlier launch left behind, or one the user runs), otherwise starts its own,
 * which stops when the app quits.
 */
export function makeP0dChildDriver(input: MakeP0dChildDriverInput): BackendServiceDriver {
  const killProcess = input.killProcess ?? defaultKillProcess;
  const waitTimeout = input.waitTimeout ?? SERVICE_START_WAIT_TIMEOUT;
  const pollInterval = input.pollInterval ?? SERVICE_START_POLL_INTERVAL;

  const readHealthy = Effect.gen(function* () {
    const readyFile = yield* readReadyFileFromDisk(input.fileSystem, input.readyFilePath);
    const url = parseUrlOrNull(readyFile?.url ?? null);
    if (url === null || !(yield* probeBackendHealth(input.httpClient, url))) {
      return Option.none<{ readonly url: URL; readonly pid: number | null }>();
    }
    return Option.some({ url, pid: readyFile?.pid ?? null });
  });

  const toInfo = (url: URL | null, pid: number | null): BackendServiceInfo => ({
    running: url !== null,
    installed: true,
    pid,
    version: null,
    url,
    binaryPath: input.binaryPath,
    managedByService: false,
    driverKind: "p0d",
  });

  const status: Effect.Effect<BackendServiceInfo> = readHealthy.pipe(
    Effect.map((healthy) =>
      Option.isSome(healthy) ? toInfo(healthy.value.url, healthy.value.pid) : toInfo(null, null),
    ),
  );

  const rotateLog = Effect.gen(function* () {
    const info = yield* input.fileSystem.stat(input.logFilePath);
    if (Number(info.size) > P0D_LOG_ROTATE_BYTES) {
      yield* input.fileSystem.rename(input.logFilePath, `${input.logFilePath}.1`);
    }
  }).pipe(Effect.ignore);

  const spawnChild = Effect.gen(function* () {
    if (input.legacyServerCommand !== null && input.path.basename(input.home) !== "userdata") {
      return yield* new BackendServiceDriverError({
        operation: "start",
        message: `p0d keeps the Node sidecar's data in a folder named "userdata", but this app's data folder is ${input.home}. Set P0CODE_HOME (or start the dev app with --home-dir) to use p0d here, or pick the legacy Node backend.`,
      });
    }
    yield* input.beforeStart ?? Effect.void;
    yield* input.fileSystem.remove(input.readyFilePath, { force: true }).pipe(Effect.ignore);
    yield* input.fileSystem
      .makeDirectory(input.path.dirname(input.logFilePath), { recursive: true })
      .pipe(Effect.ignore);
    yield* rotateLog;
    const env = yield* input.env;
    const scope = yield* Scope.fork(input.child.parentScope, "sequential");
    const outputTail = yield* Ref.make("");
    const started = yield* Effect.gen(function* () {
      const handle = yield* input.spawner
        .spawn(
          ChildProcess.make(input.binaryPath, p0dServeArgs(input), {
            cwd: input.cwd,
            env,
            extendEnv: true,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            killSignal: "SIGTERM",
            forceKillAfter: P0D_STOP_GRACE,
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new BackendServiceDriverError({
                operation: "start",
                message: `Could not start p0d at ${input.binaryPath}: ${cause.message}`,
                cause,
              }),
          ),
        );
      const output = yield* handle.all.pipe(
        Stream.tap((chunk) =>
          Ref.update(outputTail, (tail) =>
            (tail + new TextDecoder().decode(chunk)).slice(-P0D_OUTPUT_TAIL_BYTES),
          ),
        ),
        Stream.run(input.fileSystem.sink(input.logFilePath, { flag: "a" })),
        Effect.ignore,
        Effect.forkIn(scope),
      );
      // p0d's last words explain most failures; give the pipe a moment to drain.
      const withOutput = (reason: string) =>
        Fiber.await(output).pipe(
          Effect.timeoutOption(Duration.seconds(1)),
          Effect.andThen(Ref.get(outputTail)),
          Effect.map((tail) => (tail.trim().length > 0 ? `${reason}\n\n${tail.trim()}` : reason)),
        );
      const exited = handle.exitCode.pipe(
        Effect.map((code) => `p0d exited with code ${Number(code)}.`),
        Effect.orElseSucceed(() => "p0d exited."),
      );
      const ready = readHealthy.pipe(
        Effect.repeat({ until: Option.isSome, schedule: Schedule.spaced(pollInterval) }),
        Effect.timeoutOption(waitTimeout),
        Effect.map((result) =>
          Option.isSome(result) && Option.isSome(result.value)
            ? ({ ok: true, url: result.value.value.url } as const)
            : ({
                ok: false,
                reason: `p0d did not answer ${HEALTHZ_PATH} within ${Duration.format(waitTimeout)}.`,
              } as const),
        ),
      );
      const outcome = yield* Effect.raceFirst(
        ready,
        exited.pipe(Effect.map((reason) => ({ ok: false, reason }) as const)),
      );
      if (!outcome.ok) {
        return yield* new BackendServiceDriverError({
          operation: "waitForReady",
          message: yield* withOutput(outcome.reason),
        });
      }
      const pid = Number(handle.pid);
      const exitedSignal = yield* Deferred.make<string>();
      yield* exited.pipe(
        Effect.flatMap(withOutput),
        Effect.tap((message) => logServiceWarning("p0d exited", { pid, message })),
        Effect.flatMap((message) => Deferred.succeed(exitedSignal, message)),
        Effect.forkIn(scope),
      );
      yield* logServiceInfo("started p0d", {
        pid,
        url: outcome.url.href,
        binaryPath: input.binaryPath,
      });
      return { owned: { scope, pid, exited: exitedSignal }, url: outcome.url };
    }).pipe(
      Scope.provide(scope),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    return started;
  });

  const stopOwned = (owned: OwnedP0dChild) => Scope.close(owned.scope, Exit.void);

  const start: Effect.Effect<BackendServiceInfo, BackendServiceDriverError> =
    SynchronizedRef.modifyEffect(input.child.current, (current) =>
      Effect.gen(function* () {
        if (Option.isSome(current)) {
          yield* stopOwned(current.value);
        }
        const started = yield* spawnChild;
        return [toInfo(started.url, started.owned.pid), Option.some(started.owned)] as const;
      }),
    );

  const ensureRunning: Effect.Effect<BackendServiceInfo, BackendServiceDriverError> = Effect.gen(
    function* () {
      const healthy = yield* readHealthy;
      if (Option.isSome(healthy)) {
        // A p0d someone else runs now serves this home; our dead child must not end its runs.
        yield* SynchronizedRef.updateEffect(input.child.current, (current) =>
          Option.isSome(current) && current.value.pid !== healthy.value.pid
            ? Deferred.isDone(current.value.exited).pipe(
                Effect.map((done) => (done ? Option.none<OwnedP0dChild>() : current)),
              )
            : Effect.succeed(current),
        );
        return toInfo(healthy.value.url, healthy.value.pid);
      }
      return yield* start;
    },
  );

  const stop: Effect.Effect<void, BackendServiceDriverError> = SynchronizedRef.modifyEffect(
    input.child.current,
    (current) =>
      Effect.gen(function* () {
        if (Option.isSome(current)) {
          yield* stopOwned(current.value);
          return [undefined, Option.none<OwnedP0dChild>()] as const;
        }
        // An attached p0d answered on the URL its own ready file names, so its pid is ours to stop.
        const healthy = yield* readHealthy;
        if (Option.isSome(healthy) && healthy.value.pid !== null) {
          const pid = healthy.value.pid;
          yield* killProcess(pid);
          const alive =
            input.processAlive ??
            ((pid: number) =>
              Effect.sync(() => {
                try {
                  process.kill(pid, 0);
                  return true;
                } catch (error) {
                  return !(error instanceof Error && "code" in error && error.code === "ESRCH");
                }
              }));
          const stopped = yield* alive(pid).pipe(
            Effect.repeat({
              until: (running) => !running,
              schedule: Schedule.spaced(pollInterval),
            }),
            Effect.timeoutOption(P0D_STOP_GRACE),
          );
          if (Option.isNone(stopped)) {
            return yield* new BackendServiceDriverError({
              operation: "stop",
              message: `p0d process ${pid} did not exit within 15 seconds; refusing to start a replacement.`,
            });
          }
        }
        return [undefined, current] as const;
      }),
  );

  const restart: Effect.Effect<BackendServiceInfo, BackendServiceDriverError> = Effect.gen(
    function* () {
      yield* stop;
      return yield* start;
    },
  );

  const exited: Effect.Effect<string> = SynchronizedRef.get(input.child.current).pipe(
    Effect.flatMap((current) =>
      Option.isSome(current) ? Deferred.await(current.value.exited) : Effect.never,
    ),
  );

  return {
    kind: "p0d",
    binaryPath: input.binaryPath,
    desktopBootstrapSecret: input.desktopBootstrapSecret,
    unavailableReason: null,
    status,
    ensureRunning,
    start,
    stop,
    restart,
    exited,
  };
}

/** Stands in for p0d when it cannot run at all, so every entry point reports the same reason. */
export function makeUnavailableP0dDriver(reason: string): BackendServiceDriver {
  const fail = Effect.fail(new BackendServiceDriverError({ operation: "start", message: reason }));
  return {
    kind: "p0d",
    binaryPath: null,
    desktopBootstrapSecret: null,
    unavailableReason: reason,
    status: Effect.succeed({
      running: false,
      installed: false,
      pid: null,
      version: null,
      url: null,
      binaryPath: null,
      managedByService: false,
      driverKind: "p0d",
    }),
    ensureRunning: fail,
    start: fail,
    stop: Effect.void,
    restart: fail,
    exited: Effect.never,
  };
}

/** Persisted so a relaunched GUI can prove and sign in to the service an earlier launch started. */
export interface LocalServiceSecrets {
  readonly bootstrapSecret: string;
  readonly readinessSecret: string;
}

const LocalServiceSecretsSchema = Schema.Struct({
  bootstrapSecret: Schema.String,
  readinessSecret: Schema.String,
});
const decodeLocalServiceSecretsJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(LocalServiceSecretsSchema),
);
const encodeLocalServiceSecretsJson = Schema.encodeEffect(
  Schema.fromJsonString(LocalServiceSecretsSchema),
);
const LOCAL_SERVICE_SECRET_PATTERN = /^[0-9a-f]{64}$/;

const readOrCreateLocalServiceSecrets = Effect.fn(
  "desktop.backendService.readOrCreateLocalServiceSecrets",
)(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly random: SecureRandom.SecureRandom["Service"];
  readonly stateDir: string;
  readonly secretsPath: string;
}) {
  const existing = yield* input.fileSystem.readFileString(input.secretsPath).pipe(
    Effect.map(decodeLocalServiceSecretsJson),
    Effect.orElseSucceed(() => Option.none<LocalServiceSecrets>()),
  );
  if (
    Option.isSome(existing) &&
    LOCAL_SERVICE_SECRET_PATTERN.test(existing.value.bootstrapSecret) &&
    LOCAL_SERVICE_SECRET_PATTERN.test(existing.value.readinessSecret)
  ) {
    return existing.value;
  }
  const secrets: LocalServiceSecrets = {
    bootstrapSecret: Hex.encode(yield* input.random.randomBytes(32).pipe(Effect.orDie)),
    readinessSecret: Hex.encode(yield* input.random.randomBytes(32).pipe(Effect.orDie)),
  };
  yield* encodeLocalServiceSecretsJson(secrets).pipe(
    Effect.flatMap((encoded) =>
      input.fileSystem
        .makeDirectory(input.stateDir, { recursive: true })
        .pipe(
          Effect.andThen(
            input.fileSystem.writeFileString(input.secretsPath, `${encoded}\n`, { mode: 0o600 }),
          ),
        ),
    ),
    Effect.catch((cause) =>
      logServiceWarning("could not persist the local service secrets", { cause }),
    ),
  );
  return secrets;
});

/** True only for the backend holding `readinessSecret`, never for another app on the same port. */
const proveLocalServiceIdentity = Effect.fn("desktop.backendService.proveLocalServiceIdentity")(
  function* (
    input: {
      readonly httpClient: HttpClient.HttpClient;
      readonly mac: Mac.Mac["Service"];
      readonly random: SecureRandom.SecureRandom["Service"];
      readonly readinessSecret: string;
    },
    baseUrl: URL,
  ): Effect.fn.Return<boolean> {
    const challenge = Hex.encode(yield* input.random.randomBytes(16).pipe(Effect.orDie));
    const proofUrl = new URL(
      `${DESKTOP_READINESS_PROOF_PATH}?${DESKTOP_READINESS_CHALLENGE_PARAM}=${challenge}`,
      baseUrl,
    );
    const body = yield* input.httpClient.execute(HttpClientRequest.get(proofUrl)).pipe(
      Effect.flatMap((response) => (response.status === 200 ? response.text : Effect.succeed(""))),
      Effect.timeoutOption(HEALTH_PROBE_TIMEOUT),
      Effect.map((result) => Option.getOrElse(result, () => "")),
      Effect.orElseSucceed(() => ""),
    );
    if (body.length === 0) return false;
    return yield* isValidDesktopReadinessProof(input.readinessSecret, challenge, body).pipe(
      Effect.provideService(Mac.Mac, input.mac),
    );
  },
);

const encodeBootstrapJson = Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap));

export interface MakeLegacyNodeServiceDriverInput {
  readonly executablePath: string;
  readonly entryPath: string;
  readonly cwd: string;
  readonly stateDir: string;
  readonly baseDir: string;
  readonly readyFilePath: string;
  readonly host: string;
  readonly preferredPort: number;
  readonly version: string;
  readonly secrets: LocalServiceSecrets;
  readonly fileSystem: FileSystem.FileSystem;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly httpClient: HttpClient.HttpClient;
  readonly mac: Mac.Mac["Service"];
  readonly random: SecureRandom.SecureRandom["Service"];
  /** Returns the preferred port when free, else another free one. */
  readonly pickPort: (preferred: number) => Effect.Effect<number, BackendServiceDriverError>;
  readonly killProcess?: (pid: number) => Effect.Effect<void>;
  readonly waitTimeout?: Duration.Duration;
  readonly pollInterval?: Duration.Duration;
}

const defaultKillProcess = (pid: number): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may already have exited.
    }
  });

/**
 * Pluggable Node-server implementation of `BackendServiceDriver`.
 * Allows `local-service` mode to run today's Node server as a detached process that survives
 * GUI quit and can be reattached on relaunch until the native `p0d` binary ships.
 */
export function makeLegacyNodeServiceDriver(
  input: MakeLegacyNodeServiceDriverInput,
): BackendServiceDriver {
  const killProcess = input.killProcess ?? defaultKillProcess;
  const waitTimeout = input.waitTimeout ?? SERVICE_START_WAIT_TIMEOUT;
  const pollInterval = input.pollInterval ?? SERVICE_START_POLL_INTERVAL;
  const provesIdentity = (url: URL) =>
    proveLocalServiceIdentity(
      {
        httpClient: input.httpClient,
        mac: input.mac,
        random: input.random,
        readinessSecret: input.secrets.readinessSecret,
      },
      url,
    );

  // Only the ready file names our service; probing a default port would adopt any server there.
  const readOwnService = Effect.gen(function* () {
    const readyFile = yield* readReadyFileFromDisk(input.fileSystem, input.readyFilePath);
    const url = parseUrlOrNull(readyFile?.url ?? null);
    if (url === null || !(yield* provesIdentity(url))) {
      return Option.none<{ readonly url: URL; readonly readyFile: BackendReadyFileData | null }>();
    }
    return Option.some({ url, readyFile });
  });

  const probeStatus: Effect.Effect<BackendServiceInfo> = Effect.gen(function* () {
    const own = yield* readOwnService;
    return {
      running: Option.isSome(own),
      installed: yield* input.fileSystem
        .exists(input.entryPath)
        .pipe(Effect.orElseSucceed(() => false)),
      pid: Option.isSome(own) ? (own.value.readyFile?.pid ?? null) : null,
      version: Option.isSome(own) ? (own.value.readyFile?.version ?? input.version) : input.version,
      url: Option.isSome(own) ? own.value.url : null,
      binaryPath: input.entryPath,
      managedByService: true,
      driverKind: "legacy-node",
    };
  });

  const start: Effect.Effect<BackendServiceInfo, BackendServiceDriverError> = Effect.gen(
    function* () {
      const entryExists = yield* input.fileSystem
        .exists(input.entryPath)
        .pipe(Effect.orElseSucceed(() => false));
      if (!entryExists) {
        return yield* new BackendServiceDriverError({
          operation: "start",
          message: `Legacy server bundle not found at ${input.entryPath}.`,
        });
      }

      const port = yield* input.pickPort(input.preferredPort);
      const url = new URL(`http://${input.host}:${port}`);
      const bootstrapJson = yield* encodeBootstrapJson({
        mode: "desktop",
        noBrowser: true,
        port,
        t3Home: input.baseDir,
        host: input.host,
        // Unused: the secret derives rotating tokens instead of seeding this one.
        desktopBootstrapToken: "",
        desktopBootstrapSecret: input.secrets.bootstrapSecret,
        desktopReadinessSecret: input.secrets.readinessSecret,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new BackendServiceDriverError({
              operation: "start",
              message: "Failed to encode the local service bootstrap payload.",
              cause,
            }),
        ),
      );

      const pid = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* input.spawner
            .spawn(
              ChildProcess.make(
                input.executablePath,
                [
                  "--title=p0code-backend",
                  input.entryPath,
                  // Web mode: a desktop-mode server exits when its launcher (this GUI) does.
                  "--mode",
                  "web",
                  "--no-browser",
                  "--host",
                  input.host,
                  "--port",
                  String(port),
                  "--bootstrap-fd",
                  "0",
                ],
                {
                  cwd: input.cwd,
                  detached: true,
                  env: {
                    ELECTRON_RUN_AS_NODE: "1",
                    P0D_HOME: input.baseDir,
                    T3CODE_HOME: input.baseDir,
                    // Web mode would otherwise add the app bundle directory as a project.
                    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
                  },
                  extendEnv: true,
                  stdin: Stream.encodeText(Stream.make(`${bootstrapJson}\n`)),
                  stdout: "ignore",
                  stderr: "ignore",
                },
              ),
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new BackendServiceDriverError({
                    operation: "start",
                    message: `Failed to start legacy Node backend service: ${cause.message}`,
                    cause,
                  }),
              ),
            );
          const ready = provesIdentity(url).pipe(
            Effect.repeat({ until: (ok) => ok, schedule: Schedule.spaced(pollInterval) }),
            Effect.timeoutOption(waitTimeout),
            Effect.map((result) =>
              Option.isSome(result)
                ? null
                : `Timed out waiting for the legacy Node backend at ${url.href}.`,
            ),
          );
          const exited = handle.exitCode.pipe(
            Effect.map((code) => `The legacy Node backend exited with code ${Number(code)}.`),
            Effect.orElseSucceed(() => "The legacy Node backend exited."),
          );
          const failure = yield* Effect.raceFirst(ready, exited);
          if (failure !== null) {
            // Still referenced, so closing the scope stops the half-started process.
            return yield* new BackendServiceDriverError({
              operation: "waitForReady",
              message: failure,
            });
          }
          yield* handle.unref.pipe(Effect.ignore);
          return Number(handle.pid);
        }),
      );

      yield* encodeReadyFileJson({ pid, port, url: url.href, version: input.version }).pipe(
        Effect.flatMap((encoded) =>
          input.fileSystem
            .makeDirectory(input.stateDir, { recursive: true })
            .pipe(
              Effect.andThen(input.fileSystem.writeFileString(input.readyFilePath, `${encoded}\n`)),
            ),
        ),
        Effect.ignore,
      );

      return {
        running: true,
        installed: true,
        pid,
        version: input.version,
        url,
        binaryPath: input.entryPath,
        managedByService: true,
        driverKind: "legacy-node",
      };
    },
  );

  const ensureRunning: Effect.Effect<BackendServiceInfo, BackendServiceDriverError> = Effect.gen(
    function* () {
      const current = yield* probeStatus;
      if (current.running && current.url !== null) {
        return current;
      }
      return yield* start;
    },
  );

  const stop: Effect.Effect<void, BackendServiceDriverError> = Effect.gen(function* () {
    const own = yield* readOwnService;
    // A dead service's recorded pid may since belong to an unrelated process.
    const pid = Option.isSome(own) ? (own.value.readyFile?.pid ?? null) : null;
    if (pid !== null) {
      yield* killProcess(pid);
    }
    yield* input.fileSystem.remove(input.readyFilePath, { force: true }).pipe(Effect.ignore);
  });

  const restart: Effect.Effect<BackendServiceInfo, BackendServiceDriverError> = Effect.gen(
    function* () {
      yield* stop.pipe(Effect.ignore);
      return yield* start;
    },
  );

  return {
    kind: "legacy-node",
    binaryPath: input.entryPath,
    desktopBootstrapSecret: input.secrets.bootstrapSecret,
    unavailableReason: null,
    exited: Effect.never,
    status: probeStatus,
    ensureRunning,
    start,
    stop,
    restart,
  };
}

export class DesktopBackendService extends Context.Service<
  DesktopBackendService,
  {
    readonly hasP0d: Effect.Effect<boolean>;
    readonly resolveEffectiveMode: Effect.Effect<DesktopBackendMode>;
    readonly findP0dBinary: Effect.Effect<Option.Option<string>>;
    readonly resolveServiceDriver: Effect.Effect<BackendServiceDriver>;
    /**
     * Brings p0d (or another external backend) up before any window loads. It never falls back
     * to another backend on its own; the caller shows `failure` and lets the user choose.
     */
    readonly prepareSelectedBackend: Effect.Effect<{
      readonly mode: DesktopBackendMode;
      readonly failure: string | null;
    }>;
    /** Runs the deprecated Node backend until the app quits, without changing the saved choice. */
    readonly useLegacyBackendForThisLaunch: Effect.Effect<void>;
    readonly getStatus: (input: {
      readonly embeddedReady: boolean;
      readonly embeddedDesiredRunning: boolean;
      readonly embeddedPid: number | null;
      readonly embeddedUrl: string | null;
    }) => Effect.Effect<DesktopBackendStatus>;
    readonly updateConfig: (
      input: DesktopBackendConfigUpdate,
    ) => Effect.Effect<
      { readonly changed: boolean; readonly error: string | null },
      DesktopAppSettings.DesktopSettingsWriteError
    >;
    readonly controlService: (
      action: DesktopBackendAction,
    ) => Effect.Effect<void, BackendServiceDriverError>;
    /**
     * After the saved connection list is lost, adopt a local p0d/service that is already serving
     * this home instead of starting another backend over it.
     */
    readonly reattachLocalEnvironment: Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/backend/DesktopBackendService") {}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const mac = yield* Mac.Mac;
  const random = yield* SecureRandom.SecureRandom;
  const serverExposure = yield* Effect.serviceOption(DesktopServerExposure.DesktopServerExposure);
  const p0dChild = yield* makeP0dChildState(yield* Effect.scope);
  const launchModeOverride = yield* Ref.make(Option.none<DesktopBackendMode>());
  const readyFilePath = environment.path.join(environment.stateDir, P0D_READY_FILE_NAME);
  const desktopSecretFilePath = environment.path.join(
    environment.stateDir,
    ...P0D_DESKTOP_SECRET_FILE,
  );
  const legacyServiceReadyFilePath = environment.path.join(
    environment.stateDir,
    LEGACY_SERVICE_READY_FILE_NAME,
  );
  const localServiceSecrets = yield* Effect.cached(
    readOrCreateLocalServiceSecrets({
      fileSystem,
      random,
      stateDir: environment.stateDir,
      secretsPath: environment.path.join(environment.stateDir, LEGACY_SERVICE_SECRETS_FILE_NAME),
    }),
  );

  const firstExistingPath = Effect.fn("desktop.backendService.firstExistingPath")(function* (
    candidates: readonly string[],
  ) {
    for (const candidate of candidates) {
      if (!environment.path.isAbsolute(candidate)) continue;
      const stat = yield* fileSystem.stat(candidate).pipe(Effect.orElseSucceed(() => null));
      if (
        stat?.type === "File" &&
        (environment.platform === "win32" || (stat.mode & 0o111) !== 0)
      ) {
        return Option.some(candidate);
      }
    }
    return Option.none<string>();
  });

  // Sync IPC handlers read the backend label and cannot wait on the filesystem, so the
  // resolution is cached here and refreshed before startup and whenever status is read.
  const p0dAvailableRef = yield* Ref.make(false);

  const p0dCandidates = Effect.gen(function* () {
    const settings = yield* appSettings.get;
    const env = yield* HostProcess.Environment;
    return p0dBinaryCandidates({
      path: environment.path,
      platform: environment.platform,
      arch: environment.processArch,
      isPackaged: environment.isPackaged,
      resourcesPath: environment.resourcesPath,
      rootDir: environment.rootDir,
      homeDirectory: environment.homeDirectory,
      configuredBinaryPath: settings.backendBinaryPath ?? null,
      pathEnv: env.PATH ?? env.Path,
    });
  });

  const findP0dBinary = Effect.flatMap(p0dCandidates, firstExistingPath);

  const refreshP0dAvailability = Effect.gen(function* () {
    const p0dBinary = yield* findP0dBinary;
    const available = Option.isSome(p0dBinary);
    yield* Ref.set(p0dAvailableRef, available);
    return available;
  });

  yield* refreshP0dAvailability;
  const hasP0d = Ref.get(p0dAvailableRef);

  const resolveEffectiveMode = Effect.gen(function* () {
    const override = yield* Ref.get(launchModeOverride);
    if (Option.isSome(override)) return override.value;
    return resolveEffectiveBackendMode(yield* appSettings.get);
  });

  // A Node service an earlier version ran for local-service mode holds this home's lock, which
  // would stop p0d's sidecar from starting. It only answers to its own secret, so this never
  // stops anything else.
  const stopLegacyNodeService = Effect.gen(function* () {
    if (
      !(yield* fileSystem
        .exists(legacyServiceReadyFilePath)
        .pipe(Effect.orElseSucceed(() => false)))
    ) {
      return;
    }
    const legacy = makeLegacyNodeServiceDriver({
      executablePath: process.execPath,
      entryPath: environment.backendEntryPath,
      cwd: environment.backendCwd,
      stateDir: environment.stateDir,
      baseDir: environment.baseDir,
      readyFilePath: legacyServiceReadyFilePath,
      host: DEFAULT_SERVICE_HOST,
      preferredPort: DEFAULT_SERVICE_PORT,
      version: environment.appVersion,
      secrets: yield* localServiceSecrets,
      fileSystem,
      spawner,
      httpClient,
      mac,
      random,
      pickPort: () => Effect.succeed(DEFAULT_SERVICE_PORT),
    });
    yield* logServiceInfo("stopping the Node backend service an earlier version started");
    yield* legacy.stop.pipe(Effect.ignore);
  });

  const p0dListenAddress = Effect.gen(function* () {
    if (Option.isNone(serverExposure)) {
      return { host: DEFAULT_SERVICE_HOST, port: 0 };
    }
    const exposure = yield* serverExposure.value.backendConfig;
    // A network-accessible desktop advertises its port to other devices, so it must stay fixed.
    return exposure.bindHost === DEFAULT_SERVICE_HOST
      ? { host: DEFAULT_SERVICE_HOST, port: 0 }
      : { host: exposure.bindHost, port: exposure.port };
  });

  const p0dEnv = Effect.gen(function* () {
    const cliPath = yield* DesktopCliShim.install.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    return {
      // For the sidecar only: p0d is a native binary and ignores it.
      ELECTRON_RUN_AS_NODE: "1",
      // Web mode would otherwise add the app bundle directory as a project.
      T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
      T3CODE_CLI_PATH: Option.getOrUndefined(cliPath),
      T3CODE_PORT: undefined,
      T3CODE_MODE: undefined,
      T3CODE_HOST: undefined,
      T3CODE_NO_BROWSER: undefined,
    };
  });

  const missingP0dMessage = Effect.gen(function* () {
    const candidates = yield* p0dCandidates;
    const hint = environment.isPackaged
      ? "Reinstall p0code; the app ships p0d inside its resources."
      : `Build it with \`apps/p0d/scripts/build.sh ${p0dDistTarget(environment.platform, environment.processArch).replace("-", "/")}\` (needs Go), or set a p0d binary path in Settings > Backend.`;
    return `p0code couldn't find its p0d backend. ${hint}\n\nLooked in:\n${candidates
      .slice(0, 5)
      .map((candidate) => `- ${candidate}`)
      .join("\n")}${candidates.length > 5 ? "\n- …and the folders on PATH" : ""}`;
  });

  const resolveServiceDriver: Effect.Effect<BackendServiceDriver> = Effect.gen(function* () {
    const p0dBinary = yield* findP0dBinary;
    if (Option.isNone(p0dBinary)) {
      return makeUnavailableP0dDriver(yield* missingP0dMessage);
    }
    const secret = yield* readOrCreateDesktopSecretFile({
      fileSystem,
      path: environment.path,
      random,
      secretPath: desktopSecretFilePath,
    }).pipe(Effect.result);
    if (secret._tag === "Failure") {
      return makeUnavailableP0dDriver(secret.failure.message);
    }
    const legacyEntryExists = yield* fileSystem
      .exists(environment.backendEntryPath)
      .pipe(Effect.orElseSucceed(() => false));
    const legacyServerCommand = legacyEntryExists
      ? p0dLegacyServerCommand({
          executablePath: process.execPath,
          isPackaged: environment.isPackaged,
          compileCachePath: environment.compileCachePath,
          entryPath: environment.backendEntryPath,
        })
      : null;
    if (yield* isP0dUserServiceInstalled(spawner, p0dBinary.value)) {
      return makeP0dServiceDriver({
        binaryPath: p0dBinary.value,
        stateDir: environment.stateDir,
        readyFilePath,
        legacyServerCommand,
        desktopSecretFilePath,
        desktopBootstrapSecret: secret.success,
        host: DEFAULT_SERVICE_HOST,
        defaultPort: Option.getOrElse(
          environment.configuredBackendPort,
          () => DEFAULT_SERVICE_PORT,
        ),
        fileSystem,
        spawner,
        httpClient,
      });
    }
    const listen = yield* p0dListenAddress;
    return makeP0dChildDriver({
      binaryPath: p0dBinary.value,
      home: environment.stateDir,
      readyFilePath,
      desktopSecretFilePath,
      desktopBootstrapSecret: secret.success,
      legacyServerCommand,
      host: listen.host,
      port: listen.port,
      cwd: environment.backendCwd,
      env: p0dEnv,
      logFilePath: environment.path.join(environment.stateDir, ...P0D_LOG_FILE),
      path: environment.path,
      fileSystem,
      spawner,
      httpClient,
      child: p0dChild,
      beforeStart: stopLegacyNodeService,
    });
  });

  const REMOTE_BACKEND_UNSUPPORTED_MESSAGE =
    "Remote backend mode is experimental and not supported yet: there is no pairing credential for a remote server. Add the other machine from Settings > Connections instead.";

  const externalBackendFailure = Effect.fn("desktop.backendService.externalBackendFailure")(
    function* (mode: DesktopBackendMode): Effect.fn.Return<string | null> {
      if (mode === "remote") {
        return REMOTE_BACKEND_UNSUPPORTED_MESSAGE;
      }
      if (mode !== "local-service") return null;
      const driver = yield* resolveServiceDriver;
      return yield* driver.ensureRunning.pipe(
        Effect.as(null),
        Effect.catch((error) => Effect.succeed(error.message)),
      );
    },
  );

  const prepareSelectedBackend: DesktopBackendService["Service"]["prepareSelectedBackend"] =
    Effect.gen(function* () {
      // Runs after settings load, so this sees a configured p0d override from disk.
      yield* refreshP0dAvailability;
      const mode = yield* resolveEffectiveMode;
      const failure = yield* externalBackendFailure(mode);
      if (failure !== null) {
        yield* logServiceWarning("the selected backend failed to start", {
          mode,
          reason: failure,
        });
        // Re-resolve so a binary that appeared or vanished while we tried is reflected next time.
        yield* refreshP0dAvailability;
      }
      return { mode, failure };
    }).pipe(Effect.withSpan("desktop.backendService.prepareSelectedBackend"));

  const useLegacyBackendForThisLaunch: DesktopBackendService["Service"]["useLegacyBackendForThisLaunch"] =
    Ref.set(launchModeOverride, Option.some<DesktopBackendMode>("embedded")).pipe(
      Effect.tap(() => logServiceWarning("using the deprecated Node backend for this launch")),
    );

  const getStatus: DesktopBackendService["Service"]["getStatus"] = Effect.fn(
    "desktop.backendService.getStatus",
  )(function* (embedded) {
    const settings = yield* appSettings.get;
    yield* refreshP0dAvailability;
    const mode = yield* resolveEffectiveMode;
    const p0dBinary = yield* findP0dBinary;
    const resolvedBinaryPath = Option.getOrNull(p0dBinary);
    const binaryPath = settings.backendBinaryPath ?? null;
    const remoteUrl = settings.backendRemoteUrl ?? null;

    if (mode === "remote") {
      // Kept visible so a saved legacy choice is explained rather than rewritten, but never
      // reported as a working backend until a pairing flow exists.
      return {
        mode,
        status: "stopped",
        running: false,
        url: null,
        remoteUrl,
        binaryPath,
        resolvedBinaryPath,
        driverKind: "remote",
        version: null,
        pid: null,
        serviceInstalled: false,
        managedByService: false,
        error: REMOTE_BACKEND_UNSUPPORTED_MESSAGE,
      };
    }

    if (mode === "local-service") {
      const driver = yield* resolveServiceDriver;
      const info = yield* driver.status;
      return {
        mode,
        status: info.running ? "running" : "stopped",
        running: info.running,
        url: info.url?.href ?? null,
        remoteUrl,
        binaryPath,
        resolvedBinaryPath: info.binaryPath,
        driverKind: info.driverKind,
        version: info.version,
        pid: info.pid,
        serviceInstalled: info.installed,
        managedByService: info.managedByService,
        error: driver.unavailableReason,
      };
    }

    return {
      mode,
      status: embedded.embeddedReady
        ? "running"
        : embedded.embeddedDesiredRunning
          ? "starting"
          : "stopped",
      running: embedded.embeddedReady,
      url: embedded.embeddedUrl,
      remoteUrl,
      binaryPath,
      resolvedBinaryPath,
      driverKind: "embedded",
      version: environment.appVersion,
      pid: embedded.embeddedPid,
      serviceInstalled: false,
      managedByService: false,
      error: null,
    };
  });

  const updateConfig: DesktopBackendService["Service"]["updateConfig"] = Effect.fn(
    "desktop.backendService.updateConfig",
  )(function* (input) {
    // A backend the app cannot sign in to is not saved as the next launch's choice. Validate
    // before switching; a failed attempt leaves the current config untouched.
    if (input.mode === "remote") {
      return { changed: false, error: REMOTE_BACKEND_UNSUPPORTED_MESSAGE };
    }
    if (input.mode === "local-service" && input.binaryPath === undefined) {
      const failure = yield* externalBackendFailure("local-service");
      if (failure !== null) return { changed: false, error: failure };
    }
    const change = yield* appSettings.setBackendConfig(input);
    return { changed: change.changed, error: null };
  });

  const controlService: DesktopBackendService["Service"]["controlService"] = Effect.fn(
    "desktop.backendService.controlService",
  )(function* (action) {
    const driver = yield* resolveServiceDriver;
    if (action === "start") {
      yield* driver.start;
      return;
    }
    if (action === "stop") {
      yield* driver.stop;
      return;
    }
    yield* driver.restart;
  });

  const reattachLocalEnvironment: DesktopBackendService["Service"]["reattachLocalEnvironment"] =
    Effect.gen(function* () {
      const settings = yield* appSettings.get;
      return yield* adoptRunningLocalService({
        driver: yield* resolveServiceDriver,
        settings: { backendMode: resolveEffectiveBackendMode(settings) },
        // Recorded explicitly so a recovered install keeps using the backend that has its projects.
        setMode: (mode) =>
          appSettings.setBackendConfig({ mode, modeConfiguredByUser: true }).pipe(
            Effect.tap(() => logServiceInfo("recorded the reattached backend mode", { mode })),
            Effect.as(true),
            Effect.catch((error) =>
              logServiceWarning("failed to record the reattached backend mode", {
                mode,
                error: error.message,
              }).pipe(Effect.as(false)),
            ),
          ),
      });
    }).pipe(Effect.withSpan("desktop.backendService.reattachLocalEnvironment"));

  return DesktopBackendService.of({
    hasP0d,
    resolveEffectiveMode,
    findP0dBinary,
    resolveServiceDriver,
    prepareSelectedBackend,
    useLegacyBackendForThisLaunch,
    getStatus,
    updateConfig,
    controlService,
    reattachLocalEnvironment,
  });
});

export const layer = Layer.effect(DesktopBackendService, make);

export const layerTest = (
  overrides: Partial<DesktopBackendService["Service"]> = {},
): Layer.Layer<DesktopBackendService> =>
  Layer.succeed(
    DesktopBackendService,
    DesktopBackendService.of({
      hasP0d: Effect.succeed(false),
      resolveEffectiveMode: Effect.succeed("embedded"),
      findP0dBinary: Effect.succeedNone,
      resolveServiceDriver: Effect.die("DesktopBackendService.layerTest resolveServiceDriver"),
      prepareSelectedBackend: Effect.succeed({ mode: "embedded", failure: null }),
      useLegacyBackendForThisLaunch: Effect.void,
      getStatus: Effect.fn("DesktopBackendService.getStatus")(function () {
        return Effect.succeed({
          mode: "embedded" as const,
          status: "stopped" as const,
          running: false,
          url: null,
          remoteUrl: null,
          binaryPath: null,
          resolvedBinaryPath: null,
          driverKind: "embedded" as const,
          version: null,
          pid: null,
          serviceInstalled: false,
          managedByService: false,
          error: null,
        });
      }),
      updateConfig: Effect.fn("DesktopBackendService.updateConfig")(function () {
        return Effect.succeed({ changed: false, error: null });
      }),
      controlService: Effect.fn("DesktopBackendService.controlService")(function () {
        return logServiceWarning("controlService called on DesktopBackendService.layerTest");
      }),
      reattachLocalEnvironment: Effect.succeed(false),
      ...overrides,
    }),
  );
