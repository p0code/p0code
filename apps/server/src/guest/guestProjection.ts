import type {
  ChatAttachment,
  GuestThreadStreamItem,
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";

export const guestAttachment = (attachment: ChatAttachment): ChatAttachment => ({
  type: attachment.type,
  id: attachment.id,
  name: attachment.name,
  mimeType: attachment.mimeType,
  sizeBytes: attachment.sizeBytes,
});
export const guestThread = (thread: OrchestrationV2AppThread) => ({
  id: thread.id,
  title: thread.title,
  updatedAt: thread.updatedAt,
  settledOverride: thread.settledOverride,
  settledAt: thread.settledAt,
});
const guestRun = (run: OrchestrationV2Run) => ({
  id: run.id,
  threadId: run.threadId,
  ordinal: run.ordinal,
  userMessageId: run.userMessageId,
  status: run.status,
  requestedAt: run.requestedAt,
  startedAt: run.startedAt,
  completedAt: run.completedAt,
});

export function guestTurnItem(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem | null {
  switch (item.type) {
    case "user_message":
      return {
        type: "user_message",
        createdBy: item.createdBy,
        creationSource: item.creationSource,
        id: item.id,
        threadId: item.threadId,
        runId: item.runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: item.ordinal,
        status: item.status,
        title: null,
        startedAt: item.startedAt,
        completedAt: item.completedAt,
        updatedAt: item.updatedAt,
        messageId: item.messageId,
        inputIntent: item.inputIntent,
        text: item.text,
        context:
          item.context?.guest === undefined
            ? undefined
            : {
                version: 1,
                records: [],
                guest: {
                  guestMessageId: item.context.guest.guestMessageId,
                  name: item.context.guest.name,
                  text: item.context.guest.text,
                  shareId: item.context.guest.shareId,
                },
              },
        attachments: item.attachments.map(guestAttachment),
      };
    case "assistant_message":
      return {
        type: "assistant_message",
        id: item.id,
        threadId: item.threadId,
        runId: item.runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: item.ordinal,
        status: item.status,
        title: null,
        startedAt: item.startedAt,
        completedAt: item.completedAt,
        updatedAt: item.updatedAt,
        messageId: item.messageId,
        text: item.text,
        streaming: item.streaming,
        phase: item.phase,
      };
    case "file_change":
      return {
        type: "file_change",
        id: item.id,
        threadId: item.threadId,
        runId: item.runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: item.ordinal,
        status: item.status,
        title: null,
        startedAt: item.startedAt,
        completedAt: item.completedAt,
        updatedAt: item.updatedAt,
        fileName: item.fileName,
        additions: item.additions,
        deletions: item.deletions,
      };
    default:
      return null;
  }
}
export const guestRows = (
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): ReadonlyArray<OrchestrationV2ProjectedTurnItem> =>
  rows.flatMap((row) => {
    const item = guestTurnItem(row.item);
    return item === null
      ? []
      : [
          {
            position: row.position,
            visibility: row.visibility,
            sourceThreadId: row.sourceThreadId,
            sourceItemId: row.sourceItemId,
            item,
          },
        ];
  });
export { guestRun };
export function guestEvent(
  event: OrchestrationV2DomainEvent,
): Extract<GuestThreadStreamItem, { kind: "event" }>["event"] | null {
  switch (event.type) {
    case "turn-item.updated": {
      const payload = guestTurnItem(event.payload);
      return payload === null ? null : { type: "turn-item.updated", payload };
    }
    case "run.created":
      return { type: "run.created", payload: guestRun(event.payload) };
    case "run.updated":
      return { type: "run.updated", payload: guestRun(event.payload) };
    case "thread.settled":
    case "thread.unsettled":
    case "thread.metadata-updated":
    case "thread.guest-share-updated":
    case "thread.model-selection-updated":
    case "thread.provider-switched":
      return { type: "thread.metadata-updated", payload: guestThread(event.payload) };
    default:
      return null;
  }
}
