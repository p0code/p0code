import * as Schema from "effect/Schema";
import {
  AuthSessionId,
  NonNegativeInt,
  PortSchema,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const PUBLIC_TUNNEL_MIN_EXPIRY_SECONDS = 300;
export const PUBLIC_TUNNEL_MAX_EXPIRY_SECONDS = 2_592_000;
export const PUBLIC_TUNNEL_DEFAULT_EXPIRY_SECONDS = 86_400;
export const PUBLIC_TUNNEL_AGENT_DEFAULT_EXPIRY_SECONDS = 7_200;
export const PUBLIC_TUNNEL_AGENT_MAX_EXPIRY_SECONDS = 86_400;
export const PUBLIC_TUNNEL_TITLE_MAX_LENGTH = 80;
export const PUBLIC_TUNNEL_SLUG_MAX_LENGTH = 30;
export const PUBLIC_TUNNEL_MAX_VISITS_LIMIT = 100;

export const RESERVED_PUBLIC_TUNNEL_SLUGS = new Set(["pub", "www", "api", "mcp", "relay", "admin"]);

const TUNNEL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidPublicTunnelSlug(slug: string): boolean {
  return (
    slug.length >= 1 &&
    slug.length <= PUBLIC_TUNNEL_SLUG_MAX_LENGTH &&
    TUNNEL_SLUG_PATTERN.test(slug) &&
    !/^[0-9]+$/.test(slug) &&
    !RESERVED_PUBLIC_TUNNEL_SLUGS.has(slug)
  );
}

export const PublicTunnelId = TrimmedNonEmptyString.pipe(Schema.brand("PublicTunnelId"));
export type PublicTunnelId = typeof PublicTunnelId.Type;

export const PublicTunnelSlug = TrimmedNonEmptyString.check(
  Schema.makeFilter((value) => isValidPublicTunnelSlug(value), {
    expected: "a valid non-reserved tunnel slug",
  }),
);
export type PublicTunnelSlug = typeof PublicTunnelSlug.Type;

export const PublicTunnelRid = Schema.String.check(Schema.isPattern(/^[0-9a-hjkmnp-tv-z]{10}$/));
export type PublicTunnelRid = typeof PublicTunnelRid.Type;

export const PublicTunnelKind = Schema.Literals(["port", "name", "file", "folder"]);
export type PublicTunnelKind = typeof PublicTunnelKind.Type;

export const PublicTunnelRouting = Schema.Literals(["path", "subdomain"]);
export type PublicTunnelRouting = typeof PublicTunnelRouting.Type;

export const PublicTunnelAccess = Schema.Literals(["public", "link"]);
export type PublicTunnelAccess = typeof PublicTunnelAccess.Type;

export const PublicTunnelStatus = Schema.Literals([
  "pending_approval",
  "live",
  "paused",
  "expired",
  "denied",
]);
export type PublicTunnelStatus = typeof PublicTunnelStatus.Type;

export const PublicTunnelHostHeader = Schema.Literals(["localhost", "public"]);
export type PublicTunnelHostHeader = typeof PublicTunnelHostHeader.Type;

export const PublicTunnelRidMode = Schema.Literals(["tunnel", "project"]);
export type PublicTunnelRidMode = typeof PublicTunnelRidMode.Type;

export const PublicTunnelTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("port"),
    port: PortSchema,
    hostHeader: Schema.optionalKey(PublicTunnelHostHeader),
  }),
  Schema.Struct({
    kind: Schema.Literal("file"),
    path: TrimmedNonEmptyString,
    runAsPage: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("folder"),
    path: TrimmedNonEmptyString,
    listing: Schema.Boolean,
    spa: Schema.Boolean,
  }),
]);
export type PublicTunnelTarget = typeof PublicTunnelTarget.Type;

export const PublicTunnelCreatedBy = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("user"),
    sessionId: AuthSessionId,
    deviceLabel: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    threadId: ThreadId,
    projectId: Schema.optionalKey(ProjectId),
    approvedBySessionId: Schema.optionalKey(AuthSessionId),
  }),
]);
export type PublicTunnelCreatedBy = typeof PublicTunnelCreatedBy.Type;

export const PublicTunnelVisitsSummary = Schema.Struct({
  count: NonNegativeInt,
  lastAt: Schema.NullOr(Schema.Number),
  bytesOut: NonNegativeInt,
});
export type PublicTunnelVisitsSummary = typeof PublicTunnelVisitsSummary.Type;

export const PublicTunnelAvailabilityReason = Schema.Literals([
  "ready",
  "setting_off",
  "relay_unlinked",
  "relay_no_public_hosts",
  "policy",
]);
export type PublicTunnelAvailabilityReason = typeof PublicTunnelAvailabilityReason.Type;

export const PublicTunnelLinkState = Schema.Struct({
  linked: Schema.Boolean,
  connected: Schema.Boolean,
  publicHosts: Schema.Boolean,
  publicDomain: Schema.NullOr(Schema.String),
  publicOrigin: Schema.NullOr(Schema.String),
  availability: PublicTunnelAvailabilityReason,
});
export type PublicTunnelLinkState = typeof PublicTunnelLinkState.Type;

export const PublicTunnel = Schema.Struct({
  id: PublicTunnelId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(PUBLIC_TUNNEL_TITLE_MAX_LENGTH)),
  target: PublicTunnelTarget,
  routing: PublicTunnelRouting,
  slug: PublicTunnelSlug,
  rid: Schema.NullOr(Schema.String),
  ridMode: Schema.optionalKey(PublicTunnelRidMode),
  access: PublicTunnelAccess,
  url: Schema.NullOr(Schema.String),
  status: PublicTunnelStatus,
  expiresAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  createdBy: PublicTunnelCreatedBy,
  projectId: Schema.NullOr(ProjectId),
  visits: PublicTunnelVisitsSummary,
});
export type PublicTunnel = typeof PublicTunnel.Type;

export const PublicTunnelVisit = Schema.Struct({
  id: Schema.Int,
  tunnelId: PublicTunnelId,
  at: Schema.Number,
  ip: Schema.String,
  method: Schema.String,
  path: Schema.String,
  status: Schema.Int,
  bytes: NonNegativeInt,
  ua: Schema.NullOr(Schema.String),
});
export type PublicTunnelVisit = typeof PublicTunnelVisit.Type;

export const PublicTunnelListInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  threadId: Schema.optionalKey(ThreadId),
});
export type PublicTunnelListInput = typeof PublicTunnelListInput.Type;

export const PublicTunnelListResult = Schema.Struct({
  tunnels: Schema.Array(PublicTunnel),
  linkState: PublicTunnelLinkState,
});
export type PublicTunnelListResult = typeof PublicTunnelListResult.Type;

export const PublicTunnelExpirySeconds = Schema.Int.check(
  Schema.isBetween({
    minimum: PUBLIC_TUNNEL_MIN_EXPIRY_SECONDS,
    maximum: PUBLIC_TUNNEL_MAX_EXPIRY_SECONDS,
  }),
);

export const PublicTunnelCreateInput = Schema.Struct({
  title: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PUBLIC_TUNNEL_TITLE_MAX_LENGTH)),
  ),
  target: PublicTunnelTarget,
  routing: Schema.optionalKey(PublicTunnelRouting),
  slug: Schema.optionalKey(PublicTunnelSlug),
  ridMode: Schema.optionalKey(PublicTunnelRidMode),
  access: Schema.optionalKey(PublicTunnelAccess),
  expiresInSeconds: Schema.optionalKey(Schema.NullOr(PublicTunnelExpirySeconds)),
  projectId: Schema.optionalKey(Schema.NullOr(ProjectId)),
});
export type PublicTunnelCreateInput = typeof PublicTunnelCreateInput.Type;

export const PublicTunnelCreateResult = Schema.Struct({
  tunnel: PublicTunnel,
  accessUrl: Schema.NullOr(Schema.String),
});
export type PublicTunnelCreateResult = typeof PublicTunnelCreateResult.Type;

export const PublicTunnelUpdateInput = Schema.Struct({
  id: PublicTunnelId,
  title: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PUBLIC_TUNNEL_TITLE_MAX_LENGTH)),
  ),
  enabled: Schema.optionalKey(Schema.Boolean),
  expiresAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  slug: Schema.optionalKey(PublicTunnelSlug),
});
export type PublicTunnelUpdateInput = typeof PublicTunnelUpdateInput.Type;

export const PublicTunnelUpdatePayload = PublicTunnelUpdateInput.mapFields(
  ({ id: _id, ...rest }) => rest,
);
export type PublicTunnelUpdatePayload = typeof PublicTunnelUpdatePayload.Type;

export const PublicTunnelIdInput = Schema.Struct({
  id: PublicTunnelId,
});
export type PublicTunnelIdInput = typeof PublicTunnelIdInput.Type;

export const PublicTunnelRotateResult = Schema.Struct({
  tunnel: PublicTunnel,
  accessUrl: Schema.NullOr(Schema.String),
});
export type PublicTunnelRotateResult = typeof PublicTunnelRotateResult.Type;

export const PublicTunnelLinkResult = Schema.Struct({
  url: Schema.String,
});
export type PublicTunnelLinkResult = typeof PublicTunnelLinkResult.Type;

export const PublicTunnelStopAllResult = Schema.Struct({
  stoppedCount: NonNegativeInt,
});
export type PublicTunnelStopAllResult = typeof PublicTunnelStopAllResult.Type;

export const PublicTunnelVisitsInput = Schema.Struct({
  id: PublicTunnelId,
  before: Schema.optionalKey(Schema.Number),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: PUBLIC_TUNNEL_MAX_VISITS_LIMIT })),
  ),
});
export type PublicTunnelVisitsInput = typeof PublicTunnelVisitsInput.Type;

export const PublicTunnelVisitsQuery = Schema.Struct({
  before: Schema.optionalKey(Schema.NumberFromString),
  limit: Schema.optionalKey(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: PUBLIC_TUNNEL_MAX_VISITS_LIMIT }),
    ),
  ),
});
export type PublicTunnelVisitsQuery = typeof PublicTunnelVisitsQuery.Type;

export const PublicTunnelVisitsResult = Schema.Struct({
  visits: Schema.Array(PublicTunnelVisit),
  nextCursor: Schema.NullOr(Schema.Int),
});
export type PublicTunnelVisitsResult = typeof PublicTunnelVisitsResult.Type;

export const PublicTunnelDecideRequestInput = Schema.Struct({
  id: PublicTunnelId,
  approve: Schema.Boolean,
  expiresAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  routing: Schema.optionalKey(PublicTunnelRouting),
  slug: Schema.optionalKey(PublicTunnelSlug),
});
export type PublicTunnelDecideRequestInput = typeof PublicTunnelDecideRequestInput.Type;

export const PublicTunnelDecideRequestPayload = PublicTunnelDecideRequestInput.mapFields(
  ({ id: _id, ...rest }) => rest,
);
export type PublicTunnelDecideRequestPayload = typeof PublicTunnelDecideRequestPayload.Type;

export const PublicTunnelStreamEvent = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("snapshot"),
    tunnels: Schema.Array(PublicTunnel),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("upserted"),
    tunnel: PublicTunnel,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("removed"),
    id: PublicTunnelId,
  }),
]);
export type PublicTunnelStreamEvent = typeof PublicTunnelStreamEvent.Type;

export const PublicTunnelErrorReason = Schema.Literals([
  "disabled",
  "policy",
  "relay_unlinked",
  "relay_unsupported",
  "invalid_input",
  "conflict",
  "not_found",
  "port_refused",
  "path_refused",
  "scope_refused",
  "internal",
]);
export type PublicTunnelErrorReason = typeof PublicTunnelErrorReason.Type;

export class PublicTunnelOperationError extends Schema.TaggedError<PublicTunnelOperationError>()(
  "PublicTunnelOperationError",
  {
    reason: PublicTunnelErrorReason,
    message: Schema.String,
  },
) {}
