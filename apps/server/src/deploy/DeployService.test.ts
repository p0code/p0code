import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  type PluginManifest,
  ProjectId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  defineDeployProvider,
  PluginContext,
  PluginError,
  type PluginServices,
} from "@t3tools/plugin-api";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { requiredScopesForRpcCall } from "../auth/RpcAuthorization.ts";
import {
  BundledPlugins,
  layer as pluginHostLayer,
  PluginHost,
  PluginHostBindings,
} from "../plugins/PluginHost.ts";
import * as ServerSettings from "../serverSettings.ts";
import { DeployService, DeployThreadModes, layer as deployLayer, redact } from "./DeployService.ts";
import { ownServerDeployProvider } from "./ownServer.ts";

const TOKEN = "tok-SECRET-4242";
const manifest = (id: string, capabilities: PluginManifest["capabilities"]): PluginManifest => ({
  id,
  name: `${id} plugin`,
  description: "Test deploy provider.",
  version: "1.0.0",
  unofficial: false,
  externalServices: ["api.example.test"],
  capabilities,
  httpRoutes: [],
});

const deployed: Array<unknown> = [];

/** Stands in for a Vercel-like plugin: its token lives only in its own plugin storage. */
const fakeProvider = defineDeployProvider({
  manifest: manifest("fake-deploy", ["deploy:provider", "network:outbound"]),
  provider: { id: "fake", label: "Fake Cloud", icon: "cloud" },
  start: Effect.gen(function* () {
    const { storage } = yield* PluginContext;
    return {
      deploy: {
        link: ({ token }) => {
          if (token === undefined) {
            return Effect.succeed({
              _tag: "pending" as const,
              authorizeUrl: "https://example.test/oauth",
            });
          }
          if (!token.startsWith("tok-")) {
            return Effect.fail(new PluginError({ message: `Token ${token} was rejected.` }));
          }
          return storage
            .set("token", token)
            .pipe(Effect.as({ _tag: "linked" as const, accountLabel: "acme-team" }));
        },
        unlink: storage.remove("token"),
        status: storage
          .get("token")
          .pipe(
            Effect.map((token) =>
              Option.isSome(token)
                ? { state: "linked" as const, accountLabel: "acme-team", message: null }
                : { state: "unlinked" as const, accountLabel: null, message: null },
            ),
          ),
        listProjects: Effect.succeed([{ id: "prj_1", name: "acme-web", url: "https://acme.app" }]),
        deploy: (input) =>
          Effect.sync(() => {
            deployed.push(input);
            return { deploymentId: `dpl_${deployed.length}`, url: "https://preview.acme.app" };
          }),
        deploymentStatus: (deploymentId) =>
          Effect.succeed({ deploymentId, state: "ready" as const, url: "https://acme.app" }),
        logs: (deploymentId) => Stream.fromIterable([`building ${deploymentId}`, "done"]),
        rollback: ({ deploymentId }) =>
          Effect.succeed({ deploymentId: deploymentId ?? "dpl_previous" }),
        listDomains: () => Effect.succeed([{ name: "acme.app", verified: true }]),
        setEnv: () => Effect.void,
      },
    };
  }),
});

/** Declares the capability but never got turned on: listed, not runnable. */
const offProvider = defineDeployProvider({
  manifest: manifest("off-deploy", ["deploy:provider"]),
  provider: { id: "off", label: "Off Cloud" },
  start: Effect.fail(new PluginError({ message: "unused" })),
});

/** Returns data outside the contract; the boundary check must catch it. */
const liarProvider = defineDeployProvider({
  manifest: manifest("liar-deploy", ["deploy:provider"]),
  provider: { id: "liar", label: "Liar Cloud" },
  start: Effect.succeed({
    deploy: {
      ...offStub(),
      listProjects: Effect.succeed([{ id: "", name: "x" }] as never),
    },
  }),
});

/** A deploy provider whose manifest forgot the capability never starts. */
const undeclaredProvider = defineDeployProvider({
  manifest: manifest("undeclared-deploy", []),
  provider: { id: "undeclared", label: "Undeclared" },
  start: Effect.succeed({ deploy: offStub() }),
});

function offStub() {
  const no = Effect.fail(new PluginError({ message: "no" }));
  return {
    link: () => no,
    unlink: no,
    status: Effect.succeed({ state: "unlinked" as const, accountLabel: null, message: null }),
    listProjects: Effect.succeed([]),
    deploy: () => no,
    deploymentStatus: () => no,
    logs: () => Stream.fail(new PluginError({ message: "no" })),
    rollback: () => no,
    listDomains: () => Effect.succeed([]),
    setEnv: () => no,
  };
}

const unusedContext = Effect.fail(new PluginError({ message: "unused" }));
const storageByPlugin = new Map<string, Map<string, string>>();

const layerBindings = Layer.effect(
  PluginHostBindings,
  Effect.gen(function* () {
    const platform = yield* Effect.context<Exclude<PluginServices, PluginContext>>();
    return PluginHostBindings.of({
      platform,
      revokeIssued: () => Effect.void,
      migrateLegacyData: () => Effect.void,
      contextFor: (pluginManifest, reportStatus) => {
        const store = storageByPlugin.get(pluginManifest.id) ?? new Map<string, string>();
        storageByPlugin.set(pluginManifest.id, store);
        return Effect.succeed(
          PluginContext.of({
            pluginId: pluginManifest.id,
            dataDir: "/nonexistent",
            storage: {
              get: (key) => Effect.sync(() => Option.fromNullishOr(store.get(key))),
              set: (key, value) => Effect.sync(() => void store.set(key, value)),
              remove: (key) => Effect.sync(() => void store.delete(key)),
            },
            reportStatus,
            environment: {
              environmentId: Effect.die("unused"),
              descriptor: Effect.die("unused"),
              localOrigin: unusedContext,
            },
            deviceAccess: { issueCredential: () => unusedContext, revokeAll: Effect.void },
            agentActivity: {
              changes: Stream.empty,
              read: () => Effect.succeed(null),
              activeThreadIds: Effect.succeed([]),
            },
            dataBackup: {
              snapshot: unusedContext,
              stageRestore: () => unusedContext,
              pendingRestore: unusedContext,
              cancelRestore: unusedContext,
            },
            usage: { dailyTotals: () => unusedContext },
          }),
        );
      },
    });
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      NodeCrypto.layer,
      FetchHttpClient.layer,
      Layer.succeed(
        PtyAdapter.PtyAdapter,
        PtyAdapter.PtyAdapter.of({ spawn: () => Effect.die("") }),
      ),
    ),
  ),
);

const FULL = ThreadId.make("thread-full");
const ASKING = ThreadId.make("thread-ask");
const PROJECT = ProjectId.make("project-1");

const layerFor = (plugins: ReadonlyArray<typeof fakeProvider>) =>
  deployLayer.pipe(
    Layer.provideMerge(
      pluginHostLayer.pipe(
        Layer.provide(Layer.succeed(BundledPlugins, BundledPlugins.of({ plugins, failures: [] }))),
        Layer.provide(layerBindings),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        DeployThreadModes,
        DeployThreadModes.of({
          runtimeMode: (threadId) =>
            Effect.succeed(
              threadId === FULL ? "full-access" : threadId === ASKING ? "auto-accept-edits" : null,
            ),
        }),
      ),
    ),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
  );

const failureOf = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => "succeeded" }));

const link = Effect.gen(function* () {
  const host = yield* PluginHost;
  yield* host.setEnabled({ pluginId: "fake-deploy", enabled: true });
  const deploy = yield* DeployService;
  return { deploy, linked: yield* deploy.link({ pluginId: "fake-deploy", token: TOKEN }) };
});

describe("DeployService", () => {
  it.layer(layerFor([]))((it) => {
    it.effect("lists no providers when no plugin declares deploy:provider", () =>
      Effect.gen(function* () {
        const overview = yield* (yield* DeployService).overview;
        assert.deepStrictEqual(overview.providers, []);
        assert.deepStrictEqual(overview.deployments, []);
      }),
    );
  });

  it.layer(layerFor([fakeProvider, offProvider]))((it) => {
    it.effect("links, maps, deploys, reads logs and status, rolls back", () =>
      Effect.gen(function* () {
        const { deploy, linked } = yield* link;
        assert.deepStrictEqual(linked, { _tag: "linked", accountLabel: "acme-team" });

        const overview = yield* deploy.overview;
        const fake = overview.providers.find((provider) => provider.pluginId === "fake-deploy");
        assert.strictEqual(fake?.label, "Fake Cloud");
        assert.strictEqual(fake?.status.state, "linked");
        assert.strictEqual(fake?.status.accountLabel, "acme-team");
        const off = overview.providers.find((provider) => provider.pluginId === "off-deploy");
        assert.strictEqual(off?.running, false);

        const projects = yield* deploy.listProjects("fake-deploy");
        assert.deepStrictEqual(
          projects.map((project) => project.id),
          ["prj_1"],
        );

        assert.include(
          yield* failureOf(
            deploy.start({ projectId: PROJECT, environment: "preview", sourceKind: "git" }),
          ),
          "Choose a deploy target",
        );
        yield* deploy.mapProject({
          projectId: PROJECT,
          mapping: {
            pluginId: "fake-deploy",
            providerProjectId: "prj_1",
            providerProjectName: "acme-web",
          },
        });
        const started = yield* deploy.start({
          projectId: PROJECT,
          environment: "production",
          sourceKind: "git",
          branch: "main",
        });
        assert.strictEqual(started._tag, "started");
        if (started._tag !== "started") return;
        assert.strictEqual(started.deployment.deploymentId, "dpl_1");
        assert.deepStrictEqual(deployed.at(-1), {
          projectId: "prj_1",
          environment: "production",
          source: { kind: "git", branch: "main" },
        });

        const status = yield* deploy.status({ pluginId: "fake-deploy", deploymentId: "dpl_1" });
        assert.strictEqual(status.state, "ready");
        assert.strictEqual((yield* deploy.overview).deployments[0]?.state, "ready");

        const lines = yield* Stream.runCollect(
          deploy.logs({ pluginId: "fake-deploy", deploymentId: "dpl_1" }),
        );
        assert.deepStrictEqual(lines, ["building dpl_1", "done"]);

        assert.deepStrictEqual(yield* deploy.rollback({ projectId: PROJECT }), {
          deploymentId: "dpl_previous",
        });
        assert.deepStrictEqual(yield* deploy.domains(PROJECT), [
          { name: "acme.app", verified: true },
        ]);

        yield* deploy.unlink("fake-deploy");
        const after = yield* deploy.overview;
        assert.strictEqual(
          after.providers.find((provider) => provider.pluginId === "fake-deploy")?.status.state,
          "unlinked",
        );
      }),
    );

    it.effect("keeps the project mapping in server settings, and clears it with null", () =>
      Effect.gen(function* () {
        const { deploy } = yield* link;
        const settings = yield* ServerSettings.ServerSettingsService;
        const mapping = {
          pluginId: "fake-deploy",
          providerProjectId: "prj_1",
          providerProjectName: "acme-web",
        };
        yield* deploy.mapProject({ projectId: PROJECT, mapping });
        assert.deepStrictEqual((yield* settings.getSettings).deployProjects[PROJECT], mapping);
        assert.deepStrictEqual((yield* deploy.overview).mappings[PROJECT], mapping);
        yield* deploy.mapProject({ projectId: PROJECT, mapping: null });
        assert.isUndefined((yield* settings.getSettings).deployProjects[PROJECT]);
      }),
    );

    it.effect("holds a deploy from a thread below Full access until someone approves it", () =>
      Effect.gen(function* () {
        const { deploy } = yield* link;
        yield* deploy.mapProject({
          projectId: PROJECT,
          mapping: {
            pluginId: "fake-deploy",
            providerProjectId: "prj_1",
            providerProjectName: "acme-web",
          },
        });
        const before = deployed.length;

        const full = yield* deploy.start({
          projectId: PROJECT,
          environment: "preview",
          sourceKind: "git",
          threadId: FULL,
        });
        assert.strictEqual(full._tag, "started");
        assert.strictEqual(deployed.length, before + 1);

        for (const threadId of [ASKING, ThreadId.make("thread-unknown")]) {
          const held = yield* deploy.start({
            projectId: PROJECT,
            environment: "production",
            sourceKind: "git",
            branch: "feature",
            threadId,
          });
          assert.strictEqual(held._tag, "approval-required");
          if (held._tag !== "approval-required") return;
          assert.strictEqual(deployed.length, before + 1);
          assert.strictEqual(held.approval.threadId, threadId);
          assert.isTrue((yield* deploy.overview).approvals.some((a) => a.id === held.approval.id));
        }

        const [declined, approved] = (yield* deploy.overview).approvals;
        assert.isNull(yield* deploy.decideApproval({ approvalId: declined!.id, approve: false }));
        assert.strictEqual(deployed.length, before + 1);
        const record = yield* deploy.decideApproval({ approvalId: approved!.id, approve: true });
        assert.strictEqual(record?.branch, "feature");
        assert.strictEqual(deployed.length, before + 2);
        assert.deepStrictEqual((yield* deploy.overview).approvals, []);
        assert.include(
          yield* failureOf(deploy.decideApproval({ approvalId: approved!.id, approve: true })),
          "already answered",
        );
      }),
    );

    it.effect("never lets a provider token reach a result, an error, or a log line", () =>
      Effect.gen(function* () {
        const entries: Array<Logger.Options<unknown>> = [];
        const capture = Logger.layer([Logger.make((entry) => entries.push(entry))], {
          mergeWithExisting: false,
        });
        const run = Effect.gen(function* () {
          const { deploy, linked } = yield* link;
          const rejected = yield* failureOf(
            deploy.link({ pluginId: "fake-deploy", token: `bad-${TOKEN}` }),
          );
          yield* deploy.mapProject({
            projectId: PROJECT,
            mapping: {
              pluginId: "fake-deploy",
              providerProjectId: "prj_1",
              providerProjectName: "acme-web",
            },
          });
          yield* deploy.start({ projectId: PROJECT, environment: "preview", sourceKind: "git" });
          return { linked, rejected, overview: yield* deploy.overview };
        }).pipe(Effect.provide(capture));
        const { linked, rejected, overview } = yield* run;

        assert.strictEqual(rejected, "Token [redacted] was rejected.");
        assert.notInclude(JSON.stringify({ linked, overview }), TOKEN);
        const settings = yield* ServerSettings.ServerSettingsService;
        assert.notInclude(JSON.stringify(yield* settings.getSettings), TOKEN);
        assert.isAbove(entries.length, 0);
        for (const entry of entries) {
          assert.notInclude(Logger.formatLogFmt.log(entry), TOKEN);
        }
        // The plugin's own storage is the one place it lives.
        assert.strictEqual(storageByPlugin.get("fake-deploy")?.get("token"), TOKEN);
      }),
    );

    it.effect("refuses a provider that is not turned on", () =>
      Effect.gen(function* () {
        const deploy = yield* DeployService;
        assert.include(yield* failureOf(deploy.listProjects("off-deploy")), "Turn on");
        assert.include(yield* failureOf(deploy.listProjects("nope")), "No installed plugin");
      }),
    );
  });

  it.layer(layerFor([liarProvider, undeclaredProvider]))((it) => {
    it.effect("checks provider output against the contract and the manifest's capability", () =>
      Effect.gen(function* () {
        const host = yield* PluginHost;
        const deploy = yield* DeployService;
        yield* host.setEnabled({ pluginId: "liar-deploy", enabled: true });
        assert.include(
          yield* failureOf(deploy.listProjects("liar-deploy")),
          "invalid project list",
        );
        yield* host.setEnabled({ pluginId: "undeclared-deploy", enabled: true });
        const snapshot = yield* host.snapshot;
        const undeclared = snapshot.plugins.find((p) => p.manifest.id === "undeclared-deploy");
        assert.strictEqual(undeclared?.state, "failed");
        assert.strictEqual(undeclared?.message, "Capability deploy:provider is not declared.");
        // Not declaring the capability also keeps it out of the deploy list.
        const listed = (yield* deploy.overview).providers.map((provider) => provider.pluginId);
        assert.deepStrictEqual(listed, ["liar-deploy"]);
      }),
    );
  });

  it.effect("keeps the own-server stub unwired: it refuses to deploy", () =>
    Effect.gen(function* () {
      assert.strictEqual(ownServerDeployProvider.descriptor.id, "p0deploy");
      assert.include(
        yield* failureOf(
          ownServerDeployProvider.deploy({
            projectId: "p",
            source: { kind: "git" },
            environment: "preview",
          }),
        ),
        "not available yet",
      );
    }),
  );

  it("redacts only a secret long enough to mean something", () => {
    assert.strictEqual(redact("a abcd b", "abcd"), "a [redacted] b");
    assert.strictEqual(redact("a ab b", "ab"), "a ab b");
    assert.strictEqual(redact("plain", undefined), "plain");
  });

  it("needs read for reads, providers:manage to link, settings:write to map, operate to deploy", () => {
    const scopes = (method: string, payload: unknown = {}) =>
      requiredScopesForRpcCall(method, payload);
    for (const method of [
      WS_METHODS.deployOverview,
      WS_METHODS.deployListProjects,
      WS_METHODS.deployStatus,
      WS_METHODS.deployLogs,
      WS_METHODS.deployDomains,
    ]) {
      assert.deepStrictEqual(scopes(method), [AuthOrchestrationReadScope]);
    }
    assert.deepStrictEqual(scopes(WS_METHODS.deployLink), [AuthProvidersManageScope]);
    assert.deepStrictEqual(scopes(WS_METHODS.deployUnlink), [AuthProvidersManageScope]);
    assert.deepStrictEqual(scopes(WS_METHODS.deployMapProject), [AuthSettingsWriteScope]);
    for (const method of [
      WS_METHODS.deployStart,
      WS_METHODS.deployDecideApproval,
      WS_METHODS.deployRollback,
      WS_METHODS.deploySetEnv,
    ]) {
      assert.deepStrictEqual(scopes(method), [AuthOrchestrationOperateScope]);
    }
  });
});
