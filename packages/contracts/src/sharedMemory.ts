import * as Schema from "effect/Schema";

export const SharedMemoryStatus = Schema.Struct({
  connected: Schema.Boolean,
  phase: Schema.Literals(["idle", "syncing", "error"]),
  folder: Schema.String,
  vault: Schema.String,
  agentId: Schema.String,
  enabled: Schema.Boolean,
  paused: Schema.Boolean,
  lastSyncedAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  snippet: Schema.String,
});
export type SharedMemoryStatus = typeof SharedMemoryStatus.Type;
export const SharedMemoryVaults = Schema.Struct({
  vaults: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, region: Schema.String }),
  ),
  shared: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, region: Schema.String }),
  ),
});
export const SharedMemoryCommand = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("login"),
    email: Schema.String,
    password: Schema.String,
    mfa: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    action: Schema.Literal("configure"),
    vault: Schema.String,
    folder: Schema.String,
    password: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    action: Schema.Literal("preferences"),
    enabled: Schema.Boolean,
    agentId: Schema.String,
  }),
  Schema.Struct({ action: Schema.Literals(["pause", "resume", "logout"]) }),
]);
export type SharedMemoryCommand = typeof SharedMemoryCommand.Type;
export class SharedMemoryError extends Schema.TaggedError<SharedMemoryError>()(
  "SharedMemoryError",
  {
    stage: Schema.String,
  },
) {
  override get message() {
    return `Shared memory ${this.stage} failed. Check Obsidian Headless (ob) is installed with Node 22+, your credentials, and vault access.`;
  }
}
