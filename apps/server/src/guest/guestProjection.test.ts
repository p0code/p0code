import { assert, it } from "@effect/vitest";
import { OrchestrationV2DomainEvent, OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { guestEvent, guestTurnItem } from "./guestProjection.ts";

const now = DateTime.makeUnsafe("2026-10-23T10:00:00.000Z");
const privateFields = {
  worktreePath: "/private/owner-workspace",
  branch: "private-branch",
  pullRequests: [{ number: 42, url: "https://private.example/pull/42" }],
  checkpoint: { files: ["private-file"] },
  prompt: "private-prompt",
  result: "private-result",
  stdout: "private-stdout",
  stderr: "private-stderr",
  output: "private-output",
  input: "private-input",
  cwd: "/private/cwd",
  env: { TOKEN: "private-token" },
  unknownFutureField: "private-future",
};
const payload = {
  ...privateFields,
  id: "public-id",
  threadId: "public-thread",
  runId: "public-run",
  ordinal: 1,
  userMessageId: "public-message",
  status: "completed",
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
  title: "Shared conversation",
  settledOverride: null,
  settledAt: null,
  type: "assistant_message",
  messageId: "public-message",
  text: "Public reply",
  streaming: false,
  fileName: "src/index.ts",
  attachments: [],
  createdBy: "user",
  creationSource: "web",
  inputIntent: "turn_start",
};
const forbidden =
  /worktreePath|branch|pull.?request|checkpoint|prompt|result|stdout|stderr|private-|\/private\//i;

it("rebuilds every contract event and item without private keys or values", () => {
  for (const member of OrchestrationV2DomainEvent.members) {
    const tag = member.fields.type;
    const types = "literal" in tag ? [tag.literal] : tag.literals;
    for (const type of types) {
      const event = { ...privateFields, type, payload } as unknown as OrchestrationV2DomainEvent;
      assert.notMatch(JSON.stringify(guestEvent(event)), forbidden, type);
    }
  }
  for (const member of OrchestrationV2TurnItem.members) {
    const type = member.fields.type.literal;
    const projected = guestTurnItem({ ...payload, type } as unknown as OrchestrationV2TurnItem);
    assert.notMatch(JSON.stringify(projected), forbidden, type);
    assert.equal(
      projected !== null,
      ["user_message", "assistant_message", "file_change"].includes(type),
      type,
    );
  }
  assert.isNull(
    guestEvent({ type: "future.secret-event", payload } as unknown as OrchestrationV2DomainEvent),
  );
});
