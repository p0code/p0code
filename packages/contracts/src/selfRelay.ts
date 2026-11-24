import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { PortSchema } from "./baseSchemas.ts";

export const RelayPortAccess = Schema.Literals(["private", "link"]);
export type RelayPortAccess = typeof RelayPortAccess.Type;
export const RelayPort = Schema.Struct({
  port: PortSchema,
  access: RelayPortAccess,
  origin: Schema.String,
  expiresAt: Schema.Number,
});
export type RelayPort = typeof RelayPort.Type;
export const SelfRelayStatus = Schema.Struct({
  linked: Schema.Boolean,
  connected: Schema.Boolean,
  relayUrl: Schema.NullOr(Schema.String),
  publicOrigin: Schema.NullOr(Schema.String),
  certificate: Schema.Literals(["unlinked", "pending", "ready", "error"]),
  acmeAccountUri: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  caaRecords: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  ports: Schema.Array(RelayPort),
});
export type SelfRelayStatus = typeof SelfRelayStatus.Type;
export const SelfRelayLink = Schema.Struct({ relayUrl: Schema.String, token: Schema.String });
export type SelfRelayLink = typeof SelfRelayLink.Type;
export const RelayExposePort = Schema.Struct({
  port: PortSchema,
  access: RelayPortAccess,
  expiresInSeconds: Schema.Int.check(Schema.isBetween({ minimum: 60, maximum: 2592000 })),
});
export type RelayExposePort = typeof RelayExposePort.Type;
export const RelayPortLink = Schema.Struct({ url: Schema.String });

export class SelfRelayOperationError extends Schema.TaggedError<SelfRelayOperationError>()(
  "SelfRelayOperationError",
  { message: Schema.String },
) {}
