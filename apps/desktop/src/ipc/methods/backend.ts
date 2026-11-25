import {
  DesktopBackendActionSchema,
  DesktopBackendConfigUpdateSchema,
  DesktopBackendStatusSchema,
  type DesktopBackendStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopBackendService from "../../backend/DesktopBackendService.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

const readCurrentBackendStatus = Effect.gen(function* () {
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const backendService = yield* DesktopBackendService.DesktopBackendService;
  const primary = yield* pool.primary;
  const snapshot = yield* primary.snapshot;
  const config = yield* primary.currentConfig;
  return yield* backendService.getStatus({
    embeddedReady: snapshot.ready,
    embeddedDesiredRunning: snapshot.desiredRunning,
    embeddedPid: Option.getOrNull(snapshot.activePid),
    embeddedUrl: Option.map(config, (entry) => entry.httpBaseUrl.href).pipe(Option.getOrNull),
  });
});

export const getBackendStatus = makeIpcMethod({
  channel: IpcChannels.BACKEND_GET_STATUS_CHANNEL,
  payload: Schema.Void,
  result: DesktopBackendStatusSchema,
  handler: Effect.fn("desktop.ipc.backend.getStatus")(function* () {
    return yield* readCurrentBackendStatus;
  }),
});

export const updateBackendConfig = makeIpcMethod({
  channel: IpcChannels.BACKEND_UPDATE_CONFIG_CHANNEL,
  payload: DesktopBackendConfigUpdateSchema,
  result: DesktopBackendStatusSchema,
  handler: Effect.fn("desktop.ipc.backend.updateConfig")(function* (input) {
    const backendService = yield* DesktopBackendService.DesktopBackendService;
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    const result = yield* backendService.updateConfig(input);
    const status = yield* readCurrentBackendStatus;
    if (result.changed) {
      yield* lifecycle.relaunch(`backendConfigUpdated:${status.mode}`);
    }
    return result.error === null
      ? status
      : ({ ...status, error: result.error } satisfies DesktopBackendStatus);
  }),
});

export const controlBackend = makeIpcMethod({
  channel: IpcChannels.BACKEND_CONTROL_CHANNEL,
  payload: DesktopBackendActionSchema,
  result: DesktopBackendStatusSchema,
  handler: Effect.fn("desktop.ipc.backend.control")(function* (action) {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const backendService = yield* DesktopBackendService.DesktopBackendService;
    const primary = yield* pool.primary;
    const mode = yield* backendService.resolveEffectiveMode;

    if (mode === "local-service") {
      const errorMessage = yield* backendService.controlService(action).pipe(
        Effect.as(null as string | null),
        Effect.catch((error) => Effect.succeed(error.message)),
      );
      if (action === "stop") {
        yield* primary.stop();
      } else {
        yield* primary.stop();
        yield* primary.start;
      }
      const status = yield* readCurrentBackendStatus;
      return errorMessage === null
        ? status
        : ({ ...status, error: errorMessage } satisfies DesktopBackendStatus);
    }

    if (action === "stop") {
      yield* primary.stop();
    } else if (action === "start") {
      yield* primary.start;
    } else {
      yield* primary.stop();
      yield* primary.start;
    }
    return yield* readCurrentBackendStatus;
  }),
});
