import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import {
  antigravityAccountPath,
  antigravityCredentialStatus,
  antigravityTokenPaths,
  forgetAntigravityAccount,
  readAntigravityAccountState,
  rememberAntigravityAccountEmail,
} from "./AntigravityAccount.ts";

const at = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

const writeCliToken = Effect.fn("writeCliToken")(function* (
  profileDirectory: string,
  token: { expiry?: string; refreshToken?: string; email?: string },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(antigravityTokenPaths(profileDirectory, path).cli), {
    recursive: true,
  });
  yield* fs.writeFileString(
    antigravityTokenPaths(profileDirectory, path).cli,
    JSON.stringify({
      token: {
        access_token: "access-token",
        ...(token.refreshToken ? { refresh_token: token.refreshToken } : {}),
        ...(token.expiry ? { expiry: token.expiry } : {}),
      },
      ...(token.email ? { id_token_email: token.email } : {}),
    }),
  );
});

it.effect("names a Google account from the CLI's saved sign-in and stores the email", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* TestClock.setTime(at("2026-11-25T12:00:00Z"));
    const profile = yield* fs.makeTempDirectoryScoped();
    yield* writeCliToken(profile, {
      expiry: "2026-11-26T12:00:00Z",
      refreshToken: "refresh",
      email: "paid@example.com",
    });

    const state = yield* readAntigravityAccountState(profile, "oauth-personal");
    expect(state).toMatchObject({
      email: "paid@example.com",
      credentialStatus: "valid",
      canRenew: true,
      hasSignIn: true,
    });
    expect(yield* fs.exists(antigravityAccountPath(profile, path))).toBe(false);

    yield* rememberAntigravityAccountEmail(profile, "paid@example.com");
    expect(yield* fs.readFileString(antigravityAccountPath(profile, path))).toContain(
      "paid@example.com",
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer))),
);

it.effect("keeps a lapsed sign-in visible and honest about its expiry", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* TestClock.setTime(at("2026-11-25T12:00:00Z"));
    const profile = yield* fs.makeTempDirectoryScoped();
    yield* writeCliToken(profile, { expiry: "2026-11-25T11:00:00Z" });

    const expired = yield* readAntigravityAccountState(profile, "oauth-personal");
    expect(expired.credentialStatus).toBe("expired");
    expect(expired.canRenew).toBe(true);
    expect(expired.hasSignIn).toBe(true);

    yield* writeCliToken(profile, { expiry: "2026-11-26T06:00:00Z" });
    expect((yield* readAntigravityAccountState(profile, "oauth-personal")).credentialStatus).toBe(
      "expiring",
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer))),
);

it.effect("treats a refresh token as a live sign-in even after the access token lapses", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* TestClock.setTime(at("2026-11-25T12:00:00Z"));
    const profile = yield* fs.makeTempDirectoryScoped();
    yield* writeCliToken(profile, {
      expiry: "2026-11-25T11:00:00Z",
      refreshToken: "refresh",
      email: "paid@example.com",
    });
    const state = yield* readAntigravityAccountState(profile, "oauth-personal");
    expect(state.credentialStatus).toBe("valid");
    expect(state.email).toBe("paid@example.com");

    // A refresh-only ACP token has no expiry to report.
    yield* fs.makeDirectory(path.dirname(antigravityTokenPaths(profile, path).acp), {
      recursive: true,
    });
    yield* fs.writeFileString(
      antigravityTokenPaths(profile, path).acp,
      JSON.stringify({ refresh_token: "refresh" }),
    );
    expect((yield* readAntigravityAccountState(profile, "oauth-personal")).credentialStatus).toBe(
      "valid",
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer))),
);

it.effect("forgets the stored email only when the account is signed out", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const profile = yield* fs.makeTempDirectoryScoped();
    yield* rememberAntigravityAccountEmail(profile, "paid@example.com");
    expect(yield* fs.exists(antigravityAccountPath(profile, path))).toBe(true);
    yield* forgetAntigravityAccount(profile);
    expect(yield* fs.exists(antigravityAccountPath(profile, path))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer))),
);

it("maps expiry to valid, expiring and expired", () => {
  const now = at("2026-11-25T12:00:00Z");
  expect(antigravityCredentialStatus("2026-11-27T12:00:00Z", now)).toBe("valid");
  expect(antigravityCredentialStatus("2026-11-26T06:00:00Z", now)).toBe("expiring");
  expect(antigravityCredentialStatus("2026-11-25T11:00:00Z", now)).toBe("expired");
  expect(antigravityCredentialStatus("2026-11-25T11:00:00Z", now, true)).toBe("valid");
  expect(antigravityCredentialStatus(undefined, now)).toBe("unknown");
});
