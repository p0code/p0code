import { atExpiry } from "./expiry.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedLimits from "../policy/managedLimits.ts";
import * as Deferred from "effect/Deferred";
// Native Ed25519/TLS adapters interoperate with Node sockets and the relay tunnel package.
// @effect-diagnostics nodeBuiltinImport:off
import * as Clock from "effect/Clock";
import * as NodeCrypto from "node:crypto";
import type * as NodeHttp from "node:http";
import type * as NodeTls from "node:tls";
import { enrollEnvironment, generateEnvironmentKeyPair } from "@t3tools/relay-tunnel/auth";
import { AcmeCertificateManager, HttpChallengeStore } from "@t3tools/relay-tunnel/certificates";
import { RelayTunnelClient } from "@t3tools/relay-tunnel/client";
import type { StreamLabel } from "@t3tools/relay-tunnel/mux";
import type { RelayExposePort, SelfRelayLink, SelfRelayStatus } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const PortRecord = Schema.Struct({
  port: Schema.Int,
  access: Schema.Literals(["private", "link"]),
  expiresAt: Schema.Number,
  id: Schema.String,
});
const LinkState = Schema.Struct({
  relayUrl: Schema.String,
  slug: Schema.String,
  privateKey: Schema.String,
  publicKey: Schema.String,
  ports: Schema.Array(PortRecord),
});
type LinkState = typeof LinkState.Type;
// link.json without its private key, which lives in the secret store (the OS keychain).
const StoredLinkState = Schema.Struct({
  ...LinkState.fields,
  privateKey: Schema.optionalKey(Schema.String),
});
const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredLinkState));
const encodeStoredState = Schema.encodeSync(Schema.fromJsonString(StoredLinkState));
const TUNNEL_KEY_SECRET = "self-relay-tunnel-key";
const certificateKeySecret = (name: string) => `self-relay-acme-${name}`;
const Claims = Schema.Struct({
  port: Schema.Int,
  id: Schema.String,
  expiresAt: Schema.Number,
  sessionId: Schema.optionalKey(Schema.String),
});
const encodeState = Schema.encodeSync(Schema.fromJsonString(Schema.NullOr(LinkState)));
const decodeClaims = Schema.decodeUnknownSync(Schema.fromJsonString(Claims));
export class SelfRelayError extends Schema.TaggedError<SelfRelayError>()("SelfRelayError", {
  operation: Schema.Literals(["load", "link", "unlink", "expose", "unexpose", "authorize"]),
  cause: Schema.Defect(),
  reason: Schema.optionalKey(
    Schema.Literals(["url", "credentials", "conflict", "network", "response"]),
  ),
}) {
  override get message() {
    switch (this.reason) {
      case "url":
        return "Enter an HTTPS relay URL (HTTP is allowed only on loopback).";
      case "credentials":
        return "Wrong username or password";
      case "conflict":
        return "The relay slug or public key is already linked to another environment.";
      case "network":
        return "Could not reach the relay. Check the URL and your network connection.";
      case "response":
        return "The relay could not enroll this environment.";
      default:
        return `Could not ${this.operation} the self-hosted relay.`;
    }
  }
}
const isSelfRelayError = Schema.is(SelfRelayError);

function normalizeRelayUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    const loopback =
      url.hostname === "localhost" ||
      url.hostname === "[::1]" ||
      /^127\.\d+\.\d+\.\d+$/u.test(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      !/^\/*$/u.test(url.pathname) ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new SelfRelayError({ operation: "link", reason: "url", cause: null });
  }
}
export interface SelfRelayPublicState {
  readonly linked: boolean;
  readonly connected: boolean;
  readonly slug: string | null;
  readonly relayUrl: string | null;
  readonly publicHosts: boolean;
  readonly publicDomain: string | null;
}

export interface SelfRelayPublicTunnelsHooks {
  readonly allowName: (name: string) => boolean;
  readonly activeNames: () => ReadonlyArray<string>;
  readonly accept: (socket: NodeTls.TLSSocket, metadata: StreamLabel) => void;
  readonly closeSockets: () => void;
  readonly onStateChange?: (state: SelfRelayPublicState) => void;
}

export class SelfRelay extends Context.Service<
  SelfRelay,
  {
    readonly status: Effect.Effect<SelfRelayStatus>;
    readonly statusFor: (relayUrl?: string) => Effect.Effect<SelfRelayStatus, SelfRelayError>;
    readonly whenReady: Effect.Effect<void>;
    readonly publicOrigin: Effect.Effect<string | null>;
    readonly link: (input: SelfRelayLink) => Effect.Effect<SelfRelayStatus, SelfRelayError>;
    readonly unlink: () => Effect.Effect<void, SelfRelayError>;
    readonly exposePort: (input: RelayExposePort) => Effect.Effect<{ url: string }, SelfRelayError>;
    readonly unexposePort: (port: number) => Effect.Effect<void, SelfRelayError>;
    readonly portLink: (
      port: number,
      sessionId: string,
    ) => Effect.Effect<{ url: string }, SelfRelayError>;
    readonly authorizePort: (
      port: number,
      token: string,
    ) => Effect.Effect<{ sessionId?: string } | null>;
    readonly attach: (
      server: NodeHttp.Server,
      forwarded: (socket: NodeTls.TLSSocket, metadata: StreamLabel) => void,
    ) => Effect.Effect<void>;
    readonly attachPublicTunnels: (hooks: SelfRelayPublicTunnelsHooks) => Effect.Effect<void>;
  }
>()("t3/selfRelay/SelfRelay") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const enrollAccount = Effect.fn("SelfRelay.enrollAccount")(
    function* (
      relayUrl: string,
      input: { username: string; password: string; desiredSlug?: string },
      publicKey: string,
    ) {
      const response = yield* HttpClient.withScope(httpClient)
        .execute(
          HttpClientRequest.post(new URL("/_hhh/auth/enroll", relayUrl).href).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              username: input.username,
              password: input.password,
              desiredSlug: input.desiredSlug,
              publicKey,
            }),
          ),
        )
        .pipe(
          Effect.mapError(
            () => new SelfRelayError({ operation: "link", reason: "network", cause: null }),
          ),
        );
      if (response.status < 200 || response.status >= 300)
        return yield* new SelfRelayError({
          operation: "link",
          reason:
            response.status === 401
              ? "credentials"
              : response.status === 409
                ? "conflict"
                : "response",
          cause: null,
        });
      const body = yield* response.json.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({ slug: Schema.String, relayHost: Schema.String }),
          ),
        ),
        Effect.mapError(
          () => new SelfRelayError({ operation: "link", reason: "response", cause: null }),
        ),
      );
      return { slug: body.slug, relayHost: body.relayHost.toLowerCase() };
    },
    Effect.scoped,
    Effect.timeout("15 seconds"),
    Effect.catchTags({
      TimeoutError: () =>
        Effect.fail(new SelfRelayError({ operation: "link", reason: "network", cause: null })),
    }),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.withTracerEnabled(false),
  );
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const certificateKeys = {
    get: (name: string) =>
      runPromise(
        secrets
          .get(certificateKeySecret(name))
          .pipe(Effect.map(Option.match({ onNone: () => undefined, onSome: Buffer.from }))),
      ),
    set: (name: string, value: Buffer) =>
      runPromise(secrets.set(certificateKeySecret(name), value)),
  };
  const policy = yield* ManagedPolicy.ManagedPolicy;
  const ready = yield* Deferred.make<void>();
  const fs = yield* FileSystem.FileSystem;
  const clock = yield* Clock.Clock;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  const directory = path.join(config.stateDir, "self-relay");
  const statePath = path.join(directory, "link.json");
  const manual = yield* Config.String("T3CODE_PUBLIC_ORIGIN").pipe(Config.option);
  const acmeDirectory = yield* Config.String("T3CODE_ACME_DIRECTORY").pipe(Config.option);
  const acmeEmail = yield* Config.String("T3CODE_ACME_EMAIL").pipe(Config.option);
  const certPath = yield* Config.String("T3CODE_RELAY_CERT").pipe(Config.option);
  const keyPath = yield* Config.String("T3CODE_RELAY_KEY").pipe(Config.option);
  const relayCaPath = yield* Config.String("T3CODE_RELAY_CA_CERT").pipe(Config.option);
  const relayCa = Option.isSome(relayCaPath)
    ? yield* fs.readFile(relayCaPath.value).pipe(Effect.orDie)
    : undefined;
  const normalizeOrigin = (value: string) => {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Expected HTTPS origin");
    return url.origin;
  };
  const manualOrigin = Option.isSome(manual)
    ? yield* Effect.try({
        try: () => normalizeOrigin(manual.value),
        catch: (cause) => new SelfRelayError({ operation: "load", cause }),
      }).pipe(Effect.orDie)
    : null;
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(Effect.orDie);
  const forwardedSockets = new Map<NodeTls.TLSSocket, number>();
  const revokeSockets = (port?: number) => {
    for (const [socket, exposedPort] of forwardedSockets)
      if (port === undefined || port === exposedPort) socket.destroy();
  };
  let state: LinkState | null = null;
  let client: RelayTunnelClient | undefined;
  let certificates: AcmeCertificateManager | undefined;
  let connected = false;
  let certificate: SelfRelayStatus["certificate"] = "unlinked";
  let target:
    | {
        server: NodeHttp.Server;
        forwarded: (socket: NodeTls.TLSSocket, metadata: StreamLabel) => void;
      }
    | undefined;
  let publicTunnels: SelfRelayPublicTunnelsHooks | undefined;
  const currentPublicState = (): SelfRelayPublicState => ({
    linked: state !== null,
    connected,
    slug: state?.slug ?? null,
    relayUrl: state?.relayUrl ?? null,
    publicHosts: client?.relayInfo?.features.includes("public-hosts") ?? false,
    publicDomain: client?.relayInfo?.publicDomain ?? null,
  });
  const notifyPublicTunnels = () => {
    publicTunnels?.onStateChange?.(currentPublicState());
  };
  const origin = () =>
    !ManagedLimits.allowsRemoteClients(policy)
      ? null
      : (manualOrigin ??
        (state && ManagedLimits.allowsConnect(policy)
          ? `https://${state.slug}.${new URL(state.relayUrl).hostname}`
          : null));
  const portOrigin = (port: number) =>
    state ? `https://${port}-${state.slug}.${new URL(state.relayUrl).hostname}` : null;
  const stop = () => {
    revokeSockets();
    publicTunnels?.closeSockets();
    client?.stop();
    certificates?.close();
    client = undefined;
    certificates = undefined;
    connected = false;
    certificate = "unlinked";
    notifyPublicTunnels();
  };
  const start = () => {
    stop();
    if (!state || !target || !ManagedLimits.allowsConnect(policy)) return;
    const current = state;
    const currentTarget = target;
    const challenges = new HttpChallengeStore();
    certificate = "pending";
    const manager = new AcmeCertificateManager({
      directory: path.join(directory, "certificates"),
      challenges,
      keys: certificateKeys,
      ...(Option.isSome(acmeDirectory) ? { directoryUrl: acmeDirectory.value } : {}),
      ...(Option.isSome(acmeEmail) ? { email: acmeEmail.value } : {}),
      ...(Option.isSome(certPath) && Option.isSome(keyPath)
        ? { byo: { cert: certPath.value, key: keyPath.value } }
        : {}),
      onError: () => {
        if (certificates === manager) certificate = "error";
      },
    });
    certificates = manager;
    const tunnel = new RelayTunnelClient({
      relayUrl: current.relayUrl,
      slug: current.slug,
      privateKey: current.privateKey,
      challenges,
      ...(relayCa ? { webSocketOptions: { ca: Buffer.from(relayCa) } } : {}),
      allowLabel: (label) =>
        "port" in label
          ? (state?.ports.some(
              (entry) =>
                entry.port === label.port && entry.expiresAt > clock.currentTimeMillisUnsafe(),
            ) ?? false)
          : (publicTunnels?.allowName(label.name) ?? false),
      getSecureContext: async (hostname) => {
        try {
          const context = await manager.getSecureContext(hostname);
          if (
            certificates === manager &&
            hostname === `${current.slug}.${new URL(current.relayUrl).hostname}`
          )
            certificate = "ready";
          return context;
        } catch (error) {
          if (certificates === manager) certificate = "error";
          throw error;
        }
      },
      onSecureConnection: (socket, metadata) => {
        if (metadata.port !== undefined) {
          const record = state?.ports.find((entry) => entry.port === metadata.port);
          if (!record || record.expiresAt <= clock.currentTimeMillisUnsafe()) {
            socket.destroy();
            return;
          }
          forwardedSockets.set(socket, metadata.port);
          const cancelExpiry = atExpiry(
            record.expiresAt,
            () => clock.currentTimeMillisUnsafe(),
            () => socket.destroy(),
          );
          socket.once("close", () => {
            cancelExpiry();
            forwardedSockets.delete(socket);
          });
          currentTarget.forwarded(socket, metadata);
        } else if (metadata.name !== undefined) {
          if (!publicTunnels?.allowName(metadata.name)) {
            socket.destroy();
            return;
          }
          publicTunnels.accept(socket, metadata);
        } else currentTarget.server.emit("connection", socket);
      },
    });
    client = tunnel;
    tunnel.on("connected", () => {
      if (client !== tunnel) return;
      connected = true;
      notifyPublicTunnels();
      void manager.getSecureContext(current.slug + "." + new URL(current.relayUrl).hostname).then(
        () => {
          if (certificates === manager) {
            certificate = "ready";
            Deferred.doneUnsafe(ready, Effect.void);
          }
        },
        () => {
          if (certificates === manager) certificate = "error";
        },
      );
    });
    tunnel.on("disconnected", () => {
      if (client === tunnel) {
        connected = false;
        notifyPublicTunnels();
      }
    });
    // Connection errors carry no credentials into logs or status read models.
    tunnel.on("connectionError", () => {});
    tunnel.start();
  };
  const writeState = (next: LinkState) => {
    const { privateKey: _privateKey, ...stored } = next;
    return writeFileStringAtomically({
      filePath: statePath,
      contents: encodeStoredState(stored),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  };
  const withPrivateKey = Effect.fn("SelfRelay.withPrivateKey")(function* (
    stored: typeof StoredLinkState.Type,
  ) {
    if (stored.privateKey !== undefined) {
      // Written by an earlier version: move the key out of link.json.
      const linked = { ...stored, privateKey: stored.privateKey };
      yield* secrets.set(TUNNEL_KEY_SECRET, new TextEncoder().encode(stored.privateKey));
      yield* writeState(linked);
      return linked;
    }
    const key = yield* secrets.get(TUNNEL_KEY_SECRET);
    if (Option.isNone(key)) {
      return yield* new SelfRelayError({
        operation: "load",
        cause: "The relay tunnel key is missing.",
      });
    }
    return { ...stored, privateKey: new TextDecoder().decode(key.value) };
  });
  const reload = Effect.fn("SelfRelay.reload")(
    function* () {
      const stored = yield* fs.readFileString(statePath).pipe(
        Effect.flatMap(decodeState),
        Effect.catchIf(
          (error) =>
            "reason" in error &&
            typeof error.reason === "object" &&
            error.reason !== null &&
            "_tag" in error.reason &&
            error.reason._tag === "NotFound",
          () => Effect.succeed(null),
        ),
      );
      const next = stored === null ? null : yield* withPrivateKey(stored);
      if (encodeState(next) === encodeState(state)) return;
      state = next;
      start();
    },
    Effect.mapError((cause) =>
      isSelfRelayError(cause) ? cause : new SelfRelayError({ operation: "load", cause }),
    ),
  );
  yield* reload();
  yield* fs.watch(directory).pipe(
    Stream.filter((event) => event.path.endsWith("link.json")),
    Stream.runForEach(() =>
      reload().pipe(
        lock.withPermits(1),
        Effect.catch((error) => Effect.logWarning(error.message)),
      ),
    ),
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() => Effect.sync(stop));
  const persist = (next: LinkState, operation: SelfRelayError["operation"]) =>
    writeState(next).pipe(
      Effect.mapError((cause) => new SelfRelayError({ operation, cause })),
      Effect.tap(() =>
        Effect.sync(() => {
          const restart = state?.slug !== next.slug || state?.relayUrl !== next.relayUrl;
          state = next;
          if (restart) start();
        }),
      ),
    );
  const publicOrigin = Effect.sync(origin);
  const status = Effect.gen(function* () {
    const stored = yield* fs
      .readFileString(path.join(directory, "certificates", "account.json"))
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ uri: Schema.String }))),
        ),
        Effect.orElseSucceed(() => null),
      );
    const accountUri = certificates?.accountUri ?? stored?.uri ?? null;
    const publicState = currentPublicState();
    const relayHost = state ? new URL(state.relayUrl).hostname : null;
    const publicHostDomain = publicState.publicDomain ?? relayHost;
    const caaHosts =
      state && accountUri && relayHost
        ? Array.from(
            new Set([
              `${state.slug}.${relayHost}`,
              ...state.ports
                .filter((port) => port.expiresAt > clock.currentTimeMillisUnsafe())
                .map((port) => `${port.port}-${state!.slug}.${relayHost}`),
              ...(publicHostDomain
                ? (publicTunnels?.activeNames() ?? []).map(
                    (name) => `${name}-${state!.slug}.${publicHostDomain}`,
                  )
                : []),
            ]),
          )
        : [];
    return {
      signupUrl: null,
      slug: state?.slug ?? null,
      linked: state !== null,
      connected,
      relayUrl: state?.relayUrl ?? null,
      publicOrigin: origin(),
      certificate,
      acmeAccountUri: accountUri,
      caaRecords:
        accountUri === null
          ? []
          : caaHosts.map(
              (host) =>
                `${host} CAA 0 issue "letsencrypt.org; accounturi=${accountUri}; validationmethods=http-01"`,
            ),
      publicHosts: publicState.publicHosts,
      publicDomain: publicState.publicDomain,
      ports:
        state?.ports
          .filter((port) => port.expiresAt > clock.currentTimeMillisUnsafe())
          .map((port) => ({
            port: port.port,
            access: port.access,
            expiresAt: port.expiresAt,
            origin: portOrigin(port.port)!,
          })) ?? [],
    } satisfies SelfRelayStatus;
  });
  const sign = (claims: typeof Claims.Type) => {
    if (!state) throw new Error("Relay is unlinked");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = NodeCrypto.createHmac(
      "sha256",
      Buffer.from(
        NodeCrypto.hkdfSync("sha256", state.privateKey, "p0code-self-relay", "port-link-v1", 32),
      ),
    )
      .update(`port:${payload}`)
      .digest("base64url");
    return `${payload}.${signature}`;
  };
  const portLink = Effect.fn("SelfRelay.portLink")(function* (port: number, sessionId: string) {
    if (!ManagedLimits.allowsPreviewTunnel(policy))
      return yield* new SelfRelayError({
        operation: "authorize",
        cause: ManagedLimits.refusePreviewTunnel(policy),
      });
    return yield* Effect.try({
      try: () => {
        const record = state?.ports.find(
          (entry) => entry.port === port && entry.expiresAt > clock.currentTimeMillisUnsafe(),
        );
        if (!record) throw new Error("Port is not exposed");
        const token = sign({ port, id: record.id, expiresAt: record.expiresAt, sessionId });
        return { url: `${portOrigin(port)}/?t=${token}` };
      },
      catch: (cause) => new SelfRelayError({ operation: "authorize", cause }),
    });
  });
  return SelfRelay.of({
    status,
    statusFor: Effect.fn("SelfRelay.statusFor")(function* (relayUrl) {
      const current = yield* status;
      if (!relayUrl || current.linked) return current;
      const url = yield* Effect.try({
        try: () => normalizeRelayUrl(relayUrl),
        catch: () => new SelfRelayError({ operation: "link", reason: "url", cause: null }),
      });
      const signup = yield* httpClient.get(new URL("/_hhh/auth/config", url).href).pipe(
        Effect.flatMap((response) =>
          response.status === 200 ? response.json : Effect.succeed(null),
        ),
        Effect.map(
          (body) =>
            typeof body === "object" && body !== null && "signup" in body && body.signup === true,
        ),
        Effect.timeout("5 seconds"),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.withTracerEnabled(false),
        Effect.orElseSucceed(() => false),
      );
      return { ...current, signupUrl: signup ? new URL("/_hhh/auth/register", url).href : null };
    }),
    publicOrigin,
    whenReady: Deferred.await(ready),
    attach: Effect.fn("SelfRelay.attach")((server, forwarded) =>
      Effect.sync(() => {
        target = { server, forwarded };
        start();
      }),
    ),
    attachPublicTunnels: Effect.fn("SelfRelay.attachPublicTunnels")((hooks) =>
      Effect.sync(() => {
        publicTunnels = hooks;
        hooks.onStateChange?.(currentPublicState());
      }),
    ),
    link: Effect.fn("SelfRelay.link")(function* (input) {
      return yield* Effect.gen(function* () {
        if (!ManagedLimits.allowsConnect(policy))
          return yield* new SelfRelayError({
            operation: "link",
            cause: ManagedLimits.refuseConnect(policy),
          });
        const relayUrl = yield* Effect.try({
          try: () => normalizeRelayUrl(input.relayUrl),
          catch: () => new SelfRelayError({ operation: "link", reason: "url", cause: null }),
        });
        const keys =
          state && !("token" in input)
            ? { privateKey: state.privateKey, publicKey: state.publicKey }
            : generateEnvironmentKeyPair();
        const enrolled =
          "token" in input
            ? yield* Effect.tryPromise({
                try: () => enrollEnvironment(relayUrl, input.token, keys.publicKey),
                catch: () =>
                  new SelfRelayError({ operation: "link", reason: "response", cause: null }),
              })
            : yield* enrollAccount(relayUrl, input, keys.publicKey);
        if (
          enrolled.relayHost !== new URL(relayUrl).hostname ||
          !/^[a-z][a-z0-9]{5,31}$/.test(enrolled.slug)
        )
          return yield* new SelfRelayError({ operation: "link", reason: "response", cause: null });
        const next = { ...keys, relayUrl, slug: enrolled.slug, ports: [] };
        yield* secrets
          .set(TUNNEL_KEY_SECRET, new TextEncoder().encode(next.privateKey))
          .pipe(Effect.mapError((cause) => new SelfRelayError({ operation: "link", cause })));
        yield* persist(next, "link");
        return yield* status;
      }).pipe(lock.withPermits(1));
    }),
    unlink: Effect.fn("SelfRelay.unlink")(
      function* () {
        yield* fs.remove(statePath, { force: true });
        state = null;
        stop();
        yield* secrets.remove(TUNNEL_KEY_SECRET);
      },
      Effect.mapError((cause) => new SelfRelayError({ operation: "unlink", cause })),
      lock.withPermits(1),
    ),
    exposePort: Effect.fn("SelfRelay.exposePort")(function* (input) {
      return yield* Effect.gen(function* () {
        if (!ManagedLimits.allowsConnect(policy))
          return yield* new SelfRelayError({
            operation: "expose",
            cause: ManagedLimits.refuseConnect(policy),
          });
        if (!ManagedLimits.allowsPreviewTunnel(policy))
          return yield* new SelfRelayError({
            operation: "expose",
            cause: ManagedLimits.refusePreviewTunnel(policy),
          });
        const address = target?.server.address();
        const ownPort = typeof address === "object" && address ? address.port : config.port;
        if (
          !state ||
          !Number.isInteger(input.port) ||
          input.port < 1 ||
          input.port > 65535 ||
          input.port === ownPort ||
          input.expiresInSeconds < 60 ||
          input.expiresInSeconds > 2592000
        )
          return yield* new SelfRelayError({
            operation: "expose",
            cause: new Error("Invalid port exposure"),
          });
        const record = {
          port: input.port,
          access: input.access,
          expiresAt: clock.currentTimeMillisUnsafe() + input.expiresInSeconds * 1000,
          id: NodeCrypto.randomUUID(),
        };
        yield* persist(
          {
            ...state,
            ports: [...state.ports.filter((entry) => entry.port !== input.port), record],
          },
          "expose",
        );
        revokeSockets(input.port);
        return {
          url: `${portOrigin(input.port)}/${input.access === "link" ? `?t=${sign(record)}` : ""}`,
        };
      }).pipe(lock.withPermits(1));
    }),
    unexposePort: Effect.fn("SelfRelay.unexposePort")(function* (port) {
      if (state)
        yield* persist(
          { ...state, ports: state.ports.filter((entry) => entry.port !== port) },
          "unexpose",
        );
      revokeSockets(port);
    }, lock.withPermits(1)),
    portLink,
    authorizePort: Effect.fn("SelfRelay.authorizePort")(function* (port, token) {
      return yield* Effect.try({
        try: () => {
          if (!state) return null;
          const [payload, signature, extra] = token.split(".");
          if (!payload || !signature || extra) return null;
          const expected = NodeCrypto.createHmac(
            "sha256",
            Buffer.from(
              NodeCrypto.hkdfSync(
                "sha256",
                state.privateKey,
                "p0code-self-relay",
                "port-link-v1",
                32,
              ),
            ),
          )
            .update(`port:${payload}`)
            .digest();
          const actual = Buffer.from(signature, "base64url");
          if (actual.length !== expected.length || !NodeCrypto.timingSafeEqual(actual, expected))
            return null;
          const claims = decodeClaims(Buffer.from(payload, "base64url").toString());
          const record = state.ports.find(
            (entry) =>
              entry.port === port &&
              entry.id === claims.id &&
              entry.expiresAt > clock.currentTimeMillisUnsafe(),
          );
          if (
            !record ||
            claims.port !== port ||
            claims.expiresAt > record.expiresAt ||
            claims.expiresAt <= clock.currentTimeMillisUnsafe() ||
            (record.access === "private" && !claims.sessionId)
          )
            return null;
          return claims.sessionId ? { sessionId: claims.sessionId } : {};
        },
        catch: (cause) => new SelfRelayError({ operation: "authorize", cause }),
      }).pipe(Effect.orElseSucceed(() => null));
    }),
  });
});
export const layer = Layer.effect(SelfRelay, make).pipe(Layer.provide(FetchHttpClient.layer));
