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
  },
});
const statePath = NodePath.resolve(
  values.state ?? process.env.RELAY_STATE ?? "./relay-data/state.sqlite",
);
const state = new RelayState(statePath);
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
  const relay = new RelayServer({
    relayHost,
    state,
    publicHosts,
    ...(publicDomain ? { publicDomain } : {}),
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
  throw new Error("Usage: hhh-relay serve|enroll|ls|revoke|block|unblock|blocked [options]");
}
