import * as Schema from "effect/Schema";

export const DeployErrorCode = Schema.Literals([
  "CONFIG_NOT_FOUND",
  "CONFIG_INVALID",
  "CONFIG_EXISTS",
  "NO_DOCKERFILE",
  "TARGET_NOT_FOUND",
  "ENV_MISSING",
  "IMAGE_NOT_FOUND",
  "COMMAND_FAILED",
  "HEALTH_CHECK_FAILED",
  "NOTHING_TO_ROLLBACK",
  "SERVER_NOT_INITIALIZED",
]);
export type DeployErrorCode = typeof DeployErrorCode.Type;

export class DeployError extends Schema.TaggedError<DeployError>()("DeployError", {
  code: DeployErrorCode,
  message: Schema.String,
  target: Schema.optional(Schema.String),
  /** Tail of the failing command's output, or the unhealthy container's logs. */
  output: Schema.optional(Schema.String),
}) {}

/** 2 = fix the config or the invocation, 3 = the new version was rejected and the old one kept, 1 = anything else. */
export function exitCodeFor(code: DeployErrorCode): 1 | 2 | 3 {
  switch (code) {
    case "CONFIG_NOT_FOUND":
    case "CONFIG_INVALID":
    case "CONFIG_EXISTS":
    case "NO_DOCKERFILE":
    case "TARGET_NOT_FOUND":
    case "ENV_MISSING":
      return 2;
    case "HEALTH_CHECK_FAILED":
      return 3;
    default:
      return 1;
  }
}
