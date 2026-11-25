import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { AppHomeConfig, appHomeFromEnv } from "./appHome.ts";

const readConfig = (env: Record<string, string>) =>
  AppHomeConfig.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));

describe("app home environment", () => {
  it("prefers HHHCODE_HOME, then an explicitly set T3CODE_HOME", () => {
    assert.equal(appHomeFromEnv({ HHHCODE_HOME: "/a", T3CODE_HOME: "/b" }), "/a");
    assert.equal(appHomeFromEnv({ HHHCODE_HOME: "  ", T3CODE_HOME: " /b " }), "/b");
    assert.isUndefined(appHomeFromEnv({}));
  });

  it.effect("reads the same precedence through Config", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* readConfig({ HHHCODE_HOME: "/a", T3CODE_HOME: "/b" }),
        Option.some("/a"),
      );
      assert.deepEqual(
        yield* readConfig({ HHHCODE_HOME: "", T3CODE_HOME: "/b" }),
        Option.some("/b"),
      );
      assert.deepEqual(yield* readConfig({}), Option.none());
    }),
  );
});
