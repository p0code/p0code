import {
  type DesktopBackendAction,
  type DesktopBackendConfigUpdate,
  type DesktopBackendMode,
  type DesktopBackendStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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

const { logWarning: logServiceWarning } =
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

export function resolveEffectiveBackendMode(
  settings: Pick<DesktopAppSettings.DesktopSettings, "backendMode" | "backendModeConfiguredByUser">,
  hasPackagedP0d: boolean,
): DesktopBackendMode {
  if (settings.backendModeConfiguredByUser) {
    return settings.backendMode;
  }
  return hasPackagedP0d ? "local-service" : "legacy-embedded";
}

function p0dBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "p0d.exe" : "p0d";
}

function p0dDistSubdirs(platform: NodeJS.Platform, arch: string): readonly string[] {
  const osNames =
    platform === "darwin"
      ? ["darwin", "mac"]
      : platform === "win32"
        ? ["windows", "win", "win32"]
        : ["linux"];
  const archNames = arch === "x64" ? ["amd64", "x64"] : arch === "arm64" ? ["arm64"] : [arch];
  const subdirs: string[] = [];
  for (const osName of osNames) {
    for (const archName of archNames) {
      subdirs.push(`${osName}-${archName}`);
    }
  }
  return subdirs;
}

function packagedP0dBinaryCandidates(input: {
  readonly path: Pick<Path.Path, "join">;
  readonly platform: NodeJS.Platform;
  readonly resourcesPath: string;
}): readonly string[] {
  const binaryName = p0dBinaryName(input.platform);
  return [
    input.path.join(input.resourcesPath, "p0d", binaryName),
    input.path.join(input.resourcesPath, "bin", binaryName),
  ];
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
  const binaryName = p0dBinaryName(input.platform);
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
  if (!input.isPackaged) {
    for (const subdir of p0dDistSubdirs(input.platform, input.arch)) {
      pushUnique(input.path.join(input.rootDir, "apps", "p0d", "dist", subdir, binaryName));
    }
  }
  pushUnique(input.path.join(input.baseDir, "bin", binaryName));
  pushUnique(input.path.join(input.baseDir, "p0d", "bin", binaryName));
  pushUnique(input.path.join(input.homeDirectory, ".p0code", "bin", binaryName));
  if (input.platform === "win32") {
    pushUnique(
      input.path.join(input.appDataDirectory, "..", "Local", "p0code", "p0d", "bin", binaryName),
    );
  } else if (input.platform === "linux") {
    pushUnique(
      input.path.join(input.homeDirectory, ".local", "share", "p0code", "p0d", "bin", binaryName),
    );
    pushUnique("/usr/local/bin/p0d");
  } else if (input.platform === "darwin") {
    pushUnique("/opt/homebrew/bin/p0d");
    pushUnique("/usr/local/bin/p0d");
  }
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
    status: probeStatus,
    ensureRunning,
    start,
    stop,
    restart,
  };
}

export interface MakeLegacyNodeServiceDriverInput {
  readonly executablePath: string;
  readonly entryPath: string;
  readonly cwd: string;
  readonly stateDir: string;
  readonly baseDir: string;
  readonly readyFilePath: string;
  readonly host: string;
  readonly port: number;
  readonly version: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly httpClient: HttpClient.HttpClient;
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
  const defaultUrl = new URL(`http://${input.host}:${input.port}`);
  const killProcess = input.killProcess ?? defaultKillProcess;
  const waitTimeout = input.waitTimeout ?? SERVICE_START_WAIT_TIMEOUT;
  const pollInterval = input.pollInterval ?? SERVICE_START_POLL_INTERVAL;

  const probeStatus: Effect.Effect<BackendServiceInfo> = Effect.gen(function* () {
    const readyFile = yield* readReadyFileFromDisk(input.fileSystem, input.readyFilePath);
    const candidateUrl = parseUrlOrNull(readyFile?.url ?? null) ?? defaultUrl;
    const healthy = yield* probeBackendHealth(input.httpClient, candidateUrl, {
      allowLegacyWellKnown: true,
    });
    return {
      running: healthy,
      installed: yield* input.fileSystem
        .exists(input.entryPath)
        .pipe(Effect.orElseSucceed(() => false)),
      pid: healthy ? (readyFile?.pid ?? null) : null,
      version: readyFile?.version ?? input.version,
      url: healthy ? candidateUrl : null,
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

      const pid = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* input.spawner
            .spawn(
              ChildProcess.make(
                input.executablePath,
                [
                  input.entryPath,
                  "--no-browser",
                  "--host",
                  input.host,
                  "--port",
                  String(input.port),
                ],
                {
                  cwd: input.cwd,
                  detached: true,
                  env: {
                    ELECTRON_RUN_AS_NODE: "1",
                    P0D_HOME: input.baseDir,
                    T3CODE_HOME: input.baseDir,
                  },
                  extendEnv: true,
                  stdin: "ignore",
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
          yield* handle.unref.pipe(Effect.ignore);
          return Number(handle.pid);
        }),
      );

      yield* encodeReadyFileJson({
        pid,
        port: input.port,
        url: defaultUrl.href,
        version: input.version,
      }).pipe(
        Effect.flatMap((encoded) =>
          input.fileSystem
            .makeDirectory(input.stateDir, { recursive: true })
            .pipe(
              Effect.andThen(input.fileSystem.writeFileString(input.readyFilePath, `${encoded}\n`)),
            ),
        ),
        Effect.ignore,
      );

      const becameHealthy = yield* probeBackendHealth(input.httpClient, defaultUrl, {
        allowLegacyWellKnown: true,
      }).pipe(
        Effect.repeat({
          until: (ok) => ok,
          schedule: Schedule.spaced(pollInterval),
        }),
        Effect.timeoutOption(waitTimeout),
      );
      if (Option.isNone(becameHealthy) || !becameHealthy.value) {
        return yield* new BackendServiceDriverError({
          operation: "waitForHealthz",
          message: `Timed out waiting for legacy Node backend at ${defaultUrl.href}.`,
        });
      }

      return {
        running: true,
        installed: true,
        pid,
        version: input.version,
        url: defaultUrl,
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
    const readyFile = yield* readReadyFileFromDisk(input.fileSystem, input.readyFilePath);
    if (readyFile?.pid !== null && readyFile?.pid !== undefined) {
      yield* killProcess(readyFile.pid);
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
    readonly hasPackagedP0d: Effect.Effect<boolean>;
    readonly resolveEffectiveMode: Effect.Effect<DesktopBackendMode>;
    readonly findP0dBinary: Effect.Effect<Option.Option<string>>;
    readonly resolveServiceDriver: Effect.Effect<BackendServiceDriver>;
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
  }
>()("@t3tools/desktop/backend/DesktopBackendService") {}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;

  const firstExistingPath = Effect.fn("desktop.backendService.firstExistingPath")(function* (
    candidates: readonly string[],
  ) {
    for (const candidate of candidates) {
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return Option.some(candidate);
      }
    }
    return Option.none<string>();
  });

  const hasPackagedP0d = firstExistingPath(
    packagedP0dBinaryCandidates({
      path: environment.path,
      platform: environment.platform,
      resourcesPath: environment.resourcesPath,
    }),
  ).pipe(Effect.map(Option.isSome));

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

  const resolveEffectiveMode = Effect.gen(function* () {
    const settings = yield* appSettings.get;
    const packaged = yield* hasPackagedP0d;
    return resolveEffectiveBackendMode(
      {
        backendMode:
          settings.backendMode ?? DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS.backendMode,
        backendModeConfiguredByUser: settings.backendModeConfiguredByUser ?? false,
      },
      packaged,
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
      port: defaultPort,
      version: environment.appVersion,
      fileSystem,
      spawner,
      httpClient,
    });
  });

  const getStatus: DesktopBackendService["Service"]["getStatus"] = Effect.fn(
    "desktop.backendService.getStatus",
  )(function* (embedded) {
    const settings = yield* appSettings.get;
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

  return DesktopBackendService.of({
    hasPackagedP0d,
    resolveEffectiveMode,
    findP0dBinary,
    resolveServiceDriver,
    getStatus,
    updateConfig,
    controlService,
  });
});

export const layer = Layer.effect(DesktopBackendService, make);

export const layerTest = (
  overrides: Partial<DesktopBackendService["Service"]> = {},
): Layer.Layer<DesktopBackendService> =>
  Layer.succeed(
    DesktopBackendService,
    DesktopBackendService.of({
      hasPackagedP0d: Effect.succeed(false),
      resolveEffectiveMode: Effect.succeed("legacy-embedded"),
      findP0dBinary: Effect.succeedNone,
      resolveServiceDriver: Effect.die("DesktopBackendService.layerTest resolveServiceDriver"),
      getStatus: Effect.fn("DesktopBackendService.getStatus")(function () {
        return Effect.succeed({
          mode: "legacy-embedded" as const,
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
      ...overrides,
    }),
  );
