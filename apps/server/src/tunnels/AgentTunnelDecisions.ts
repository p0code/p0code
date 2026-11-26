import {
  CommandId,
  MessageId,
  type PublicTunnel,
  type PublicTunnelId,
  type PublicTunnelStreamEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as PublicTunnels from "./PublicTunnels.ts";

/**
 * When the user answers an agent's tunnel request (or it times out), tells the thread that asked,
 * so the agent never has to poll `p0.tunnels.get`.
 */
const decisionWake = (tunnel: PublicTunnel) => {
  if (tunnel.status === "live") {
    return {
      summary: `Tunnel "${tunnel.slug}" approved`,
      text: `The user approved your tunnel request ${tunnel.id}. It is live at ${tunnel.url ?? "(no URL until the relay is linked)"} until ${tunnel.expiresAt === null ? "stopped" : DateTime.formatIso(DateTime.makeUnsafe(tunnel.expiresAt))}.`,
    };
  }
  if (tunnel.status === "denied") {
    return {
      summary: `Tunnel "${tunnel.slug}" denied`,
      text: `Your tunnel request ${tunnel.id} was denied or timed out, so nothing was published. Ask the user before requesting it again.`,
    };
  }
  return null;
};

/** Pending agent requests seen so far; returns the tunnels whose request just ended. */
export const makeDecisionTracker = () => {
  const pending = new Set<PublicTunnelId>();
  const isAgentRequest = (tunnel: PublicTunnel) =>
    tunnel.createdBy.kind === "agent" && tunnel.status === "pending_approval";
  return (event: PublicTunnelStreamEvent): ReadonlyArray<PublicTunnel> => {
    if (event.type === "snapshot") {
      for (const tunnel of event.tunnels) if (isAgentRequest(tunnel)) pending.add(tunnel.id);
      return [];
    }
    if (event.type === "removed") {
      pending.delete(event.id);
      return [];
    }
    const { tunnel } = event;
    if (isAgentRequest(tunnel)) {
      pending.add(tunnel.id);
      return [];
    }
    if (!pending.delete(tunnel.id)) return [];
    return [tunnel];
  };
};

/** Wakes the thread that asked with how its request ended. */
export const tellThread = Effect.fn("AgentTunnelDecisions.tellThread")(
  function* (engine: Orchestrator.OrchestratorV2["Service"], tunnel: PublicTunnel) {
    const wake = decisionWake(tunnel);
    if (wake === null || tunnel.createdBy.kind !== "agent") return;
    const threadId = tunnel.createdBy.threadId;
    const key = `${tunnel.id}:${tunnel.status}`;
    yield* Effect.logInfo("public tunnel request decided", {
      tunnelId: tunnel.id,
      threadId,
      status: tunnel.status,
    });
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:tunnel-decision:${key}`),
      threadId,
      messageId: MessageId.make(`message:tunnel-decision:${key}`),
      text: wake.text,
      notification: { source: { kind: "system" }, outcome: "updated", summary: wake.summary },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  },
  (effect, _engine, tunnel) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("telling a thread about its tunnel request failed", {
          tunnelId: tunnel.id,
          cause,
        }),
      ),
    ),
);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tunnels = yield* PublicTunnels.PublicTunnels;
    const engine = yield* Orchestrator.OrchestratorV2;
    const decided = makeDecisionTracker();
    yield* forkParked(
      Stream.runForEach(tunnels.changes, (event) =>
        Effect.forEach(decided(event), (tunnel) => tellThread(engine, tunnel), { discard: true }),
      ),
    );
  }),
);
