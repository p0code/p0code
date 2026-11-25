import {
  DesktopT3ImportRunInputSchema,
  DesktopT3ImportRunResultSchema,
  DesktopT3ImportStateSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopT3Import from "../../app/DesktopT3Import.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getT3ImportState = makeIpcMethod({
  channel: IpcChannels.T3_IMPORT_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopT3ImportStateSchema,
  handler: Effect.fn("desktop.ipc.t3Import.getState")(function* () {
    return yield* DesktopT3Import.getT3ImportState();
  }),
});

export const runT3Import = makeIpcMethod({
  channel: IpcChannels.T3_IMPORT_RUN_CHANNEL,
  payload: DesktopT3ImportRunInputSchema,
  result: DesktopT3ImportRunResultSchema,
  handler: Effect.fn("desktop.ipc.t3Import.run")(function* (input) {
    return yield* DesktopT3Import.runT3ImportOnTheFly(input);
  }),
});

/**
 * Restarts the app so the server applies the import staged on the welcome screen before it opens
 * its database. Does not import anything itself.
 */
export const restartT3Import = makeIpcMethod({
  channel: IpcChannels.T3_IMPORT_RESTART_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.t3Import.restart")(function* () {
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    yield* lifecycle.relaunch("t3ImportPending");
  }),
});
