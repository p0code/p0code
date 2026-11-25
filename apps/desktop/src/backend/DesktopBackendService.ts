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
import * as NetService from "@t3tools/shared/Net";
import * as Context from "effect/Context";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

const DEFAULT_SERVICE_HOST = "127.0.0.1";
const DEFAULT_SERVICE_PORT = 3773;
const HEALTHZ_PATH = "/healthz";
const LEGACY_HEALTH_PATH = "/.well-known/t3/environment";
const HEALTH_PROBE_TIMEOUT = Duration.seconds(1);
const SERVICE_START_WAIT_TIMEOUT = Duration.seconds(30);
const SERVICE_START_POLL_INTERVAL = Duration.millis(200);
const COMMAND_TIMEOUT = Duration.seconds(15);
const P0D_READY_FILE_NAME = "p0d-ready.json";
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
  readonly status: Effect.Effect<BackendServiceInfo>;
  readonly ensureRunning: Effect.Effect<BackendServiceInfo, BackendServiceDriverError>;
  readonly start: Effect.Effect<BackendServiceInfo, BackendServiceDriverError>;
  readonly stop: Effect.Effect<void, BackendServiceDriverError>;
  readonly restart: Effect.Effect<BackendServiceInfo, BackendServiceDriverError>;
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
 * The auto default follows p0d availability instead of the stored mode. A document that
 * recorded the embedded default (no explicit choice) moves to local-service as
 * soon as p0d resolves, and moves back if it disappears.
 */
export function resolveEffectiveBackendMode(
  settings: Pick<DesktopAppSettings.DesktopSettings, "backendMode" | "backendModeConfiguredByUser">,
  hasP0d: boolean,
): DesktopBackendMode {
  if (settings.backendModeConfiguredByUser) {
    return settings.backendMode;
  }
  return hasP0d ? "local-service" : "embedded";
}

function p0dBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "p0d.exe" : "p0d";
}

function packagedP0dBinaryCandidates(input: {
  readonly path: Pick<Path.Path, "join">;
  readonly platform: NodeJS.Platform;
  readonly resourcesPath: string;
}): readonly string[] {
  const binaryName = p0dBinaryName(input.platform);
  return [input.path.join(input.resourcesPath, "p0d", binaryName)];
}

export function p0dBinaryCandidates(input: {
  readonly path: Pick<Path.Path, "join">;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly rootDir: string;
  readonly homeDirectory: string;
  readonly baseDir: string;
  readonly appDataDirectory: string;
  readonly configuredBinaryPath: string | null;
}): readonly string[] {
  const candidates: string[] = [];
  const pushUnique = (candidate: string) => {
    const trimmed = candidate.trim();
    if (trimmed.length > 0 && !candidates.includes(trimmed)) {
      candidates.push(trimmed);
    }
  };

  if (input.configuredBinaryPath) {
    pushUnique(input.configuredBinaryPath);
  }
  for (const packaged of packagedP0dBinaryCandidates(input)) {
    pushUnique(packaged);
  }
  // Other installs (PATH, home/bin, dev dist) are not a compatibility guarantee.
  // They can be selected deliberately through backendBinaryPath.
  return candidates;
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
  readonly host: string;
  readonly defaultPort: number;
  readonly fileSystem: FileSystem.FileSystem;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly httpClient: HttpClient.HttpClient;
  readonly waitTimeout?: Duration.Duration;
  readonly pollInterval?: Duration.Duration;
}

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
    desktopBootstrapSecret: null,
    status: probeStatus,
    ensureRunning,
    start,
    stop,
    restart,
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
     * Brings an external backend up before any window loads; if it cannot serve the desktop,
     * switches this install back to the in-app backend and says why.
     */
    readonly prepareSelectedBackend: Effect.Effect<{
      readonly mode: DesktopBackendMode;
      readonly fallbackReason: string | null;
    }>;
    readonly getStatus: (input: {
      readonly embeddedReady: boolean;
      readonly embeddedDesiredRunning: boolean;
      readonly embeddedPid: number | null;
      readonly embeddedUrl: string | null;
    }) => Effect.Effect<DesktopBackendStatus>;
    readonly updateConfig: (
      input: DesktopBackendConfigUpdate,
    ) => Effect.Effect<{ readonly changed: boolean }, DesktopAppSettings.DesktopSettingsWriteError>;
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
  const net = yield* NetService.NetService;
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

  const findP0dBinary = Effect.gen(function* () {
    const settings = yield* appSettings.get;
    const candidates = p0dBinaryCandidates({
      path: environment.path,
      platform: environment.platform,
      arch: environment.processArch,
      isPackaged: environment.isPackaged,
      resourcesPath: environment.resourcesPath,
      rootDir: environment.rootDir,
      homeDirectory: environment.homeDirectory,
      baseDir: environment.baseDir,
      appDataDirectory: environment.appDataDirectory,
      configuredBinaryPath: settings.backendBinaryPath ?? null,
    });
    return yield* firstExistingPath(candidates);
  });

  const refreshP0dAvailability = Effect.gen(function* () {
    const p0dBinary = yield* findP0dBinary;
    const available = Option.isSome(p0dBinary);
    yield* Ref.set(p0dAvailableRef, available);
    return available;
  });

  yield* refreshP0dAvailability;
  const hasP0d = Ref.get(p0dAvailableRef);

  const resolveEffectiveMode = Effect.gen(function* () {
    const settings = yield* appSettings.get;
    const p0dAvailable = yield* hasP0d;
    return resolveEffectiveBackendMode(
      {
        backendMode:
          settings.backendMode ?? DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS.backendMode,
        backendModeConfiguredByUser: settings.backendModeConfiguredByUser ?? false,
      },
      p0dAvailable,
    );
  });

  const resolveServiceDriver: Effect.Effect<BackendServiceDriver> = Effect.gen(function* () {
    const p0dBinary = yield* findP0dBinary;
    const defaultPort = Option.getOrElse(
      environment.configuredBackendPort,
      () => DEFAULT_SERVICE_PORT,
    );
    const legacyEntryExists = yield* fileSystem
      .exists(environment.backendEntryPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (Option.isSome(p0dBinary)) {
      const legacyServerCommand = legacyEntryExists
        ? `${process.execPath} ${environment.backendEntryPath}`
        : null;
      return makeP0dServiceDriver({
        binaryPath: p0dBinary.value,
        stateDir: environment.stateDir,
        readyFilePath: environment.path.join(environment.stateDir, P0D_READY_FILE_NAME),
        legacyServerCommand,
        host: DEFAULT_SERVICE_HOST,
        defaultPort,
        fileSystem,
        spawner,
        httpClient,
      });
    }
    return makeLegacyNodeServiceDriver({
      executablePath: process.execPath,
      entryPath: environment.backendEntryPath,
      cwd: environment.backendCwd,
      stateDir: environment.stateDir,
      baseDir: environment.baseDir,
      readyFilePath: environment.path.join(environment.stateDir, LEGACY_SERVICE_READY_FILE_NAME),
      host: DEFAULT_SERVICE_HOST,
      preferredPort: defaultPort,
      version: environment.appVersion,
      secrets: yield* localServiceSecrets,
      fileSystem,
      spawner,
      httpClient,
      mac,
      random,
      pickPort: (preferred) =>
        net.findAvailablePort(preferred, DEFAULT_SERVICE_HOST).pipe(
          Effect.mapError(
            (cause) =>
              new BackendServiceDriverError({
                operation: "pickPort",
                message: "No free port for the local backend service.",
                cause,
              }),
          ),
        ),
    });
  });

  const externalBackendFailure = Effect.fn("desktop.backendService.externalBackendFailure")(
    function* (mode: DesktopBackendMode): Effect.fn.Return<string | null> {
      if (mode === "remote") {
        return "Remote backend mode can't sign this app in yet: there is no way to give it a pairing credential for the remote server.";
      }
      if (mode !== "local-service") return null;
      const driver = yield* resolveServiceDriver;
      if (driver.desktopBootstrapSecret === null) {
        return `The ${driver.kind} backend service can't sign this app in yet.`;
      }
      return yield* driver.ensureRunning.pipe(
        Effect.as(null),
        Effect.catch((error) => Effect.succeed(error.message)),
      );
    },
  );

  const prepareSelectedBackend: DesktopBackendService["Service"]["prepareSelectedBackend"] =
    Effect.gen(function* () {
      const settings = yield* appSettings.get;
      // Runs after settings load, so this sees a configured p0d override from disk.
      const p0dAvailable = yield* refreshP0dAvailability;
      const mode = resolveEffectiveBackendMode(settings, p0dAvailable);
      if (!settings.backendModeConfiguredByUser && settings.backendMode !== mode) {
        // Record what the auto default resolved to without claiming the user picked it.
        yield* appSettings.setBackendConfig({ mode, modeConfiguredByUser: false }).pipe(
          Effect.tap(() => logServiceInfo("recorded the resolved auto backend mode", { mode })),
          Effect.catch((error) =>
            logServiceWarning("failed to record the resolved backend mode", {
              error: error.message,
            }),
          ),
        );
      }
      const fallbackReason = yield* externalBackendFailure(mode);
      if (fallbackReason === null) return { mode, fallbackReason };
      // A failed binary may have disappeared or been replaced since the initial resolution.
      yield* refreshP0dAvailability;
      yield* logServiceWarning("selected backend mode failed; falling back to the in-app backend", {
        mode,
        reason: fallbackReason,
      });
      yield* appSettings
        .setBackendConfig({
          mode: "embedded",
          modeConfiguredByUser: settings.backendModeConfiguredByUser,
        })
        .pipe(
          Effect.catch((error) =>
            logServiceWarning("failed to persist the in-app backend fallback", {
              error: error.message,
            }).pipe(Effect.andThen(appSettings.applyBuiltInBackendFallbackInMemory)),
          ),
        );
      return { mode: "embedded" as const, fallbackReason };
    }).pipe(Effect.withSpan("desktop.backendService.prepareSelectedBackend"));

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
      const parsed = parseUrlOrNull(remoteUrl);
      if (parsed === null) {
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
          error: "No remote backend URL configured.",
        };
      }
      const reachable = yield* probeBackendHealth(httpClient, parsed, {
        allowLegacyWellKnown: true,
      });
      return {
        mode,
        status: reachable ? "running" : "unreachable",
        running: reachable,
        url: parsed.href,
        remoteUrl,
        binaryPath,
        resolvedBinaryPath,
        driverKind: "remote",
        version: null,
        pid: null,
        serviceInstalled: false,
        managedByService: false,
        error: reachable ? null : `Cannot reach backend at ${parsed.href}.`,
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
        managedByService: true,
        error: null,
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
    const change = yield* appSettings.setBackendConfig(input);
    return { changed: change.changed };
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
        settings,
        // An adopted legacy service has no p0d binary to make the auto default pick it, and the
        // user's projects live there, so record the choice explicitly for this recovery.
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
      prepareSelectedBackend: Effect.succeed({ mode: "embedded", fallbackReason: null }),
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
        return Effect.succeed({ changed: false });
      }),
      controlService: Effect.fn("DesktopBackendService.controlService")(function () {
        return logServiceWarning("controlService called on DesktopBackendService.layerTest");
      }),
      reattachLocalEnvironment: Effect.succeed(false),
      ...overrides,
    }),
  );
