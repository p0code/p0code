#!/usr/bin/env node
import * as NodeUtil from "node:util";
import * as NodePath from "node:path";
import { RelayState } from "./state.ts";
import { RelayServer } from "./server.ts";
import { AcmeCertificateManager, HttpChallengeStore } from "@t3tools/relay-tunnel/certificates";

const { values, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    host: { type: "string" },
    "tls-port": { type: "string" },
    "http-port": { type: "string" },
    state: { type: "string" },
    "cert-dir": { type: "string" },
    cert: { type: "string" },
    key: { type: "string" },
    email: { type: "string" },
    "directory-url": { type: "string" },
    "bind-host": { type: "string" },
    "max-streams": { type: "string" },
    "idle-timeout-ms": { type: "string" },
    "public-hosts": { type: "boolean" },
    "public-domain": { type: "string" },
    "allow-signup": { type: "boolean" },
  },
});
const statePath = NodePath.resolve(
  values.state ?? process.env.RELAY_STATE ?? "./relay-data/state.sqlite",
);
const state = new RelayState(statePath);

/** Hidden TTY password entry, with backspace and Ctrl-C; automation uses P0_RELAY_USER_PASSWORD. */
function readPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode)
    throw new Error("Password prompts need a TTY; set P0_RELAY_USER_PASSWORD for automation");
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    process.stdin.setEncoding("utf8");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let value = "";
    const finish = (error?: Error): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\u0003" || character === "\u0004") {
          finish(new Error("Cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}
async function passwordFor(username: string): Promise<string> {
  const fromEnv = process.env.P0_RELAY_USER_PASSWORD;
  if (fromEnv !== undefined) return fromEnv;
  const first = await readPassword(`Password for ${username}: `);
  const second = await readPassword("Confirm password: ");
  if (first !== second) throw new Error("Passwords do not match");
  return first;
}
const command = positionals[0];
if (command === "enroll") {
  console.log(state.issueToken());
  state.close();
} else if (command === "ls") {
  console.log(JSON.stringify(state.list(), null, 2));
  state.close();
} else if (command === "revoke") {
  const slug = positionals[1];
  if (!slug) throw new Error("Usage: hhh-relay revoke <slug>");
  console.log(state.revoke(slug) ? `Revoked ${slug}` : `Unknown environment: ${slug}`);
  state.close();
} else if (command === "block" || command === "unblock") {
  const label = positionals[1];
  if (!label) throw new Error(`Usage: hhh-relay ${command} <name-label>`);
  try {
    if (command === "block")
      console.log(state.block(label) ? `Blocked ${label}` : `Already blocked: ${label}`);
    else console.log(state.unblock(label) ? `Unblocked ${label}` : `Not blocked: ${label}`);
  } finally {
    state.close();
  }
} else if (command === "blocked") {
  console.log(JSON.stringify(state.blockedLabels(), null, 2));
  state.close();
} else if (command === "user") {
  const action = positionals[1];
  const username = positionals[2];
  try {
    if (action === "list") {
      console.log(JSON.stringify(state.listUsers(), null, 2));
    } else if (action === "add") {
      if (!username) throw new Error("Usage: hhh-relay user add <username>");
      const user = state.addUser(username, await passwordFor(username));
      console.log(`Added ${user.username}`);
    } else if (action === "passwd") {
      if (!username) throw new Error("Usage: hhh-relay user passwd <username>");
      console.log(
        state.setPassword(username, await passwordFor(username))
          ? `Password updated for ${username.toLowerCase()}`
          : `Unknown user: ${username}`,
      );
    } else if (action === "rm") {
      if (!username) throw new Error("Usage: hhh-relay user rm <username>");
      const result = state.removeUser(username);
      if (!result.removed) console.log(`Unknown user: ${username}`);
      else if (result.revoked.length)
        console.log(`Removed ${username} and revoked ${result.revoked.join(", ")}`);
      else console.log(`Removed ${username}`);
    } else {
      throw new Error("Usage: hhh-relay user add|passwd|list|rm [username]");
    }
  } finally {
    state.close();
  }
} else if (command === "serve") {
  const relayHost = values.host ?? process.env.RELAY_HOST;
  if (!relayHost) throw new Error("RELAY_HOST or --host is required");
  const cert = values.cert ?? process.env.RELAY_CERT;
  const key = values.key ?? process.env.RELAY_KEY;
  if (Boolean(cert) !== Boolean(key)) throw new Error("Both cert and key are required");
  const email = values.email ?? process.env.RELAY_ACME_EMAIL;
  const directoryUrl = values["directory-url"] ?? process.env.RELAY_ACME_DIRECTORY_URL;
  const challenges = new HttpChallengeStore();
  const certificates = new AcmeCertificateManager({
    challenges,
    directory: NodePath.resolve(
      values["cert-dir"] ?? process.env.RELAY_CERT_DIR ?? "./relay-data/certs",
    ),
    ...(cert && key ? { byo: { cert, key } } : {}),
    ...(email ? { email } : {}),
    ...(directoryUrl ? { directoryUrl } : {}),
    onError: (error) => console.error("Certificate renewal failed:", error.message),
  });
  const number = (value: string | undefined, fallback: number, max: number): number => {
    const result = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(result) || result < 1 || result > max)
      throw new Error("Invalid numeric option");
    return result;
  };
  const publicHosts =
    values["public-hosts"] ??
    /^(1|true|yes|on)$/i.test((process.env.RELAY_PUBLIC_HOSTS ?? "").trim());
  const publicDomain = values["public-domain"] || process.env.RELAY_PUBLIC_DOMAIN || undefined;
  const allowSignup =
    values["allow-signup"] ??
    /^(1|true|yes|on)$/i.test((process.env.RELAY_ALLOW_SIGNUP ?? "").trim());
  const relay = new RelayServer({
    relayHost,
    state,
    publicHosts,
    ...(publicDomain ? { publicDomain } : {}),
    allowSignup,
    challenges,
    getSecureContext: (hostname) => certificates.getSecureContext(hostname),
    bindHost: values["bind-host"] ?? process.env.RELAY_BIND_HOST ?? "0.0.0.0",
    tlsPort: number(values["tls-port"] ?? process.env.RELAY_TLS_PORT, 443, 65535),
    httpPort: number(values["http-port"] ?? process.env.RELAY_HTTP_PORT, 80, 65535),
    maxStreams: number(values["max-streams"] ?? process.env.RELAY_MAX_STREAMS, 128, 65535),
    idleTimeoutMs: number(
      values["idle-timeout-ms"] ?? process.env.RELAY_IDLE_TIMEOUT_MS,
      120_000,
      2_147_483_647,
    ),
  });
  await relay.start();
  const shutdown = async (): Promise<void> => {
    certificates.close();
    await relay.close();
    state.close();
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
  await certificates.getSecureContext(relayHost).catch(async (error: unknown) => {
    await shutdown();
    throw error;
  });
  console.log(
    `hhh-relay serving ${relayHost}` +
      (publicHosts ? `, public hosts under ${publicDomain ?? relayHost}` : ""),
  );
} else {
  state.close();
  throw new Error("Usage: hhh-relay serve|enroll|ls|revoke|block|unblock|blocked|user [options]");
}
