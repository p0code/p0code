import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type { Argv } from "./commands.ts";

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecOptions {
  /** Written to the process's stdin. Used for secrets so they never appear in argv. */
  readonly stdin?: string;
  /** Long-running step (build, transfer): echo its output live when the shell is verbose. */
  readonly stream?: boolean;
}

export interface ShellShape {
  /** Never fails: a command that cannot start reports exit code 127. */
  readonly exec: (argv: Argv, options?: ExecOptions) => Effect.Effect<ExecResult>;
  /** Runs `a | b | ...` without a local shell. Returns one result per stage; stdout is only kept for the last. */
  readonly pipe: (
    stages: ReadonlyArray<Argv>,
    options?: Pick<ExecOptions, "stream">,
  ) => Effect.Effect<ReadonlyArray<ExecResult>>;
  /** Human progress line; dropped in --json mode. */
  readonly note: (message: string) => Effect.Effect<void>;
}

export class Shell extends Context.Service<Shell, ShellShape>()("@t3tools/p0deploy/shell") {}

const encoder = new TextEncoder();
const SPAWN_FAILED = 127;

const collect = (
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  echo: boolean,
): Effect.Effect<string, PlatformError.PlatformError> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (output, chunk) => {
        if (echo) process.stderr.write(chunk);
        return output + chunk;
      },
    ),
  );

export const makeShell = Effect.fn("p0deploy.makeShell")(function* (options: {
  readonly verbose: boolean;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const spawn = (argv: Argv, stdin: ChildProcess.CommandInput) => {
    const [command = "", ...args] = argv;
    return spawner.spawn(ChildProcess.make(command, args, { stdin: { stream: stdin } }));
  };

  const failedToStart = (argv: Argv, cause: unknown): ExecResult => ({
    exitCode: SPAWN_FAILED,
    stdout: "",
    stderr: `${argv[0]}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

  const exec: ShellShape["exec"] = (argv, execOptions) => {
    const echo = options.verbose && execOptions?.stream === true;
    return Effect.gen(function* () {
      const stdin =
        execOptions?.stdin === undefined
          ? "ignore"
          : Stream.make(encoder.encode(execOptions.stdin));
      const handle = yield* spawn(argv, stdin);
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [collect(handle.stdout, echo), collect(handle.stderr, echo), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return { exitCode: Number(exitCode), stdout, stderr };
    }).pipe(
      Effect.scoped,
      Effect.catch((cause) => Effect.succeed(failedToStart(argv, cause))),
    );
  };

  const pipe: ShellShape["pipe"] = (stages, pipeOptions) => {
    const echo = options.verbose && pipeOptions?.stream === true;
    return Effect.gen(function* () {
      const handles: Array<ChildProcessSpawner.ChildProcessHandle> = [];
      for (const argv of stages) {
        const previous = handles.at(-1);
        handles.push(yield* spawn(argv, previous ? previous.stdout : "ignore"));
      }
      return yield* Effect.forEach(
        handles,
        (handle, index) =>
          Effect.all(
            [
              index === handles.length - 1 ? collect(handle.stdout, false) : Effect.succeed(""),
              collect(handle.stderr, echo),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          ).pipe(
            Effect.map(([stdout, stderr, exitCode]) => ({
              exitCode: Number(exitCode),
              stdout,
              stderr,
            })),
          ),
        { concurrency: "unbounded" },
      );
    }).pipe(
      Effect.scoped,
      Effect.catch((cause) => Effect.succeed(stages.map((argv) => failedToStart(argv, cause)))),
    );
  };

  const note = Effect.fn("Shell.note")(function* (message: string) {
    if (options.verbose) yield* Console.error(message);
  });

  return Shell.of({ exec, pipe, note });
});

/** Real processes. Needs a ChildProcessSpawner, e.g. from `@effect/platform-node/NodeServices`. */
export const layerShell = (options: { readonly verbose: boolean }) =>
  Layer.effect(Shell, makeShell(options));
