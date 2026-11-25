import * as NodeWorkerThreads from "node:worker_threads";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { P0ApiError } from "./api.ts";

/**
 * Runs an agent's snippet in a worker thread (a busy loop is stopped by terminating it) inside a
 * `vm` context with no `require`, `process`, `fetch`, or timers. `p0` and `console` are built
 * inside that context and talk to the host in JSON strings, so no host object reaches the snippet.
 * Not a boundary against someone hunting for a `vm` escape.
 */

export interface SandboxLimits {
  readonly timeoutMs: number;
  readonly maxResultBytes: number;
  readonly maxLogLines: number;
  readonly maxLogBytes: number;
  readonly maxCalls: number;
  readonly maxHeapMb: number;
}

const SANDBOX_LIMITS: SandboxLimits = {
  timeoutMs: 5_000,
  maxResultBytes: 24_000,
  maxLogLines: 50,
  maxLogBytes: 4_000,
  maxCalls: 20,
  maxHeapMb: 64,
};

export class SandboxError extends Schema.TaggedError<SandboxError>()("SandboxError", {
  reason: Schema.Literals(["threw", "timeout", "tooLarge", "tooManyCalls", "crashed"]),
  detail: Schema.String,
  logs: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface SandboxResult {
  /** The snippet's return value as JSON; `null` when it returned nothing. */
  readonly json: string;
  readonly logs: ReadonlyArray<string>;
  readonly logsDropped: number;
}

// Compiled inside the context, so everything the snippet can reach is made there.
const BOOTSTRAP = `(function (post, pathsJson, maxLogLines, maxLogBytes) {
  "use strict";
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const PromiseCtor = Promise;
  const AsyncFunction = (async function () {}).constructor;
  const pending = new Map();
  const logs = [];
  let nextId = 0;
  let logBytes = 0;
  let logsDropped = 0;
  const text = (value) => {
    if (typeof value === "string") return value;
    try {
      const json = stringify(value);
      return json === undefined ? String(value) : json;
    } catch (error) {
      return String(value);
    }
  };
  const writer = (prefix) => (...args) => {
    const line = prefix + args.map(text).join(" ");
    if (logs.length >= maxLogLines || logBytes + line.length > maxLogBytes) {
      logsDropped += 1;
      return;
    }
    logs.push(line);
    logBytes += line.length;
  };
  const call = (path) => (options) => new PromiseCtor((resolve, reject) => {
    const id = ++nextId;
    let json;
    try {
      json = stringify(options === undefined ? null : options);
    } catch (error) {
      reject(new TypeError("p0 options must be JSON-serializable"));
      return;
    }
    pending.set(id, { resolve, reject });
    post(id, path, json === undefined ? "null" : json);
  });
  const p0 = {};
  for (const path of parse(pathsJson)) {
    const [namespace, name] = path.split(".");
    if (name === undefined) p0[namespace] = call(path);
    else {
      p0[namespace] = p0[namespace] || {};
      p0[namespace][name] = call(path);
    }
  }
  for (const key of Object.keys(p0)) if (typeof p0[key] === "object") Object.freeze(p0[key]);
  Object.freeze(p0);
  globalThis.p0 = p0;
  globalThis.console = Object.freeze({
    log: writer(""),
    info: writer(""),
    debug: writer(""),
    warn: writer("warn: "),
    error: writer("error: "),
  });
  return {
    deliver(id, ok, json) {
      const entry = pending.get(id);
      if (entry === undefined) return;
      pending.delete(id);
      if (ok) entry.resolve(parse(json));
      else entry.reject(new Error(json));
    },
    async run(code, done) {
      let ok = false;
      let json;
      try {
        const value = await new AsyncFunction(code)();
        json = stringify(value === undefined ? null : value);
        ok = true;
        if (json === undefined) json = "null";
      } catch (error) {
        try {
          json = error && error.message !== undefined ? String(error.message) : String(error);
        } catch (inner) {
          json = "The snippet threw a value that cannot be printed.";
        }
      }
      done(ok, json, stringify(logs), logsDropped);
    },
  };
})`;

const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const context = vm.createContext(Object.create(null), { codeGeneration: { wasm: false } });
const bridge = vm.runInContext(workerData.bootstrap, context)(
  (id, path, json) => parentPort.postMessage({ kind: "call", id, path, json }),
  workerData.pathsJson,
  workerData.maxLogLines,
  workerData.maxLogBytes,
);
parentPort.on("message", (message) => bridge.deliver(message.id, message.ok, message.json));
bridge.run(workerData.code, (ok, json, logsJson, logsDropped) =>
  parentPort.postMessage({ kind: "done", ok, json, logs: JSON.parse(logsJson), logsDropped }),
);
`;

// Outside Effect code: both cross the worker boundary, where bad input is the snippet's mistake.
const parseJson = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

const toJson = (value: unknown): string => JSON.stringify(value ?? null);

type FromWorker =
  | { readonly kind: "call"; readonly id: number; readonly path: string; readonly json: string }
  | {
      readonly kind: "done";
      readonly ok: boolean;
      readonly json: string;
      readonly logs: ReadonlyArray<string>;
      readonly logsDropped: number;
    };

/** What `call` answers a snippet's `p0` request with, as JSON text or an error message. */
type CallOutcome =
  | { readonly ok: true; readonly json: string }
  | { readonly ok: false; readonly json: string };

export interface SandboxInput<R> {
  readonly code: string;
  /** Functions the snippet may call, as `namespace.name`. */
  readonly paths: ReadonlyArray<string>;
  readonly call: (path: string, options: unknown) => Effect.Effect<unknown, P0ApiError, R>;
  readonly limits?: Partial<SandboxLimits>;
}

export const runSandbox = Effect.fn("P0Sandbox.run")(function* <R>(input: SandboxInput<R>) {
  const limits = { ...SANDBOX_LIMITS, ...input.limits };
  const services = yield* Effect.context<R>();
  const execute = Effect.runPromiseWith(services);

  const answer = (path: string, json: string): Effect.Effect<CallOutcome, never, R> =>
    Effect.sync(() => parseJson(json)).pipe(
      Effect.flatMap((options) => input.call(path, options)),
      Effect.map((value): CallOutcome => ({ ok: true, json: toJson(value) })),
      Effect.catchTags({
        P0ApiError: (error) => Effect.succeed<CallOutcome>({ ok: false, json: error.detail }),
      }),
      Effect.catchCause(() =>
        Effect.succeed<CallOutcome>({ ok: false, json: "That p0 call failed." }),
      ),
    );

  const finished = Effect.callback<SandboxResult, SandboxError>((resume, signal) => {
    let calls = 0;
    const worker = new NodeWorkerThreads.Worker(WORKER, {
      eval: true,
      env: {},
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: limits.maxHeapMb },
      workerData: {
        bootstrap: BOOTSTRAP,
        code: input.code,
        pathsJson: toJson(input.paths),
        maxLogLines: limits.maxLogLines,
        maxLogBytes: limits.maxLogBytes,
      },
    });
    // The callback's own cleanup runs only on interruption, so stop the worker once it settles.
    const settle = (effect: Effect.Effect<SandboxResult, SandboxError>) => {
      resume(effect);
      void worker.terminate();
    };
    const fail = (
      reason: SandboxError["reason"],
      detail: string,
      logs: ReadonlyArray<string> = [],
    ) => settle(Effect.fail(new SandboxError({ reason, detail, logs })));
    worker.on("message", (message: FromWorker) => {
      if (message.kind === "call") {
        calls += 1;
        if (calls > limits.maxCalls) {
          fail(
            "tooManyCalls",
            `More than ${limits.maxCalls} p0 calls; fetch once and filter in code.`,
          );
          return;
        }
        void execute(answer(message.path, message.json), { signal }).then(
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker thread has no origin
          (outcome) => worker.postMessage({ id: message.id, ...outcome }),
          () => undefined,
        );
        return;
      }
      if (!message.ok) {
        fail("threw", message.json, message.logs);
      } else if (Buffer.byteLength(message.json) > limits.maxResultBytes) {
        fail(
          "tooLarge",
          `The result is ${Buffer.byteLength(message.json)} bytes; the cap is ${limits.maxResultBytes}. Return less: filter, slice, or aggregate first.`,
          message.logs,
        );
      } else {
        settle(
          Effect.succeed({
            json: message.json,
            logs: message.logs,
            logsDropped: message.logsDropped,
          }),
        );
      }
    });
    worker.on("error", () => fail("crashed", "The snippet crashed or ran out of memory."));
    return Effect.promise(() => worker.terminate());
  });

  return yield* finished.pipe(
    Effect.timeoutOption(Duration.millis(limits.timeoutMs)),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new SandboxError({
              reason: "timeout",
              detail: `The snippet ran longer than ${limits.timeoutMs / 1000}s and was stopped.`,
              logs: [],
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
});
