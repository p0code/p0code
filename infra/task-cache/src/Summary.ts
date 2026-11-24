import * as Schema from "effect/Schema";

const Label = Schema.String.check(Schema.isMaxLength(256));
const Count = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
export const Summary = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  recordedAt: Count,
  host: Label,
  platform: Label,
  arch: Label,
  ci: Schema.Boolean,
  runId: Label,
  tasks: Schema.Array(
    Schema.Struct({
      package: Label,
      task: Label,
      source: Schema.Literals(["local", "remote", "unspecified", "executed", "failed"]),
      savedMs: Count,
    }),
  ).check(Schema.isMaxLength(1000)),
});
