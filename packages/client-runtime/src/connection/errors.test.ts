import { mapRemoteDpopEnvironmentError, isHostCredentialRefusal } from "./errors.ts";

import { EnvironmentAuthInvalidError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { NETWORK_BLOCKING_HINT } from "../errors/network.ts";
import { RemoteEnvironmentAuthFetchError, RemoteEnvironmentAuthTimeoutError } from "../rpc/http.ts";

describe("mapRemoteDpopEnvironmentError", () => {
  it.each([
    new RemoteEnvironmentAuthFetchError({
      message: "Failed to fetch remote environment endpoint.",
      cause: new TypeError("Failed to fetch"),
    }),
    new RemoteEnvironmentAuthTimeoutError({
      requestUrl: "https://environment.example.test",
      timeoutMs: 10_000,
    }),
  ])("suggests another network when the relay endpoint cannot be reached: $_tag", (error) => {
    const mapped = mapRemoteDpopEnvironmentError(error);
    expect(mapped).toMatchObject({
      _tag: "ConnectionTransientError",
      detail: `${error.message} ${NETWORK_BLOCKING_HINT}`,
    });
  });

  it("keeps a direct host's clock refusal apart from a refused pairing", () => {
    const mapped = mapRemoteDpopEnvironmentError(
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "invalid_credential",
        dpopFailureReason: "time_window",
        traceId: "trace-clock",
      }),
      "direct",
    );
    expect(mapped).toMatchObject({ via: "direct", failureCause: "clock_skew" });
    expect(isHostCredentialRefusal(mapped)).toBe(false);
  });
});
