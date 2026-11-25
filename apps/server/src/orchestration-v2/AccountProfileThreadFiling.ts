import { isListedThreadLineage, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import { newThreadAccountProfilePatch } from "@t3tools/shared/accountProfiles";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";

/**
 * Files each new listed thread under the active account profile, so "No project" threads separate
 * like projects do, and forgets deleted threads. Threads under a filed project need no entry.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const settings = yield* ServerSettings.ServerSettingsService;
    const file = Effect.fn("AccountProfileThreadFiling.file")(function* (
      event: OrchestrationV2DomainEvent,
    ) {
      if (event.type === "thread.created") {
        if (!isListedThreadLineage(event.payload.lineage)) return;
        const patch = newThreadAccountProfilePatch(yield* settings.getSettings, event.payload);
        if (patch !== undefined) yield* settings.updateSettings(patch);
      } else if (event.type === "thread.deleted") {
        const current = yield* settings.getSettings;
        if (Object.hasOwn(current.threadAccountProfileIds, event.threadId)) {
          yield* settings.updateSettings({ threadAccountProfileIds: { [event.threadId]: null } });
        }
      }
    });
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        file(event).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to file a thread under its account profile.", cause),
          ),
        ),
      ),
    );
  }),
);
