import * as Effect from "effect/Effect";
import { DesktopConnectionCatalogReadResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import * as DesktopConnectionCatalogStore from "../../app/DesktopConnectionCatalogStore.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getConnectionCatalog = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_CONNECTION_CATALOG_CHANNEL,
  payload: Schema.Void,
  result: DesktopConnectionCatalogReadResult,
  handler: Effect.fn("desktop.ipc.connectionCatalog.get")(function* () {
    const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
    return yield* store.read;
  }),
});

export const setConnectionCatalog = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_CONNECTION_CATALOG_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.connectionCatalog.set")(function* (catalog) {
    const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
    return yield* store.set(catalog).pipe(
      Effect.catchTags({
        DesktopConnectionCatalogEncryptionUnavailableError: () => Effect.succeed(false),
      }),
    );
  }),
});
