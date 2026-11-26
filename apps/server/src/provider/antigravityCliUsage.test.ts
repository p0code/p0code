import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { makeUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/http";

import { makeAntigravityCliUsageReader, parseAntigravityCliUsage } from "./antigravityCliUsage.ts";

// The exact output of `antigravity -p "/usage"`.
const usageOutput = [
  "Gemini Models\tWeekly Limit Remaining\t100%\t2026-12-03T14:49:44Z",
  "Claude and GPT models\tWeekly Limit Remaining\t100%\t1970-01-01T00:00:00Z",
  "Claude and GPT models\tFive Hour Limit Remaining\t100%\t1970-01-01T00:00:00Z",
].join("\n");

const expectedWindows = [
  {
    id: "gemini-weekly",
    kind: "weekly" as const,
    label: "Gemini · Weekly",
    usedPercent: 0,
    resetsAt: "2026-12-03T14:49:44.000Z",
    windowDurationMins: 10_080,
  },
  {
    id: "3p-weekly",
    kind: "weekly" as const,
    label: "Claude and GPT · Weekly",
    usedPercent: 0,
    windowDurationMins: 10_080,
  },
  {
    id: "3p-5h",
    kind: "session" as const,
    label: "Claude and GPT · 5-hour",
    usedPercent: 0,
    windowDurationMins: 300,
  },
];

const writeFakeCli = Effect.fn("AntigravityCliUsageTest.writeFakeCli")(function* (body: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-cli-" });
  const executable = path.join(directory, "antigravity");
  yield* fs.writeFileString(executable, `#!/bin/sh\n${body}\n`);
  yield* fs.chmod(executable, 0o755);
  yield* fs.makeDirectory(path.join(directory, "antigravity-acp"));
  yield* fs.writeFileString(
    path.join(directory, "antigravity-acp", "antigravity-oauth-token"),
    JSON.stringify({ token: { access_token: "fixture-token" } }),
  );
  return { directory, executable };
});

describe("Antigravity CLI /usage parsing", () => {
  it("maps the CLI's tab-separated rows into usage windows", () => {
    expect(parseAntigravityCliUsage(usageOutput)).toEqual(expectedWindows);
  });

  it("treats a 1970 reset as no reset and reads a decimal remaining percent", () => {
    const windows = parseAntigravityCliUsage(
      [
        "Gemini Models\tWeekly Limit Remaining\t96.5%\t1970-01-01T00:00:00Z",
        "Gemini Models\tFive Hour Limit Remaining\t0%\t2026-12-03T14:49:44Z",
      ].join("\n"),
    );
    expect(windows).toEqual([
      {
        id: "gemini-weekly",
        kind: "weekly",
        label: "Gemini · Weekly",
        usedPercent: 3.5,
        windowDurationMins: 10_080,
      },
      {
        id: "gemini-5h",
        kind: "session",
        label: "Gemini · 5-hour",
        usedPercent: 100,
        resetsAt: "2026-12-03T14:49:44.000Z",
        windowDurationMins: 300,
      },
    ]);
  });

  it("tolerates blank lines, extra columns and whitespace, and skips malformed rows", () => {
    const windows = parseAntigravityCliUsage(
      [
        "",
        "  Gemini Models \t Weekly Limit Remaining \t 42 % \t 2026-12-03T14:49:44Z \textra ",
        "Gemini Models\tWeekly Limit Remaining\tnot-a-number\t2026-12-03T14:49:44Z",
        "Gemini Models\tWeekly Limit Remaining\t150%\t2026-12-03T14:49:44Z",
        "Gemini Models\tMonthly Limit Remaining\t50%\t2026-12-03T14:49:44Z",
        "Gemini Models\tWeekly Limit Remaining",
        "\t\t\t",
        "Claude and GPT models\tFive Hour Limit Remaining\t25%\t2026-12-03T14:49:44Z",
        "",
      ].join("\n"),
    );
    expect(windows).toEqual([
      {
        id: "gemini-weekly",
        kind: "weekly",
        label: "Gemini · Weekly",
        usedPercent: 58,
        resetsAt: "2026-12-03T14:49:44.000Z",
        windowDurationMins: 10_080,
      },
      {
        id: "3p-5h",
        kind: "session",
        label: "Claude and GPT · 5-hour",
        usedPercent: 75,
        resetsAt: "2026-12-03T14:49:44.000Z",
        windowDurationMins: 300,
      },
    ]);
  });

  it("returns no windows for empty or unrelated output", () => {
    expect(parseAntigravityCliUsage("")).toEqual([]);
    expect(parseAntigravityCliUsage("\n\n  \n")).toEqual([]);
    expect(parseAntigravityCliUsage("no quota available\n")).toEqual([]);
  });

  it("feeds the existing usage-limit shape and ordering", () => {
    const limits = makeUsageLimits({
      checkedAt: "2026-12-01T00:00:00.000Z",
      windows: parseAntigravityCliUsage(usageOutput),
    });
    expect(limits.windows.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: "3p-5h", kind: "session" },
      { id: "3p-weekly", kind: "weekly" },
      { id: "gemini-weekly", kind: "weekly" },
    ]);
    expect(limits.windows[0]?.label).toBe("Claude and GPT · 5-hour");
    expect(limits.windows[0]?.resetsAt).toBeUndefined();
  });
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "Antigravity CLI /usage reader",
  () => {
    it.effect("parses a fake CLI's output and caches the good result within the TTL", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const counter = path.join(yield* fs.makeTempDirectoryScoped(), "runs");
        const { directory, executable } = yield* writeFakeCli(
          [
            'echo run >> "$COUNTER"',
            `printf '${usageOutput.replaceAll("\t", "\\t").replaceAll("%", "%%").replaceAll("\n", "\\n")}\\n'`,
          ].join("\n"),
        );
        const reader = yield* makeAntigravityCliUsageReader({
          resolveExecutable: Effect.succeed(executable),
          environment: { ...process.env, COUNTER: counter },
          cwd: directory,
          cacheTtlMs: 2 * 60_000,
        });

        expect(yield* reader.read).toEqual(expectedWindows);
        expect(yield* reader.read).toEqual(expectedWindows);
        expect((yield* fs.readFileString(counter)).trim().split("\n")).toHaveLength(1);

        yield* TestClock.adjust("3 minutes");
        yield* reader.read;
        expect((yield* fs.readFileString(counter)).trim().split("\n")).toHaveLength(2);

        yield* reader.clear;
        yield* reader.read;
        expect((yield* fs.readFileString(counter)).trim().split("\n")).toHaveLength(3);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.effect(
      "never borrows a default profile and invalidates cached usage when its credential changes",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { directory, executable } = yield* writeFakeCli(
            [
              'test -n "$SSH_CONNECTION" || exit 1',
              'test "$AGY_ACP_FORCE_FILE_STORAGE" = "1" || exit 1',
              'cat "$GEMINI_HOME/answer"',
            ].join("\n"),
          );
          const credentialPath = path.join(directory, "antigravity-acp", "antigravity-oauth-token");
          const token = yield* fs.readFileString(credentialPath);
          yield* fs.remove(credentialPath);
          yield* fs.writeFileString(path.join(directory, "answer"), usageOutput);
          const reader = yield* makeAntigravityCliUsageReader({
            resolveExecutable: Effect.die("must not start without its credential"),
            environment: process.env,
            cwd: directory,
          });
          expect(yield* reader.read).toEqual([]);
          const signedIn = yield* makeAntigravityCliUsageReader({
            resolveExecutable: Effect.succeed(executable),
            environment: process.env,
            cwd: directory,
          });
          yield* fs.writeFileString(credentialPath, token);
          expect(yield* signedIn.read).toEqual(expectedWindows);
          yield* fs.writeFileString(
            credentialPath,
            JSON.stringify({ token: { access_token: "another-account" } }),
          );
          yield* fs.writeFileString(
            path.join(directory, "answer"),
            "Gemini Models\tWeekly Limit Remaining\t50%\t1970-01-01T00:00:00Z",
          );
          expect((yield* signedIn.read)[0]?.usedPercent).toBe(50);
          yield* fs.remove(credentialPath);
          expect(yield* signedIn.read).toEqual([]);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.live("reports no windows without crashing on a non-zero exit", () =>
      Effect.gen(function* () {
        const { directory, executable } = yield* writeFakeCli("echo no quota >&2\nexit 7");
        const reader = yield* makeAntigravityCliUsageReader({
          resolveExecutable: Effect.succeed(executable),
          environment: process.env,
          cwd: directory,
        });
        expect(yield* reader.read).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.live("reports no windows without crashing when the CLI hangs past the timeout", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const marker = path.join(yield* fs.makeTempDirectoryScoped(), "finished");
        const { directory, executable } = yield* writeFakeCli('sleep 1\necho done >> "$MARKER"');
        const reader = yield* makeAntigravityCliUsageReader({
          resolveExecutable: Effect.succeed(executable),
          environment: { ...process.env, MARKER: marker },
          cwd: directory,
          timeout: "100 millis",
        });
        expect(yield* reader.read).toEqual([]);
        // A killed CLI never reaches its final line.
        expect(yield* fs.exists(marker)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.live("never contacts Google for quota, even when an HTTP client is available", () =>
      Effect.gen(function* () {
        const requests = yield* Ref.make(0);
        const { directory, executable } = yield* writeFakeCli(
          `printf '${usageOutput.replaceAll("\t", "\\t").replaceAll("%", "%%").replaceAll("\n", "\\n")}\\n'`,
        );
        const reader = yield* makeAntigravityCliUsageReader({
          resolveExecutable: Effect.succeed(executable),
          environment: process.env,
          cwd: directory,
        });
        const windows = yield* reader.read.pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() =>
              Ref.update(requests, (count) => count + 1).pipe(
                Effect.andThen(Effect.die("Antigravity quota must not call Google")),
              ),
            ),
          ),
        );
        expect(windows).toEqual(expectedWindows);
        expect(yield* Ref.get(requests)).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  },
);
