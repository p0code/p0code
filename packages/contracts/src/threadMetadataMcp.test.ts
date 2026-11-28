import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ThreadMetadataMcpUpdateInput } from "./threadMetadataMcp.ts";

const decodeUpdate = Schema.decodeUnknownSync(ThreadMetadataMcpUpdateInput);

describe("ThreadMetadataMcpUpdateInput", () => {
  it("rejects malformed client request ids without normalizing valid keys", () => {
    const validKey = "metadata-\ud83d\ude80-1";
    assert.equal(
      decodeUpdate({ action: "regenerate_title", clientRequestId: validKey }).clientRequestId,
      validKey,
    );
    assert.throws(() =>
      decodeUpdate({ action: "regenerate_title", clientRequestId: "metadata-\ud800" }),
    );
    assert.throws(() =>
      decodeUpdate({ action: "regenerate_title", clientRequestId: "metadata-\udc00" }),
    );
  });

  it("validates action-specific fields for rename, regenerate_title, and move_project", () => {
    assert.equal(
      decodeUpdate({ action: "move_project", projectId: "project-target" }).projectId,
      "project-target",
    );
    assert.throws(() => decodeUpdate({ action: "move_project" }));
    assert.throws(() =>
      decodeUpdate({ action: "move_project", projectId: "project-target", title: "Nope" }),
    );
    assert.throws(() =>
      decodeUpdate({ action: "rename", title: "Valid", projectId: "project-target" }),
    );
    assert.throws(() => decodeUpdate({ action: "regenerate_title", projectId: "project-target" }));
  });
});
