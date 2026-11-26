import {
  type PublicTunnel,
  PUBLIC_TUNNEL_AGENT_DEFAULT_EXPIRY_SECONDS,
  PUBLIC_TUNNEL_AGENT_MAX_EXPIRY_SECONDS,
  type PublicTunnelId,
  type PublicTunnelOperationError,
  type PublicTunnelSlug,
  RESERVED_PUBLIC_TUNNEL_SLUGS,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettingsService from "../../../serverSettings.ts";
import * as PublicTunnels from "../../../tunnels/PublicTunnels.ts";
import { callerLinkOrigin } from "../../linkOrigin.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { type Caller, loadCaller } from "../../threadAccess.ts";
import { type P0Namespace, P0ApiError, method } from "./api.ts";

export type TunnelsServices =
  | McpInvocationContext.McpInvocationContext
  | ThreadManagementService.ThreadManagementService
  | ServerSettingsService.ServerSettingsService
  | PublicTunnels.PublicTunnels;

const NAMESPACE = "tunnels";
const MAX_EXPIRY_MINUTES = PUBLIC_TUNNEL_AGENT_MAX_EXPIRY_SECONDS / 60;
const DEFAULT_EXPIRY_MINUTES = PUBLIC_TUNNEL_AGENT_DEFAULT_EXPIRY_SECONDS / 60;
/** What an agent's list shows; stopped tunnels are deleted, so they leave it at once too. */
const ACTIVE_STATUSES: ReadonlySet<PublicTunnel["status"]> = new Set([
  "pending_approval",
  "live",
  "paused",
]);

const Tunnel = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  target: Schema.Union([
    Schema.Struct({ port: Schema.Int }),
    Schema.Struct({ path: Schema.String, kind: Schema.Literals(["file", "folder"]) }),
  ]),
  routing: Schema.Literals(["path", "subdomain"]),
  url: Schema.optionalKey(Schema.String.annotate({ description: "Only once live." })),
  status: Schema.Literals(["pending_approval", "live", "paused", "expired", "denied"]),
  expiresAt: Schema.optionalKey(Schema.String.annotate({ description: "ISO time." })),
  visits: Schema.Int,
});

const IdInput = Schema.Struct({ id: Schema.String });

const toAgentTunnel = (tunnel: PublicTunnel): typeof Tunnel.Type => ({
  id: tunnel.id,
  title: tunnel.title,
  target:
    tunnel.target.kind === "port"
      ? { port: tunnel.target.port }
      : { path: tunnel.target.path, kind: tunnel.target.kind },
  routing: tunnel.routing,
  ...(tunnel.status === "live" && tunnel.url !== null ? { url: tunnel.url } : {}),
  status: tunnel.status,
  ...(tunnel.expiresAt === null
    ? {}
    : { expiresAt: DateTime.formatIso(DateTime.makeUnsafe(tunnel.expiresAt)) }),
  visits: tunnel.visits.count,
});

const tunnelFailure = (error: PublicTunnelOperationError) =>
  new P0ApiError({ detail: `${error.reason}: ${error.message}` });

const callerFailure = (error: { readonly message: string }) =>
  new P0ApiError({ detail: error.message });

const threadCaller = loadCaller().pipe(
  Effect.mapError(callerFailure),
  Effect.flatMap((caller) =>
    caller.caller === undefined
      ? Effect.fail(new P0ApiError({ detail: "p0.tunnels needs a calling thread." }))
      : Effect.succeed({ ...caller, caller: caller.caller }),
  ),
);

type Approval = "ask" | "allow";

/**
 * The user's rule: a Full access thread, not started over a link, publishes directly; every
 * other thread asks. The service still holds both to the project and to 24 hours.
 */
const approvalFor = Effect.fn("p0.tunnels.approvalFor")(function* (caller: Caller) {
  const settings = yield* (yield* ServerSettingsService.ServerSettingsService).getSettings.pipe(
    Effect.mapError(() => new P0ApiError({ detail: "Could not read server settings." })),
  );
  const mode = settings.publicTunnels.agentPublishing;
  if (mode === "off") return { approval: "ask" as Approval, off: true };
  const fullAccess =
    caller.limits.runtimeMode === "full-access" &&
    caller.limits.interactionMode === "default" &&
    callerLinkOrigin(caller) === undefined;
  return {
    approval: (mode === "allow-full-access" && fullAccess ? "allow" : "ask") as Approval,
    off: false,
  };
});

const ownTunnel = Effect.fn("p0.tunnels.ownTunnel")(function* (id: string) {
  const { caller } = yield* threadCaller;
  const tunnels = yield* PublicTunnels.PublicTunnels;
  const tunnel = yield* tunnels.get(id as PublicTunnelId).pipe(Effect.mapError(tunnelFailure));
  // Another thread's or the user's tunnel reads as missing, so its link never leaks.
  if (tunnel.createdBy.kind !== "agent" || tunnel.createdBy.threadId !== caller.id) {
    return yield* new P0ApiError({ detail: `not_found: Tunnel ${id} not found.` });
  }
  return tunnel;
});

const status = method(NAMESPACE, {
  name: "status",
  doc: "Whether this thread can publish here, and why not. Call first.",
  input: Schema.Struct({}),
  output: Schema.Struct({
    available: Schema.Boolean,
    reason: Schema.optionalKey(
      Schema.String.annotate({
        description:
          'Set when unavailable: "setting_off" | "relay_unlinked" | "relay_no_public_hosts" | "policy" | "agent_publishing_off".',
      }),
    ),
    approval: Schema.Literals(["ask", "allow"]).annotate({
      description:
        '"ask": every publish waits for the user. "allow": this thread publishes directly.',
    }),
    maxExpiryMinutes: Schema.Int,
  }),
  run: Effect.fn("p0.tunnels.status")(function* () {
    const caller = yield* threadCaller;
    const { approval, off } = yield* approvalFor(caller);
    const linkState = yield* (yield* PublicTunnels.PublicTunnels).linkState;
    const reason =
      linkState.availability !== "ready"
        ? linkState.availability
        : off
          ? "agent_publishing_off"
          : undefined;
    return {
      available: reason === undefined,
      ...(reason === undefined ? {} : { reason }),
      approval,
      maxExpiryMinutes: MAX_EXPIRY_MINUTES,
    };
  }),
});

const list = method(NAMESPACE, {
  name: "list",
  doc: "Tunnels this thread created and has not stopped (not the user's or other threads'). Expired and denied ones drop out.",
  input: Schema.Struct({}),
  output: Schema.Array(Tunnel),
  run: Effect.fn("p0.tunnels.list")(function* () {
    const { caller } = yield* threadCaller;
    const result = yield* (yield* PublicTunnels.PublicTunnels)
      .list({ threadId: caller.id })
      .pipe(Effect.mapError(tunnelFailure));
    return result.tunnels.filter((tunnel) => ACTIVE_STATUSES.has(tunnel.status)).map(toAgentTunnel);
  }),
});

const get = method(NAMESPACE, {
  name: "get",
  doc: "One tunnel this thread created, in any status.",
  input: IdInput,
  output: Tunnel,
  run: ({ id }) => ownTunnel(id).pipe(Effect.map(toAgentTunnel)),
});

const publish = method(NAMESPACE, {
  name: "publish",
  doc: `Ask to publish. Give exactly one of port or path. Paths resolve against the thread's working directory and must stay inside the project. Returns at once; when the status is "pending_approval", tell the user it awaits their approval in p0code and carry on. You get a message when they decide, so don't poll get().`,
  access: "write",
  input: Schema.Struct({
    port: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }))),
    path: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
    slug: Schema.optionalKey(
      Schema.String.annotate({
        description: "Readable part of the URL, a-z 0-9 and hyphens. Defaults from the target.",
      }),
    ),
    routing: Schema.optionalKey(
      Schema.Literals(["path", "subdomain"]).annotate({
        description:
          '"subdomain" for dev servers (HMR, absolute asset paths), "path" for files and built folders. Defaults by target.',
      }),
    ),
    expiresInMinutes: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: MAX_EXPIRY_MINUTES })).annotate({
        description: `Defaults to ${DEFAULT_EXPIRY_MINUTES}; at most ${MAX_EXPIRY_MINUTES}.`,
      }),
    ),
    reason: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(500)).annotate({
      description: "Why, shown to the user with the request.",
    }),
    spa: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "Folder only: serve index.html for unknown paths." }),
    ),
  }),
  output: Schema.Struct({
    id: Schema.String,
    status: Schema.Literals(["pending_approval", "live"]),
    url: Schema.optionalKey(Schema.String),
  }),
  run: Effect.fn("p0.tunnels.publish")(function* (input) {
    if ((input.port === undefined) === (input.path === undefined)) {
      return yield* new P0ApiError({ detail: "Give exactly one of port or path." });
    }
    if (input.slug !== undefined && RESERVED_PUBLIC_TUNNEL_SLUGS.has(input.slug)) {
      return yield* new P0ApiError({
        detail: `reserved_name: "${input.slug}" is reserved for p0code's own hosts. Pick another slug.`,
      });
    }
    const caller = yield* threadCaller;
    const { approval, off } = yield* approvalFor(caller);
    if (off) {
      return yield* new P0ApiError({
        detail:
          "agent_publishing_off: The user turned off agent publishing in Settings. Ask them to publish it themselves.",
      });
    }
    const tunnels = yield* PublicTunnels.PublicTunnels;
    const target =
      input.port !== undefined
        ? { kind: "port" as const, port: input.port }
        : yield* tunnels
            .resolveAgentPath(input.path ?? "", {
              projectId: caller.caller.projectId,
              workingDir: caller.caller.worktreePath,
            })
            .pipe(
              Effect.mapError(tunnelFailure),
              Effect.map(({ kind, path }) =>
                kind === "file"
                  ? { kind, path }
                  : { kind, path, listing: false, spa: input.spa ?? false },
              ),
            );
    const created = yield* tunnels
      .create(
        {
          target,
          routing: input.routing ?? (target.kind === "port" ? "subdomain" : "path"),
          ...(input.slug === undefined ? {} : { slug: input.slug as PublicTunnelSlug }),
          expiresInSeconds: (input.expiresInMinutes ?? DEFAULT_EXPIRY_MINUTES) * 60,
        },
        { kind: "agent", threadId: caller.caller.id, projectId: caller.caller.projectId },
        {
          requireApproval: approval === "ask",
          scopeProjectId: caller.caller.projectId,
          workingDir: caller.caller.worktreePath,
        },
      )
      .pipe(Effect.mapError(tunnelFailure));
    const { tunnel } = created;
    yield* Effect.logInfo("public tunnel created by agent", {
      tunnelId: tunnel.id,
      threadId: caller.caller.id,
      target: tunnel.target.kind,
      status: tunnel.status,
      reason: input.reason,
    });
    return {
      id: tunnel.id,
      status: tunnel.status === "live" ? ("live" as const) : ("pending_approval" as const),
      ...(tunnel.status === "live" && created.accessUrl !== null ? { url: created.accessUrl } : {}),
    };
  }),
});

const stop = method(NAMESPACE, {
  name: "stop",
  doc: "Stop a tunnel this thread created. Always allowed, no approval.",
  access: "write",
  input: IdInput,
  output: Schema.Struct({ id: Schema.String, status: Schema.Literal("stopped") }),
  run: Effect.fn("p0.tunnels.stop")(function* ({ id }) {
    const tunnel = yield* ownTunnel(id);
    yield* (yield* PublicTunnels.PublicTunnels)
      .remove(tunnel.id)
      .pipe(Effect.mapError(tunnelFailure));
    yield* Effect.logInfo("public tunnel stopped by agent", {
      tunnelId: tunnel.id,
      threadId: tunnel.createdBy.kind === "agent" ? tunnel.createdBy.threadId : undefined,
    });
    return { id: tunnel.id, status: "stopped" as const };
  }),
});

export const tunnelsNamespace: P0Namespace<TunnelsServices> = {
  name: NAMESPACE,
  doc: `Publish a local dev server port, a file or a static folder at a public URL through this environment's relay, so anyone with the link can open it. Publishing needs the user's approval unless they allowed it; then it returns at once with status "pending_approval". Tunnels last at most ${MAX_EXPIRY_MINUTES / 60} hours.`,
  methods: [status, list, get, publish, stop],
};
