import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Why the welcome screen can or cannot offer to bring a stock T3 Code home over. */
export const T3ImportStatusReason = Schema.Literals([
  "available",
  "stock-home-missing",
  "already-imported",
  "pending",
  "home-not-fresh",
]);
export type T3ImportStatusReason = typeof T3ImportStatusReason.Type;

export const T3ImportStatus = Schema.Struct({
  available: Schema.Boolean,
  stockHome: Schema.String,
  appHome: Schema.String,
  /** This p0code home holds no user data beyond what onboarding itself created. */
  fresh: Schema.Boolean,
  reason: T3ImportStatusReason,
});
export type T3ImportStatus = typeof T3ImportStatus.Type;

/** Consent recorded now and applied before the database opens on the next start. */
export const PendingT3Import = Schema.Struct({
  requestedAt: IsoDateTime,
  source: TrimmedNonEmptyString,
  appVersion: TrimmedNonEmptyString,
});
export type PendingT3Import = typeof PendingT3Import.Type;

export const T3ImportAcceptInput = Schema.Struct({});
export type T3ImportAcceptInput = typeof T3ImportAcceptInput.Type;

export class T3ImportError extends Schema.TaggedError<T3ImportError>()("T3ImportError", {
  code: Schema.Literals(["not-available", "write-failed"]),
  reason: Schema.optionalKey(T3ImportStatusReason),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
