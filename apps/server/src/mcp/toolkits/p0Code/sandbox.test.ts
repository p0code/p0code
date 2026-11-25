import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { P0ApiError } from "./api.ts";
import { runSandbox, SandboxError } from "./sandbox.ts";

const PATHS = ["usage.limits", "usage.costs", "help"];

const run = (code: string, limits?: Parameters<typeof runSandbox>[0]["limits"]) => {
  const calls: Array<{ readonly path: string; readonly options: unknown }> = [];
  const effect = runSandbox({
    code,
    paths: PATHS,
    ...(limits === undefined ? {} : { limits }),
    call: (path, options) => {
      calls.push({ path, options });
      return path === "usage.costs"
        ? Effect.fail(new P0ApiError({ detail: "no spend today" }))
        : Effect.succeed({ path, options });
    },
  });
  return { calls, effect };
};

const failure = (code: string, limits?: Parameters<typeof runSandbox>[0]["limits"]) =>
  run(code, limits).effect.pipe(Effect.flip);

it.live("returns the snippet's value as JSON and captures console output", () =>
  Effect.gen(function* () {
    const result = yield* run(`
      console.log("hello", { a: 1 });
      console.warn("careful");
      return { sum: [1, 2, 3].reduce((a, b) => a + b, 0) };
    `).effect;
    expect(JSON.parse(result.json)).toEqual({ sum: 6 });
    expect(result.logs).toEqual(['hello {"a":1}', "warn: careful"]);
    expect(result.logsDropped).toBe(0);
  }),
);

it.live("answers null when the snippet returns nothing", () =>
  Effect.gen(function* () {
    expect((yield* run("const x = 1;").effect).json).toBe("null");
  }),
);

it.live("passes p0 calls through as JSON and returns what the host answers", () =>
  Effect.gen(function* () {
    const { calls, effect } = run(`
      const first = await p0.usage.limits({ since: "2026-01-01" });
      const second = await p0.help("usage");
      return [first, second];
    `);
    const result = yield* effect;
    expect(calls).toEqual([
      { path: "usage.limits", options: { since: "2026-01-01" } },
      { path: "help", options: "usage" },
    ]);
    expect(JSON.parse(result.json)).toEqual([
      { path: "usage.limits", options: { since: "2026-01-01" } },
      { path: "help", options: "usage" },
    ]);
  }),
);

it.live("lets the snippet catch a failed p0 call", () =>
  Effect.gen(function* () {
    const result = yield* run(`
      try { await p0.usage.costs(); } catch (error) { return error.message; }
    `).effect;
    expect(JSON.parse(result.json)).toBe("no spend today");
  }),
);

it.live("reaches no host capability", () =>
  Effect.gen(function* () {
    const result = yield* run(`
      return [
        typeof process, typeof require, typeof fetch, typeof setTimeout, typeof Buffer,
        typeof module, typeof WebAssembly === "undefined" ? "none" : "has",
      ];
    `).effect;
    expect(JSON.parse(result.json)).toEqual([
      "undefined",
      "undefined",
      "undefined",
      "undefined",
      "undefined",
      "undefined",
      "has",
    ]);
  }),
);

it.live("cannot climb out through constructors of anything it can touch", () =>
  Effect.gen(function* () {
    const result = yield* run(`
      const probe = "return typeof process";
      const attempts = [
        () => (() => {}).constructor(probe)(),
        () => p0.usage.limits.constructor(probe)(),
        () => console.log.constructor(probe)(),
        () => this.constructor.constructor(probe)(),
        () => Object.getPrototypeOf(p0).constructor.constructor(probe)(),
      ];
      return attempts.map((attempt) => { try { return attempt(); } catch (error) { return "threw"; } });
    `).effect;
    // Each answer comes from the snippet's own realm, where `process` does not exist.
    for (const answer of JSON.parse(result.json) as ReadonlyArray<string>) {
      expect(["undefined", "threw"]).toContain(answer);
    }
  }),
);

it.live("keeps p0 read-only", () =>
  Effect.gen(function* () {
    const result = yield* run(`
      "use strict";
      try { p0.usage.limits = 1; } catch (error) { return p0.usage.limits !== 1; }
      return false;
    `).effect;
    expect(JSON.parse(result.json)).toBe(true);
  }),
);

it.live("reports a thrown error with its console output", () =>
  Effect.gen(function* () {
    const error = yield* failure(`console.log("before"); throw new Error("boom");`);
    expect(error).toBeInstanceOf(SandboxError);
    expect(error.reason).toBe("threw");
    expect(error.detail).toBe("boom");
    expect(error.logs).toEqual(["before"]);
  }),
);

it.live("reports a syntax error", () =>
  Effect.gen(function* () {
    const error = yield* failure("return (;");
    expect(error.reason).toBe("threw");
  }),
);

it.live("stops a busy loop", () =>
  Effect.gen(function* () {
    const error = yield* failure("while (true) {}", { timeoutMs: 200 });
    expect(error.reason).toBe("timeout");
  }),
);

it.live("stops a busy loop that starts after an await", () =>
  Effect.gen(function* () {
    const error = yield* failure(`await p0.usage.limits(); while (true) {}`, { timeoutMs: 300 });
    expect(error.reason).toBe("timeout");
  }),
);

it.live("stops a snippet that waits on a call forever", () =>
  Effect.gen(function* () {
    const error = yield* runSandbox({
      code: "await p0.usage.limits();",
      paths: PATHS,
      call: () => Effect.never,
      limits: { timeoutMs: 200 },
    }).pipe(Effect.flip);
    expect(error.reason).toBe("timeout");
  }),
);

it.live("refuses a result over the size cap", () =>
  Effect.gen(function* () {
    const error = yield* failure(`return "x".repeat(500)`, { maxResultBytes: 100 });
    expect(error.reason).toBe("tooLarge");
    expect(error.detail).toContain("cap is 100");
  }),
);

it.live("caps the number of p0 calls", () =>
  Effect.gen(function* () {
    const error = yield* failure(
      `for (let i = 0; i < 10; i++) await p0.usage.limits(); return "done";`,
      { maxCalls: 3 },
    );
    expect(error.reason).toBe("tooManyCalls");
  }),
);

it.live("caps console output", () =>
  Effect.gen(function* () {
    const result = yield* run(`for (let i = 0; i < 100; i++) console.log("line " + i);`, {
      maxLogLines: 5,
    }).effect;
    expect(result.logs).toHaveLength(5);
    expect(result.logsDropped).toBe(95);
  }),
);

it.live("fails a snippet that runs out of memory without taking the host down", () =>
  Effect.gen(function* () {
    const error = yield* failure(
      `const keep = []; while (true) keep.push(new Array(1e6).fill(1));`,
      { maxHeapMb: 16, timeoutMs: 4_000 },
    );
    expect(["crashed", "timeout"]).toContain(error.reason);
  }),
);
