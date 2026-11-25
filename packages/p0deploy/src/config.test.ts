import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { parseConfig, selectTargets } from "./config.ts";

const parse = (value: unknown) => parseConfig(JSON.stringify(value), "p0deploy.json");

const minimal = { app: "web", targets: [{ name: "prod", host: "deploy@example.com" }] };

describe("parseConfig", () => {
  it.effect("fills defaults for a minimal config", () =>
    Effect.gen(function* () {
      const config = yield* parse(minimal);
      assert.deepEqual(config.build, {
        context: ".",
        dockerfile: "Dockerfile",
        args: {},
      });
      assert.strictEqual(config.engine, "docker");
      assert.strictEqual(config.keepImages, 3);
      assert.deepEqual(config.targets[0], {
        name: "prod",
        host: "deploy@example.com",
        domains: [],
        ports: [],
        forwardEnv: [],
        volumes: [],
        restart: "unless-stopped",
        transfer: "auto",
      });
    }),
  );

  it.effect("rejects configs agents commonly get wrong", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, unknown, string]> = [
        ["typo'd key", { ...minimal, keepImage: 2 }, "keepImage"],
        ["uppercase app", { ...minimal, app: "Web" }, "lowercase image name"],
        [
          "ssh option smuggled in as a host",
          { app: "web", targets: [{ name: "prod", host: "-oProxyCommand=sh" }] },
          "ssh destination",
        ],
        [
          "domains without the app port",
          { app: "web", targets: [{ name: "prod", host: "h", domains: ["web.example.com"] }] },
          'needs "port"',
        ],
        [
          "wildcard domain on a target",
          { app: "web", targets: [{ name: "prod", host: "h", port: 3000, domains: ["*.x.com"] }] },
          "hostname",
        ],
        [
          "secret value instead of a variable name",
          { app: "web", targets: [{ name: "prod", host: "h", forwardEnv: ["TOKEN=abc"] }] },
          "environment variable name",
        ],
        [
          "duplicate target",
          { app: "web", targets: [minimal.targets[0], minimal.targets[0]] },
          "defined twice",
        ],
        ["no targets", { app: "web", targets: [] }, "targets"],
      ];
      for (const [label, value, expected] of cases) {
        const error = yield* Effect.flip(parse(value));
        assert.strictEqual(error.code, "CONFIG_INVALID", label);
        assert.include(error.message, expected, label);
      }
    }),
  );

  it.effect("selects targets by name and reports unknown ones", () =>
    Effect.gen(function* () {
      const config = yield* parse({
        app: "web",
        targets: [
          { name: "prod", host: "a" },
          { name: "staging", host: "b" },
        ],
      });
      assert.deepEqual(
        (yield* selectTargets(config, ["staging"])).map((target) => target.name),
        ["staging"],
      );
      const error = yield* Effect.flip(selectTargets(config, ["qa"]));
      assert.strictEqual(error.code, "TARGET_NOT_FOUND");
    }),
  );
});
