import type { AntigravityAuthMethod, ProviderCredentialStatus } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** How long before a lapsed access token the account is called expiring rather than valid. */
const EXPIRING_SOON_MS = 24 * 60 * 60 * 1_000;

const AccountFile = Schema.Struct({
  email: Schema.optional(Schema.String),
  accountId: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
});
const CliTokenFile = Schema.Struct({
  token: Schema.Struct({
    access_token: Schema.optional(Schema.String),
    refresh_token: Schema.optional(Schema.String),
    expiry: Schema.optional(Schema.String),
  }),
  id_token_email: Schema.optional(Schema.String),
});
const AcpTokenFile = Schema.Struct({
  refresh_token: Schema.NonEmptyString,
});

const decodeAccountFile = Schema.decodeUnknownOption(Schema.fromJsonString(AccountFile));
const decodeCliTokenFile = Schema.decodeUnknownOption(Schema.fromJsonString(CliTokenFile));
const decodeAcpTokenFile = Schema.decodeUnknownOption(Schema.fromJsonString(AcpTokenFile));
const encodeAccountFile = Schema.encodeSync(Schema.fromJsonString(AccountFile));

const ANTIGRAVITY_ACCOUNT_FILE = "t3-account.json";
const ANTIGRAVITY_ACP_TOKEN_FILE = "acp_token.json";
const ANTIGRAVITY_CLI_TOKEN_FILE = "antigravity-oauth-token";

export interface AntigravityAccountState {
  /** The Google account's address, when the agent or a previous probe recorded it. */
  readonly email: string | undefined;
  /** When the saved access token lapses; absent for a refresh-only sign-in. */
  readonly expiresAt: string | undefined;
  readonly credentialStatus: ProviderCredentialStatus;
  /** A turn can renew the saved sign-in without asking for another Google sign-in. */
  readonly canRenew: boolean;
  /** A saved token exists, even if it has lapsed. */
  readonly hasSignIn: boolean;
}

const tokenDirectory = (profileDirectory: string, path: Path.Path) =>
  path.join(profileDirectory, "antigravity-acp");

export const antigravityAccountPath = (profileDirectory: string, path: Path.Path) =>
  path.join(profileDirectory, ANTIGRAVITY_ACCOUNT_FILE);

export const antigravityTokenPaths = (profileDirectory: string, path: Path.Path) => {
  const directory = tokenDirectory(profileDirectory, path);
  return {
    acp: path.join(directory, ANTIGRAVITY_ACP_TOKEN_FILE),
    cli: path.join(directory, ANTIGRAVITY_CLI_TOKEN_FILE),
  };
};

/** Lapsed tokens are still nice to name, so their expiry only selects the status. */
export function antigravityCredentialStatus(
  expiresAt: string | undefined,
  now: number,
  hasRefreshToken = false,
): ProviderCredentialStatus {
  if (hasRefreshToken) return "valid";
  if (!expiresAt) return "unknown";
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) return "unknown";
  if (expiry <= now) return "expired";
  return expiry - now <= EXPIRING_SOON_MS ? "expiring" : "valid";
}

export const rememberAntigravityAccountEmail = Effect.fn("rememberAntigravityAccountEmail")(
  function* (profileDirectory: string, email: string | undefined) {
    const trimmed = email?.trim();
    if (!trimmed) return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const accountPath = antigravityAccountPath(profileDirectory, path);
    const existing = yield* fs
      .readFileString(accountPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    const previous = existing ? decodeAccountFile(existing) : Option.none();
    if (Option.isSome(previous) && previous.value.email?.trim() === trimmed) return;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* fs.writeFileString(accountPath, `${encodeAccountFile({ email: trimmed, updatedAt })}\n`);
  },
);

export const forgetAntigravityAccount = Effect.fn("forgetAntigravityAccount")(function* (
  profileDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs
    .remove(antigravityAccountPath(profileDirectory, path), { force: true })
    .pipe(Effect.ignore);
});

const readDecoded = Effect.fn("AntigravityAccount.readDecoded")(function* <A>(
  filePath: string,
  decode: (text: string) => Option.Option<A>,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false)))) {
    return Option.none<A>();
  }
  const contents = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
  return contents ? decode(contents) : Option.none<A>();
});

/**
 * Reads what the environment already knows about the saved Google account: a stored email, the
 * CLI's expiry, and whether a turn can renew it. Never starts a process or calls Google.
 */
export const readAntigravityAccountState: (
  profileDirectory: string,
  authMethod: AntigravityAuthMethod,
) => Effect.Effect<AntigravityAccountState, never, FileSystem.FileSystem | Path.Path> = Effect.fn(
  "readAntigravityAccountState",
)(function* (profileDirectory: string, authMethod: AntigravityAuthMethod) {
  const path = yield* Path.Path;
  const now = yield* Clock.currentTimeMillis;
  const tokens = antigravityTokenPaths(profileDirectory, path);
  const stored = yield* readDecoded(
    antigravityAccountPath(profileDirectory, path),
    decodeAccountFile,
  );

  let email = Option.isSome(stored) ? stored.value.email?.trim() : undefined;
  let expiresAt: string | undefined;
  let hasSignIn = false;
  let hasRefreshToken = false;

  const acpToken = yield* readDecoded(tokens.acp, decodeAcpTokenFile);
  if (Option.isSome(acpToken)) {
    hasSignIn = true;
    hasRefreshToken = true;
  } else if (authMethod === "oauth-personal" || authMethod === "oauth-business") {
    const cliToken = yield* readDecoded(tokens.cli, decodeCliTokenFile);
    if (Option.isSome(cliToken)) {
      const value = cliToken.value;
      hasSignIn = Boolean(value.token.access_token?.trim() || value.token.refresh_token?.trim());
      hasRefreshToken = Boolean(value.token.refresh_token?.trim());
      expiresAt = value.token.expiry;
      email = email ?? value.id_token_email?.trim();
    }
  }

  const credentialStatus = hasSignIn
    ? antigravityCredentialStatus(expiresAt, now, hasRefreshToken)
    : "unknown";

  return {
    email,
    expiresAt,
    credentialStatus,
    canRenew: hasSignIn,
    hasSignIn,
  } satisfies AntigravityAccountState;
});
