// Agents publishing tunnels through `p0_code`: approval per mode, refusals, own-thread scoping.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import type * as NodeTls from "node:tls";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  CommandId,
  EnvironmentId,
  EventId,
  IsoDateTime,
  type ManagedPolicyDocument,
  ProjectId,
  type PublicTunnel,
  type PublicTunnelAgentPublishingMode,
  type PublicTunnelId,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { memoryKeychainStore } from "@t3tools/shared/credentialKeychain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectStoreV2 from "../../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ManagedPolicy from "../../../policy/ManagedPolicy.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as SelfRelay from "../../../selfRelay/SelfRelay.ts";
import * as ServerSettingsService from "../../../serverSettings.ts";
import * as AgentTunnelDecisions from "../../../tunnels/AgentTunnelDecisions.ts";
import * as PublicTunnels from "../../../tunnels/PublicTunnels.ts";
import * as ProjectCostService from "../../../usage/ProjectCostService.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { findMethod } from "./api.ts";
import * as P0Handlers from "./handlers.ts";
import { P0_NAMESPACES } from "./namespaces.ts";
import { P0CodeToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:p0-tunnels");
const threadId = ThreadId.make("thread:p0-tunnels");
const otherThreadId = ThreadId.make("thread:p0-tunnels-other");
const projectId = ProjectId.make("project:p0-tunnels");
const approver = AuthSessionId.make("session:approver");
const OWN_PORT = 49_998;

interface Options {
  readonly runtimeMode?: RuntimeMode;
  readonly agentPublishing?: PublicTunnelAgentPublishingMode;
  readonly enabled?: boolean;
  readonly policy?: ManagedPolicyDocument;
  readonly scope?: Partial<McpInvocationContext.McpInvocationScope>;
}

interface Relay {
  hooks: SelfRelay.SelfRelayPublicTunnelsHooks | undefined;
}

const relayState: SelfRelay.SelfRelayPublicState = {
  linked: true,
  connected: true,
  slug: "envslug1",
  relayUrl: "https://relay.example.com",
  publicHosts: true,
  publicDomain: null,
};

const fakeRelay = (relay: Relay) =>
  Layer.mock(SelfRelay.SelfRelay)({
    attachPublicTunnels: (hooks) =>
      Effect.sync(() => {
        relay.hooks = hooks;
        hooks.onStateChange?.(relayState);
      }),
  });

/** The real PublicTunnels service, its project store, and the p0_code tool for one thread. */
const harness = (workspaceRoot: string, options: Options = {}) => {
  const relay: Relay = { hooks: undefined };
  const infra = Layer.mergeAll(
    SqlitePersistence.layerMemory,
    ManagedPolicy.layerTest(options.policy),
    ServerConfig.layerTest(process.cwd(), { prefix: "p0-agent-tunnels-test-" }),
  ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)));
  const base = Layer.mergeAll(
    infra,
    ServerSecretStore.layerWithKeychain(memoryKeychainStore()).pipe(Layer.provideMerge(infra)),
  );
  const settings = ServerSettingsService.ServerSettingsService.layerTest({
    publicTunnels: {
      enabled: options.enabled ?? true,
      agentPublishing: options.agentPublishing ?? "allow-full-access",
    },
  });
  const tunnels = PublicTunnels.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        base,
        settings,
        ProjectStoreV2.layer.pipe(Layer.provideMerge(base)),
        fakeRelay(relay),
      ),
    ),
  );
  const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: (id) =>
      Effect.succeed({
        ...liveThreadShell(id, { runtimeMode: options.runtimeMode ?? "full-access" }),
        projectId,
      }),
  });
  const layer = McpToolAccess.HandlersLayer.layer(P0Handlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        tunnels,
        threads,
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId,
          requestNamespace: "provider:p0-tunnels",
          thread: {
            threadId,
            providerSessionId: "provider:p0-tunnels",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
          ...options.scope,
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(UsageLimitSources.UsageLimitSources)({}),
        Layer.mock(ProjectCostService.ProjectCostService)({}),
      ),
    ),
  );
  const setup = Effect.gen(function* () {
    const store = yield* ProjectStoreV2.ProjectStoreV2;
    const at = IsoDateTime.make("2026-11-27T00:00:00.000Z");
    yield* store.apply({
      sequence: 0,
      eventId: EventId.make("evt-p0-tunnels"),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: at,
      commandId: CommandId.make("cmd-p0-tunnels"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: "Demo",
        workspaceRoot,
        defaultModelSelection: null,
        scripts: [],
        createdAt: at,
        updatedAt: at,
      },
    });
    (yield* PublicTunnels.PublicTunnels).registerServerPort(OWN_PORT);
  });
  return { relay, layer, setup };
};

/** Runs a `p0_code` snippet the way an agent does, through the sandbox and its checks. */
const p0 = (code: string) =>
  Effect.gen(function* () {
    const toolkit = yield* P0CodeToolkit;
    const results = yield* toolkit
      .handle("p0_code", { code })
      .pipe(Stream.unwrap, Stream.runCollect);
    return results.at(-1)?.result as
      | { readonly result: unknown }
      | { readonly code: string; readonly message: string };
  });

const resultOf = (output: unknown) => {
  if (typeof output === "object" && output !== null && "result" in output) {
    return output.result as never;
  }
  throw new Error(`p0_code failed: ${JSON.stringify(output)}`);
};

const withWorkspace = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(process.cwd(), ".test-p0-tunnels-"));
      await NodeFSP.writeFile(NodePath.join(root, "report.txt"), "the report", "utf8");
      await NodeFSP.mkdir(NodePath.join(root, "dist"));
      await NodeFSP.writeFile(NodePath.join(root, "dist", "index.html"), "<p>site</p>", "utf8");
      return root;
    }),
    use,
    (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
  );

const startUpstream = () =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const server = NodeHttp.createServer((_req, res) => res.end("from the dev server"));
      server.listen(0, "127.0.0.1");
      await NodeEvents.EventEmitter.once(server, "listening");
      return server;
    }),
    (server) =>
      Effect.sync(() => {
        server.close();
        server.closeAllConnections();
      }),
  ).pipe(Effect.map((server) => (server.address() as NodeNet.AddressInfo).port));

/** A visitor's GET as the relay delivers it: a socket handed to the tunnel for `name`. */
const visit = (relay: Relay, name: string, url: string) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const listener = NodeNet.createServer((socket) =>
        relay.hooks?.accept(socket as NodeTls.TLSSocket, {
          label: `${name}-envslug1.relay.example.com`,
          name,
          remoteAddr: "198.51.100.7",
          kind: "tls",
        }),
      );
      listener.listen(0, "127.0.0.1");
      await NodeEvents.EventEmitter.once(listener, "listening");
      return listener;
    }),
    (listener) =>
      Effect.promise(
        () =>
          new Promise<string>((resolve, reject) => {
            const target = new URL(url);
            const request = NodeHttp.request(
              {
                host: "127.0.0.1",
                port: (listener.address() as NodeNet.AddressInfo).port,
                path: target.pathname,
                headers: { host: target.host },
                agent: false,
              },
              (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
              },
            );
            request.on("error", reject);
            request.end();
          }),
      ),
    (listener) => Effect.sync(() => listener.close()),
  );

it.live("a Full access thread publishes a port, a file and a folder without asking", () =>
  withWorkspace((root) => {
    const { relay, layer, setup } = harness(root);
    return Effect.gen(function* () {
      yield* setup;
      const port = yield* startUpstream();
      const output = yield* p0(`
        const status = await p0.tunnels.status();
        const app = await p0.tunnels.publish({ port: ${port}, slug: "demo-app", reason: "show the dev server" });
        const file = await p0.tunnels.publish({ path: "report.txt", slug: "report", reason: "share the report" });
        const site = await p0.tunnels.publish({ path: "dist", slug: "site", reason: "share the build" });
        return { status, app, file, site, list: await p0.tunnels.list() };
      `);
      const result = resultOf(output) as {
        status: unknown;
        app: { status: string; url: string };
        file: { status: string; url: string };
        site: { status: string; url: string };
        list: ReadonlyArray<{ target: unknown; status: string }>;
      };
      expect(result.status).toEqual({ available: true, approval: "allow", maxExpiryMinutes: 1440 });
      expect(result.app).toMatchObject({
        status: "live",
        url: "https://demo-app-envslug1.relay.example.com/",
      });
      expect(result.file.status).toBe("live");
      expect(result.site.status).toBe("live");
      expect(result.list.map((tunnel) => tunnel.target)).toEqual(
        expect.arrayContaining([
          { port },
          { kind: "file", path: NodePath.join(root, "report.txt") },
          { kind: "folder", path: NodePath.join(root, "dist") },
        ]),
      );

      expect(yield* visit(relay, "demo-app", result.app.url)).toBe("from the dev server");
      expect(yield* visit(relay, "pub", result.file.url)).toBe("the report");
      expect(yield* visit(relay, "pub", result.site.url)).toBe("<p>site</p>");
    }).pipe(Effect.scoped, Effect.provide(layer));
  }),
);

it.live("a thread below Full access asks; the request is shown and approved by a person", () =>
  withWorkspace((root) => {
    const { layer, setup } = harness(root, { runtimeMode: "auto-accept-edits" });
    return Effect.gen(function* () {
      yield* setup;
      const output = yield* p0(`
        const status = await p0.tunnels.status();
        const asked = await p0.tunnels.publish({ port: 4321, slug: "ask-me", expiresInMinutes: 60, reason: "demo" });
        return { status, asked, list: await p0.tunnels.list() };
      `);
      const result = resultOf(output) as {
        status: { approval: string };
        asked: { id: string; status: string; url?: string };
        list: ReadonlyArray<{ id: string; status: string; url?: string }>;
      };
      expect(result.status.approval).toBe("ask");
      expect(result.asked).toEqual({ id: result.asked.id, status: "pending_approval" });
      expect(result.list).toMatchObject([{ id: result.asked.id, status: "pending_approval" }]);
      expect(result.list[0]?.url).toBeUndefined();

      // What the approval card reads: target, expiry, hostname and which thread asked.
      const tunnels = yield* PublicTunnels.PublicTunnels;
      const pending = yield* tunnels.get(result.asked.id as PublicTunnelId);
      expect(pending).toMatchObject({
        status: "pending_approval",
        target: { kind: "port", port: 4321 },
        routing: "subdomain",
        url: "https://ask-me-envslug1.relay.example.com/",
        createdBy: { kind: "agent", threadId, projectId },
        projectId,
      });
      expect(pending.expiresAt! - pending.createdAt).toBe(60 * 60 * 1000);

      const approved = yield* tunnels.decideRequest({ id: pending.id, approve: true }, approver);
      expect(approved).toMatchObject({
        status: "live",
        createdBy: { kind: "agent", threadId, approvedBySessionId: approver },
      });
      const after = resultOf(yield* p0(`return await p0.tunnels.get({ id: "${pending.id}" });`));
      expect(after).toMatchObject({
        status: "live",
        url: "https://ask-me-envslug1.relay.example.com/",
      });
    }).pipe(Effect.provide(layer));
  }),
);

it.live('"ask" makes even a Full access thread wait for approval', () =>
  withWorkspace((root) => {
    const { layer, setup } = harness(root, { agentPublishing: "ask" });
    return Effect.gen(function* () {
      yield* setup;
      const result = resultOf(
        yield* p0(`return await p0.tunnels.publish({ port: 4322, reason: "demo" });`),
      );
      expect(result).toMatchObject({ status: "pending_approval" });
    }).pipe(Effect.provide(layer));
  }),
);

const refusal = (options: Options, code: string, expected: string) =>
  withWorkspace((root) => {
    const { layer, setup } = harness(root, options);
    return Effect.gen(function* () {
      yield* setup;
      const output = yield* p0(code);
      expect(output).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining(expected),
      });
    }).pipe(Effect.provide(layer));
  });

const publishPort = (port: number, extra = "") =>
  `return await p0.tunnels.publish({ port: ${port}, reason: "demo"${extra} });`;

it.live("refuses when agent publishing is off in Settings", () =>
  refusal({ agentPublishing: "off" }, publishPort(4400), "agent_publishing_off"),
);

it.live("refuses when public tunnels are disabled in Settings", () =>
  refusal({ enabled: false }, publishPort(4401), "Public tunnels are disabled in server settings"),
);

it.live("refuses when the managed policy forbids public tunnels", () =>
  refusal(
    { policy: { schemaVersion: 1, organization: "Acme", limits: { publicTunnels: false } } },
    publishPort(4402),
    "policy:",
  ),
);

it.live("refuses a reserved name", () =>
  refusal({}, publishPort(4403, `, slug: "admin"`), "reserved_name"),
);

it.live("refuses p0code's own port", () => refusal({}, publishPort(OWN_PORT), "port_refused"));

it.live("refuses a path outside the project", () =>
  refusal(
    {},
    `return await p0.tunnels.publish({ path: "..", reason: "demo" });`,
    "must stay within the project workspace",
  ),
);

it.live("refuses publishing from a read-only MCP client, but still lets it read", () =>
  withWorkspace((root) => {
    const { layer, setup } = harness(root, {
      scope: { client: { sessionId: "client", label: "Reader", access: "read-only" } },
    });
    return Effect.gen(function* () {
      yield* setup;
      expect(resultOf(yield* p0(`return await p0.tunnels.list();`))).toEqual([]);
      expect(yield* p0(publishPort(4404))).toMatchObject({
        message: expect.stringContaining("read-only access"),
      });
    }).pipe(Effect.provide(layer));
  }),
);

it.live("lists and stops only this thread's tunnels; a stopped one leaves the list at once", () =>
  withWorkspace((root) => {
    const { layer, setup } = harness(root);
    return Effect.gen(function* () {
      yield* setup;
      const tunnels = yield* PublicTunnels.PublicTunnels;
      const theirs = yield* tunnels.create(
        { target: { kind: "port", port: 4501 }, routing: "subdomain", slug: "theirs" },
        { kind: "agent", threadId: otherThreadId, projectId },
      );
      const users = yield* tunnels.create(
        { target: { kind: "port", port: 4502 } },
        { kind: "user", sessionId: approver },
      );
      const result = resultOf(
        yield* p0(`
          const mine = await p0.tunnels.publish({ port: 4503, slug: "mine", reason: "demo" });
          const before = (await p0.tunnels.list()).map((tunnel) => tunnel.id);
          const stopped = await p0.tunnels.stop({ id: mine.id });
          const after = await p0.tunnels.list();
          const reachOthers = [];
          for (const id of ["${theirs.tunnel.id}", "${users.tunnel.id}"]) {
            try { await p0.tunnels.stop({ id }); reachOthers.push("stopped"); }
            catch (error) { reachOthers.push(String(error.message ?? error)); }
          }
          return { mine: mine.id, before, stopped, after, reachOthers };
        `),
      ) as {
        mine: string;
        before: ReadonlyArray<string>;
        stopped: unknown;
        after: ReadonlyArray<unknown>;
        reachOthers: ReadonlyArray<string>;
      };
      expect(result.before).toEqual([result.mine]);
      expect(result.stopped).toEqual({ id: result.mine, status: "stopped" });
      expect(result.after).toEqual([]);
      expect(result.reachOthers).toEqual([
        expect.stringContaining("not_found"),
        expect.stringContaining("not_found"),
      ]);

      // Settings still sees the others, each attributed to whoever made it.
      const all = (yield* tunnels.list()).tunnels;
      expect(all.map((tunnel) => tunnel.createdBy)).toEqual(
        expect.arrayContaining([
          { kind: "agent", threadId: otherThreadId, projectId },
          { kind: "user", sessionId: approver },
        ]),
      );
      expect((yield* tunnels.list({ threadId: otherThreadId })).tunnels).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  }),
);

const runMethod = (path: string, options: unknown = {}) => {
  const found = findMethod(P0_NAMESPACES, path);
  if (found === undefined) throw new Error(`no ${path}`);
  return found.run(options);
};

it.effect("an expired tunnel leaves the agent's list, and an unanswered request is denied", () =>
  withWorkspace((root) => {
    const { layer, setup } = harness(root, { runtimeMode: "approval-required" });
    return Effect.gen(function* () {
      yield* setup;
      const tunnels = yield* PublicTunnels.PublicTunnels;
      const live = yield* tunnels.create(
        { target: { kind: "port", port: 4601 }, expiresInSeconds: 300 },
        { kind: "agent", threadId, projectId },
      );
      const asked = (yield* runMethod("tunnels.publish", { port: 4602, reason: "demo" })) as {
        id: PublicTunnelId;
      };
      expect(((yield* runMethod("tunnels.list")) as ReadonlyArray<unknown>).length).toBe(2);

      yield* TestClock.adjust("301 seconds");
      expect(yield* runMethod("tunnels.list")).toMatchObject([{ id: asked.id }]);
      expect(yield* runMethod("tunnels.get", { id: live.tunnel.id })).toMatchObject({
        status: "expired",
      });

      yield* TestClock.adjust("15 minutes");
      expect(yield* runMethod("tunnels.list")).toEqual([]);
      expect(yield* runMethod("tunnels.get", { id: asked.id })).toMatchObject({
        status: "denied",
      });
    }).pipe(Effect.provide(layer));
  }),
);

it.live("tells the thread when its request is approved or denied, once", () =>
  withWorkspace((root) => {
    const { layer, setup } = harness(root, { runtimeMode: "approval-required" });
    return Effect.gen(function* () {
      yield* setup;
      const tunnels = yield* PublicTunnels.PublicTunnels;
      const wakes: Array<{ threadId: string; text: string }> = [];
      const engine = {
        dispatch: (command: Parameters<Orchestrator.OrchestratorV2["Service"]["dispatch"]>[0]) =>
          Effect.sync(() => {
            if (command.type === "message.dispatch") {
              wakes.push({ threadId: command.threadId, text: command.text });
            }
            return { sequence: 0 };
          }),
      } as unknown as Orchestrator.OrchestratorV2["Service"];
      const decided = AgentTunnelDecisions.makeDecisionTracker();
      const feed = (tunnel: PublicTunnel) =>
        Effect.forEach(
          decided({ version: 1, type: "upserted", tunnel }),
          (ended) => AgentTunnelDecisions.tellThread(engine, ended),
          { discard: true },
        );

      decided({ version: 1, type: "snapshot", tunnels: [] });
      const yes = (yield* runMethod("tunnels.publish", {
        port: 4701,
        slug: "yes",
        reason: "a",
      })) as {
        id: PublicTunnelId;
      };
      const no = (yield* runMethod("tunnels.publish", { port: 4702, slug: "no", reason: "b" })) as {
        id: PublicTunnelId;
      };
      yield* feed(yield* tunnels.get(yes.id));
      yield* feed(yield* tunnels.get(no.id));
      expect(wakes).toEqual([]);

      const approved = yield* tunnels.decideRequest({ id: yes.id, approve: true }, approver);
      yield* feed(approved);
      yield* feed(yield* tunnels.decideRequest({ id: no.id, approve: false }, approver));
      // A later change to the approved tunnel, such as a pause, is not news to the agent.
      yield* feed(yield* tunnels.update({ id: yes.id, enabled: false }));
      yield* feed(approved);

      expect(wakes).toEqual([
        {
          threadId,
          text: expect.stringContaining("live at https://yes-envslug1.relay.example.com/"),
        },
        { threadId, text: expect.stringContaining("was denied") },
      ]);
    }).pipe(Effect.provide(layer));
  }),
);
