import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopShutdown from "../../app/DesktopShutdown.ts";
import * as DesktopState from "../../app/DesktopState.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import { restartT3Import } from "./t3Import.ts";

// relaunch declares the services it needs even when the test replaces it, so provide them all.
const layerUnusedLifecycleRuntime = Layer.mergeAll(
  DesktopShutdown.layer,
  DesktopState.layer,
  Layer.succeed(
    DesktopEnvironment.DesktopEnvironment,
    DesktopEnvironment.DesktopEnvironment.of(
      {} as DesktopEnvironment.DesktopEnvironment["Service"],
    ),
  ),
  Layer.mock(DesktopWindow.DesktopWindow, {}),
  Layer.mock(ElectronApp.ElectronApp, {}),
  Layer.mock(ElectronTheme.ElectronTheme, {}),
);

describe("T3 import IPC", () => {
  it.effect("relaunches the app so the staged import runs before the next start", () => {
    const reasons: Array<string> = [];
    const layer = Layer.mergeAll(
      Layer.succeed(
        DesktopLifecycle.DesktopLifecycle,
        DesktopLifecycle.DesktopLifecycle.of({
          relaunch: (reason) =>
            Effect.sync(() => {
              reasons.push(reason);
            }),
          register: Effect.void,
        }),
      ),
      layerUnusedLifecycleRuntime,
    );
    return Effect.gen(function* () {
      yield* restartT3Import.handler(undefined);
      assert.deepEqual(reasons, ["t3ImportPending"]);
    }).pipe(Effect.provide(layer));
  });
});
