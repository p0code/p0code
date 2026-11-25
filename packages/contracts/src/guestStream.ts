import * as Schema from "effect/Schema";

import { GuestShareId, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ThreadGuestMessage } from "./guestShare.ts";
import {
  OrchestrationV2AppThread,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  OrchestrationV2ProjectedTurnItem,
} from "./orchestrationV2.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

// This lives apart from guestShare.ts because orchestrationV2.ts imports that file.

/**
 * What the composer's model label shows; nothing else from the owner's provider settings. The
 * driver is null when the thread's provider is no longer configured.
 */
export const GuestThreadModel = Schema.Struct({
  driver: Schema.NullOr(ProviderDriverKind),
  name: TrimmedNonEmptyString,
  shortName: Schema.optional(TrimmedNonEmptyString),
  subProvider: Schema.optional(TrimmedNonEmptyString),
});
export type GuestThreadModel = typeof GuestThreadModel.Type;

export const GuestShareView = Schema.Struct({
  shareId: GuestShareId,
  title: Schema.String,
  guestName: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  messages: Schema.Array(ThreadGuestMessage),
  model: GuestThreadModel,
});
export type GuestShareView = typeof GuestShareView.Type;

// Guest records deliberately have no owner environment or execution metadata.
const GuestThread = Schema.Struct({
  id: OrchestrationV2AppThread.fields.id,
  title: OrchestrationV2AppThread.fields.title,
  updatedAt: OrchestrationV2AppThread.fields.updatedAt,
  settledOverride: OrchestrationV2AppThread.fields.settledOverride,
  settledAt: OrchestrationV2AppThread.fields.settledAt,
});
const GuestRun = Schema.Struct({
  id: OrchestrationV2Run.fields.id,
  threadId: OrchestrationV2Run.fields.threadId,
  ordinal: OrchestrationV2Run.fields.ordinal,
  userMessageId: OrchestrationV2Run.fields.userMessageId,
  status: OrchestrationV2Run.fields.status,
  requestedAt: OrchestrationV2Run.fields.requestedAt,
  startedAt: OrchestrationV2Run.fields.startedAt,
  completedAt: OrchestrationV2Run.fields.completedAt,
});
export const GuestThreadStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshotSequence: Schema.Number,
    projection: Schema.Struct({
      thread: GuestThread,
      runs: Schema.Array(GuestRun),
      visibleTurnItems: Schema.Array(OrchestrationV2ProjectedTurnItem),
    }),
    historyCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
    hasMoreHistory: Schema.optionalKey(Schema.Boolean),
    latestLocalTurnOrdinal: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    sequence: Schema.Number,
    event: Schema.Union([
      Schema.Struct({
        type: Schema.Literal("turn-item.updated"),
        payload: OrchestrationV2TurnItem,
      }),
      Schema.Struct({ type: Schema.Literals(["run.created", "run.updated"]), payload: GuestRun }),
      Schema.Struct({ type: Schema.Literal("thread.metadata-updated"), payload: GuestThread }),
    ]),
  }),
]);
export type GuestThreadStreamItem = typeof GuestThreadStreamItem.Type;
export const GuestStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("view"), view: GuestShareView }),
  Schema.Struct({ type: Schema.Literal("thread"), item: GuestThreadStreamItem }),
  Schema.Struct({ type: Schema.Literal("ended") }),
]);
export type GuestStreamEvent = typeof GuestStreamEvent.Type;
