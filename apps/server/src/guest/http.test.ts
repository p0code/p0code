import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type OrchestrationV2DomainEvent,
  GUEST_COMMAND_OUTPUT_ROUTE,
  GUEST_MESSAGE_MAX_LENGTH,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http";

import * as Stream from "effect/Stream";
import { guestEvent } from "./guestProjection.ts";
import * as Layer from "effect/Layer";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Etag from "effect/http/Etag";
import * as HttpRouter from "effect/http/HttpRouter";
import { GuestShareService } from "./GuestShareService.ts";
import * as GuestHttp from "./http.ts";

import { readSubmission } from "./http.ts";

it.effect("keeps a JSON file a guest attaches as a file, not a form field", () =>
  Effect.gen(function* () {
    const form = new FormData();
    form.append("shareId", "share-1");
    form.append("text", "");
    form.append("file", new File(['{"a":1}'], "data.json", { type: "application/json" }));
    const request = HttpServerRequest.fromWeb(
      new Request("http://localhost/api/guest/messages?share=share-1", {
        method: "POST",
        body: form,
      }),
    );
    const submission = yield* readSubmission.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    );
    assert.deepEqual(
      submission?.uploads.map((upload) => [upload.name, upload.contentType]),
      [["data.json", "application/json"]],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps a multi-line form message within the length limit as the guest typed it", () =>
  Effect.gen(function* () {
    // At the limit with LF, over it once each line break is counted as CRLF.
    const lines = Array.from({ length: 50 }, () => "x".repeat(79));
    const text = lines.join("\n").padEnd(GUEST_MESSAGE_MAX_LENGTH, "x");
    const form = new FormData();
    form.append("shareId", "share-1");
    form.append("text", text);
    const request = HttpServerRequest.fromWeb(
      new Request("http://localhost/api/guest/messages?share=share-1", {
        method: "POST",
        body: form,
      }),
    );
    const submission = yield* readSubmission.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    );
    assert.strictEqual(submission?.fields.text, text);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses command output without ever opening the command stream", () =>
  Effect.gen(function* () {
    const routes = GuestHttp.layer.pipe(
      Layer.provideMerge(
        Layer.mock(GuestShareService)({
          commandOutput: () => Effect.die("Guest output must never be opened"),
        }),
      ),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(
      routes.pipe(
        Layer.provideMerge(HttpPlatform.layer),
        Layer.provideMerge(Etag.layerWeak),
        Layer.provideMerge(NodeServices.layer),
      ),
      { disableLogger: true },
    );
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    for (const cookie of ["", "t3_guest_share=session-token"]) {
      const response = yield* Effect.promise(() =>
        handler(
          new Request(`http://localhost${GUEST_COMMAND_OUTPUT_ROUTE}?share=share&item=command`, {
            headers: { cookie },
          }),
        ),
      );
      assert.equal(response.status, 404);
      assert.equal(yield* Effect.promise(() => response.text()), "");
    }
  }).pipe(Effect.scoped),
);

it.effect("drops unknown and private events before encoding the guest HTTP stream", () =>
  Effect.gen(function* () {
    const raw = [
      { type: "future.secret-event", payload: { stdout: "private-output" } },
      { type: "subagent.updated", payload: { prompt: "private-prompt", result: "private-result" } },
    ] as unknown as ReadonlyArray<OrchestrationV2DomainEvent>;
    const routes = GuestHttp.layer.pipe(
      Layer.provideMerge(
        Layer.mock(GuestShareService)({
          stream: () =>
            Effect.succeed(
              Stream.fromIterable(
                raw.flatMap((event) => {
                  const projected = guestEvent(event);
                  return projected === null
                    ? []
                    : [
                        {
                          type: "thread" as const,
                          item: { kind: "event" as const, sequence: 1, event: projected },
                        },
                      ];
                }),
              ),
            ),
        }),
      ),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(
      routes.pipe(
        Layer.provideMerge(HttpPlatform.layer),
        Layer.provideMerge(Etag.layerWeak),
        Layer.provideMerge(NodeServices.layer),
      ),
      { disableLogger: true },
    );
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    const response = yield* Effect.promise(() =>
      handler(new Request("http://localhost/api/guest/stream?share=share")),
    );
    assert.equal(response.status, 200);
    assert.equal(yield* Effect.promise(() => response.text()), "");
  }).pipe(Effect.scoped),
);
