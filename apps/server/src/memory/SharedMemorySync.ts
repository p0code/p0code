import * as HostProcess from "@t3tools/shared/HostProcess";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import {
  SharedMemoryError,
  SharedMemoryVaults,
  type SharedMemoryCommand,
  type SharedMemoryStatus,
} from "@t3tools/contracts";
import { buildSharedMemoryInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export class SharedMemorySync extends Context.Service<
  SharedMemorySync,
  {
    readonly status: Effect.Effect<SharedMemoryStatus, SharedMemoryError>;
    readonly vaults: Effect.Effect<typeof SharedMemoryVaults.Type, SharedMemoryError>;
    readonly command: (
      input: SharedMemoryCommand,
    ) => Effect.Effect<SharedMemoryStatus, SharedMemoryError>;
    readonly instructions: Effect.Effect<{ folder: string; agentId: string } | undefined>;
  }
>()("t3/memory/SharedMemorySync") {}

const Preferences = Schema.Struct({
  vault: Schema.String,
  folder: Schema.String,
  enabled: Schema.Boolean,
  paused: Schema.Boolean,
  agentId: Schema.String,
});
const Identity = Schema.Struct({ agentId: Schema.String, createdAt: Schema.String });
const decodePreferences = Schema.decodeEffect(Schema.fromJsonString(Preferences));
const encodePreferences = Schema.encodeEffect(Schema.fromJsonString(Preferences));
const decodeIdentity = Schema.decodeEffect(Schema.fromJsonString(Identity));
const encodeIdentity = Schema.encodeEffect(Schema.fromJsonString(Identity));
const decodeVaults = Schema.decodeEffect(Schema.fromJsonString(SharedMemoryVaults));
const secretName = "obsidian-shared-memory-token";
// A configurable binary lets packaged installs and tests use an absolute executable.
export const Binary = Context.Reference<string>("t3/memory/ObsidianBinary", {
  defaultValue: () => "ob",
});

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* SecureRandom.SecureRandom;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const pty = yield* PtyAdapter.PtyAdapter;
  const binary = yield* Binary;
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const home = path.join(config.stateDir, "obsidian-headless-home");
  const prefsPath = path.join(config.stateDir, "shared-memory.json");
  const authPath =
    platform === "linux"
      ? path.join(home, ".config/obsidian-headless/auth_token")
      : path.join(home, ".obsidian-headless/auth_token");
  let preferences: typeof Preferences.Type = {
    vault: "",
    folder: "",
    enabled: false,
    paused: true,
    agentId: "",
  };
  let identity = "";
  let phase: SharedMemoryStatus["phase"] = "idle";
  let lastSyncedAt: string | null = null;
  let lastError: string | null = null;
  let worker: Fiber.Fiber<void, never> | undefined;
  const stored = yield* fs.readFileString(prefsPath).pipe(Effect.result);
  if (stored._tag === "Success") {
    const decoded = yield* decodePreferences(stored.success).pipe(Effect.result);
    if (decoded._tag === "Success") preferences = decoded.success;
    else lastError = "Saved shared memory configuration could not be read.";
  }
  yield* fs.makeDirectory(home, { recursive: true, mode: 0o700 });
  const token = secrets
    .get(secretName)
    .pipe(Effect.mapError(() => new SharedMemoryError({ stage: "read credential" })));
  const environment = Effect.fn("SharedMemorySync.environment")(function* () {
    const saved = yield* token;
    return {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      OBSIDIAN_AUTH_TOKEN: Option.isSome(saved) ? Buffer.from(saved.value).toString("utf8") : "",
    };
  });
  const nodeSupported = Number(process.versions.node.split(".")[0]) >= 22;
  const run = Effect.fn("SharedMemorySync.run")(function* (
    args: string[],
    stdin = "",
    onLine?: (line: string) => Effect.Effect<void>,
  ) {
    if (!nodeSupported) return yield* new SharedMemoryError({ stage: "Node 22 requirement" });
    const env = yield* environment();
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const resolved = yield* resolveSpawnCommand(binary, args, { env, extendEnv: false });
        const child = yield* spawner.spawn(
          ChildProcess.make(resolved.command, resolved.args, {
            shell: resolved.shell,
            env,
            extendEnv: false,
            stdin: Stream.make(Buffer.from(stdin)),
          }),
        );
        const [output, , code] = yield* Effect.all(
          [
            child.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.tap((line) => onLine?.(line) ?? Effect.void),
              Stream.runFold(
                () => "",
                (text, chunk) => (text + chunk + "\n").slice(-1_000_000),
              ),
            ),
            child.stderr.pipe(Stream.runDrain),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (code !== 0) return yield* new SharedMemoryError({ stage: args[0] ?? "command" });
        return output;
      }),
    ).pipe(
      (effect) =>
        args.includes("--continuous") ? effect : effect.pipe(Effect.timeout("90 seconds")),
      Effect.mapError(() => new SharedMemoryError({ stage: args[0] ?? "command" })),
    );
  });
  const save = Effect.fn("SharedMemorySync.save")(
    function* () {
      yield* fs.writeFileString(`${prefsPath}.tmp`, yield* encodePreferences(preferences), {
        mode: 0o600,
      });
      yield* fs.rename(`${prefsPath}.tmp`, prefsPath);
    },
    Effect.mapError(() => new SharedMemoryError({ stage: "save preferences" })),
  );
  const readIdentity = Effect.fn("SharedMemorySync.readIdentity")(
    function* () {
      const text = yield* fs.readFileString(path.join(preferences.folder, "agent.json"));
      const value = yield* decodeIdentity(text);
      identity = value.agentId;
      return identity;
    },
    Effect.mapError(() => new SharedMemoryError({ stage: "read shared identity" })),
  );
  const skeleton = Effect.fn("SharedMemorySync.skeleton")(
    function* () {
      for (const dir of ["notes", "issues"])
        yield* fs.makeDirectory(path.join(preferences.folder, dir), { recursive: true });
      const files = {
        "agent.json": yield* encodeIdentity({
          agentId: yield* crypto.uuidV4(),
          createdAt: DateTime.formatIso(yield* DateTime.now),
        }),
        "MEMORY.md":
          "# Shared memory\n\nLink durable one-fact notes here.\n\n## Notes\n\n## Issues\n",
        "README.md":
          "# Shared agent memory\n\nRead MEMORY.md before work. Store one durable fact per Markdown note in notes/ and link it from MEMORY.md. After a notable fix, add issues/YYYY-MM-DD-<slug>.md with problem, root cause, fix, repo, and machine. Preserve concurrent agents' notes and never store credentials. agent.json holds the shared identity; keep it synced.\n\nFor Claude Code, Codex CLI, and other harnesses outside T3, copy the instruction snippet from Settings → Shared memory into the harness instructions, using that machine's absolute vault path.\n\nDo not enable Obsidian desktop Sync for a vault managed by Headless Sync on the same machine.\n",
      };
      for (const [name, content] of Object.entries(files)) {
        yield* fs
          .writeFileString(path.join(preferences.folder, name), content, { flag: "wx" })
          .pipe(
            Effect.catchTags({
              PlatformError: (error) =>
                error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error),
            }),
          );
      }
      yield* readIdentity();
    },
    Effect.mapError(() => new SharedMemoryError({ stage: "initialize vault" })),
  );
  const stop = Effect.fn("SharedMemorySync.stop")(function* () {
    if (worker) {
      yield* Fiber.interrupt(worker);
      worker = undefined;
    }
    phase = "idle";
  });
  const start = Effect.fn("SharedMemorySync.start")(function* () {
    yield* stop();
    if (!preferences.folder || preferences.paused || Option.isNone(yield* token)) return;
    const sync = Effect.gen(function* () {
      let failures = 0;
      while (true) {
        phase = "syncing";
        yield* run(["sync", "--path", preferences.folder, "--continuous"], "", (line) =>
          line.includes("Fully synced")
            ? Effect.gen(function* () {
                lastSyncedAt = DateTime.formatIso(yield* DateTime.now);
                lastError = null;
                failures = 0;
                phase = "idle";
                yield* readIdentity().pipe(Effect.ignore);
              })
            : Effect.void,
        ).pipe(Effect.ignore);
        phase = "error";
        lastError = "Obsidian sync stopped unexpectedly; reconnecting.";
        failures++;
        yield* Effect.sleep(Math.min(60, failures ? 2 ** Math.min(failures, 6) : 10) * 1000);
      }
    });
    worker = yield* sync.pipe(Effect.forkIn(scope));
  });
  const instructions = Effect.gen(function* () {
    if (!preferences.enabled || !preferences.folder || Option.isNone(yield* token))
      return undefined;
    const result = yield* readIdentity().pipe(Effect.result);
    if (result._tag === "Failure") return undefined;
    return { folder: preferences.folder, agentId: preferences.agentId || result.success };
  }).pipe(Effect.orElseSucceed(() => undefined));
  const status = Effect.fn("SharedMemorySync.status")(function* () {
    const memory = preferences.folder
      ? { folder: preferences.folder, agentId: preferences.agentId || identity }
      : undefined;
    return {
      connected: Option.isSome(yield* token),
      phase,
      ...preferences,
      agentId: memory?.agentId ?? "",
      lastSyncedAt,
      lastError,
      snippet: memory ? buildSharedMemoryInstructions(memory) : "",
    };
  });
  const login = Effect.fn("SharedMemorySync.login")(function* (
    input: Extract<SharedMemoryCommand, { action: "login" }>,
  ) {
    yield* stop();
    const env = yield* environment();
    env.OBSIDIAN_AUTH_TOKEN = "";
    yield* fs
      .remove(authPath, { force: true })
      .pipe(Effect.mapError(() => new SharedMemoryError({ stage: "clear credential" })));
    // The official CLI's piped input reads until EOF, so use a private PTY for its sequential prompts.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* pty
          .spawn({ shell: binary, args: ["login"], cwd: home, cols: 80, rows: 24, env })
          .pipe(Effect.mapError(() => new SharedMemoryError({ stage: "login" })));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              child.kill();
            } catch {}
          }),
        );
        yield* Effect.callback<void, SharedMemoryError>((resume) => {
          let pending = "";
          const sent = new Set<string>();
          const offData = child.onData((data) => {
            pending = (pending + data).slice(-4096);
            for (const [prompt, value] of [
              ["Email: ", input.email],
              ["Password: ", input.password],
              ["2FA code: ", input.mfa ?? ""],
            ] as const) {
              if (!sent.has(prompt) && pending.includes(prompt)) {
                sent.add(prompt);
                pending = "";
                if (!value || /[\r\n\x03]/.test(value)) {
                  resume(
                    Effect.fail(new SharedMemoryError({ stage: "login (MFA may be required)" })),
                  );
                  return;
                }
                child.write(value);
                child.write("\r");
              }
            }
          });
          const offExit = child.onExit(({ exitCode }) =>
            resume(
              exitCode === 0 ? Effect.void : Effect.fail(new SharedMemoryError({ stage: "login" })),
            ),
          );
          return Effect.sync(() => {
            offData();
            offExit();
          });
        }).pipe(
          Effect.timeout("90 seconds"),
          Effect.mapError(() => new SharedMemoryError({ stage: "login" })),
        );
        const bytes = yield* fs
          .readFile(authPath)
          .pipe(Effect.mapError(() => new SharedMemoryError({ stage: "read login token" })));
        yield* secrets
          .set(secretName, bytes)
          .pipe(Effect.mapError(() => new SharedMemoryError({ stage: "save credential" })));
      }),
    ).pipe(Effect.ensuring(fs.remove(authPath, { force: true }).pipe(Effect.ignore)));
  });
  const command = Effect.fn("SharedMemorySync.command")(
    function* (input: SharedMemoryCommand) {
      switch (input.action) {
        case "login":
          yield* login(input);
          break;
        case "configure": {
          yield* stop();
          const folder =
            input.folder.trim() ||
            path.join(
              config.stateDir,
              "shared-memory",
              Buffer.from(input.vault).toString("base64url"),
            );
          if (!path.isAbsolute(folder) || !input.vault.trim())
            return yield* new SharedMemoryError({ stage: "validate vault path" });
          yield* run(
            ["sync-setup", "--vault", input.vault, "--path", folder],
            input.password ?? "",
          );
          // JSON identity files require Obsidian Sync's unsupported-file category.
          yield* run([
            "sync-config",
            "--path",
            folder,
            "--file-types",
            "image,audio,video,pdf,unsupported",
          ]);
          yield* run(["sync", "--path", folder]);
          lastSyncedAt = DateTime.formatIso(yield* DateTime.now);
          preferences = { ...preferences, vault: input.vault, folder, paused: false };
          // Pull first so a second machine adopts the existing vault identity.
          yield* skeleton();
          yield* save();
          yield* start();
          break;
        }
        case "preferences":
          preferences = { ...preferences, enabled: input.enabled, agentId: input.agentId.trim() };
          yield* save();
          break;
        case "pause":
          preferences = { ...preferences, paused: true };
          yield* stop();
          yield* save();
          break;
        case "resume":
          preferences = { ...preferences, paused: false };
          yield* save();
          yield* start();
          break;
        case "logout":
          yield* stop();
          yield* run(["logout"]);
          yield* secrets
            .remove(secretName)
            .pipe(Effect.mapError(() => new SharedMemoryError({ stage: "remove credential" })));
          preferences = { ...preferences, enabled: false, paused: true };
          yield* save();
          break;
      }
      lastError = null;
      return yield* status();
    },
    Effect.tapError((error) =>
      Effect.sync(() => {
        lastError = error.message;
        phase = "error";
      }),
    ),
    lock.withPermits(1),
  );
  if (preferences.folder) yield* readIdentity().pipe(Effect.ignore);
  yield* start().pipe(Effect.ignore);
  return SharedMemorySync.of({
    status: status(),
    instructions,
    command,
    vaults: run(["sync-list-remote", "--json"]).pipe(
      Effect.flatMap((output) => decodeVaults(output)),
      Effect.mapError(() => new SharedMemoryError({ stage: "list vaults" })),
    ),
  });
});
export const layer = Layer.effect(SharedMemorySync, make);
