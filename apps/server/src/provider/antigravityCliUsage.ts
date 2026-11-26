import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import { clampPercent } from "@t3tools/provider-core/server/usageLimits";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { AntigravityInstallationError } from "./AntigravityInstallation.ts";

const CLI_TIMEOUT: Duration.Input = "20 seconds";
// Every health check asks for quota, and unpacking the CLI takes a while, so keep one good read.
const CACHE_TTL_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

const WINDOWS = [
  { match: "five hour", id: "5h", kind: "session", label: "5-hour", durationMins: 300 },
  { match: "weekly", id: "weekly", kind: "weekly", label: "Weekly", durationMins: 10_080 },
] as const;

const PERCENT = /^(\d+(?:\.\d+)?)\s*%?$/u;

/** The CLI's last column is an ISO reset, or 1970 when the window has no reset. */
function resetAt(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) && DateTime.toEpochMillis(parsed.value) > 0
    ? DateTime.formatIso(parsed.value)
    : undefined;
}

/** "Gemini Models" and "Claude and GPT models" name the model families in the first column. */
function familyName(label: string): string {
  return label.replace(/\s+models?$/iu, "").trim();
}

function familyId(family: string): string {
  if (/^gemini\b/iu.test(family)) return "gemini";
  if (/\b(?:claude|gpt)\b/iu.test(family)) return "3p";
  const slug = family
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return slug || "antigravity";
}

/**
 * Parses `antigravity -p "/usage"`, whose rows are `<family>\t<window>\t<remaining>%\t<reset>`.
 * Malformed rows are skipped instead of guessed at.
 */
export function parseAntigravityCliUsage(output: string): ServerProviderUsageWindow[] {
  const windows = new Map<string, ServerProviderUsageWindow>();
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const columns = line.split("\t").map((column) => column.trim());
    if (columns.length < 3) continue;
    const family = familyName(columns[0] ?? "");
    const window = WINDOWS.find((candidate) =>
      (columns[1] ?? "").toLowerCase().includes(candidate.match),
    );
    const remaining = PERCENT.exec(columns[2] ?? "");
    if (!family || !window || remaining === null) continue;
    const remainingPercent = Number(remaining[1]);
    if (!Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100) {
      continue;
    }
    const id = `${familyId(family)}-${window.id}`;
    if (windows.has(id)) continue;
    const resetsAt = resetAt(columns[3]);
    windows.set(id, {
      id,
      kind: window.kind,
      label: `${family} · ${window.label}`,
      usedPercent: clampPercent(100 - remainingPercent),
      ...(resetsAt === undefined ? {} : { resetsAt }),
      windowDurationMins: window.durationMins,
    });
  }
  return [...windows.values()];
}

export interface AntigravityCliUsageReader {
  readonly read: Effect.Effect<ReadonlyArray<ServerProviderUsageWindow>>;
  readonly clear: Effect.Effect<void>;
}

/**
 * Runs the installed CLI's `/usage` prompt, the only source of Antigravity quota now that the
 * internal endpoints are gone. The result is cached only when it is usable, so a failed run is
 * retried on the next status check.
 */
export const makeAntigravityCliUsageReader = Effect.fn("makeAntigravityCliUsageReader")(
  function* (input: {
    readonly resolveExecutable: Effect.Effect<string, AntigravityInstallationError>;
    readonly environment: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly timeout?: Duration.Input;
    readonly cacheTtlMs?: number;
  }): Effect.fn.Return<AntigravityCliUsageReader, never, ChildProcessSpawner.ChildProcessSpawner> {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const timeout = input.timeout ?? CLI_TIMEOUT;
    const cacheTtlMs = input.cacheTtlMs ?? CACHE_TTL_MS;
    let cached:
      | { readonly at: number; readonly windows: ReadonlyArray<ServerProviderUsageWindow> }
      | undefined;

    const run = Effect.gen(function* () {
      const executablePath = yield* input.resolveExecutable;
      const child = yield* spawner.spawn(
        ChildProcess.make(executablePath, ["-p", "/usage"], {
          cwd: input.cwd,
          env: input.environment,
          extendEnv: false,
          shell: false,
          forceKillAfter: "1 second",
        }),
      );
      yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
      // stderr is drained so a chatty CLI cannot block on a full pipe.
      const [stdout, , exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout, maxBytes: MAX_OUTPUT_BYTES }),
          Stream.runDrain(child.stderr),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      );
      return exitCode === 0 && !stdout.truncated ? parseAntigravityCliUsage(stdout.text) : [];
    }).pipe(
      Effect.scoped,
      Effect.timeout(timeout),
      Effect.catchCause(() => Effect.succeed([])),
    );

    const read = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (cached !== undefined && now - cached.at < cacheTtlMs) return cached.windows;
      const windows = yield* run;
      if (windows.length > 0) cached = { at: now, windows };
      return windows;
    });

    return {
      read,
      clear: Effect.sync(() => {
        cached = undefined;
      }),
    };
  },
);
