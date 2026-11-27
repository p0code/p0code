import {
  AccountProfileId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  type DeployAccountRef,
  type DeployMappingTarget,
  type PluginManifest,
  ProjectId,
  type RuntimeMode,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  checkDeployProvider,
  defineDeployProvider,
  PluginContext,
  PluginError,
  type PluginServices,
} from "@t3tools/plugin-api";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { requiredScopesForRpcCall } from "../auth/RpcAuthorization.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  BundledPlugins,
  layer as pluginHostLayer,
  PluginHost,
  PluginHostBindings,
} from "../plugins/PluginHost.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  type BuiltinDeployProvider,
  BuiltinDeployProviders,
  builtinSecretName,
  layer as builtinsLayer,
} from "./BuiltinDeployProviders.ts";
import { DeployService, DeployWorkspace, layer as deployLayer, redact } from "./DeployService.ts";
import * as DeployStore from "./DeployStore.ts";
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

/** Every call the fake provider received, newest last. */
const calls: Array<{ readonly call: string; readonly input: unknown }> = [];
const lastCall = (call: string) => calls.filter((entry) => entry.call === call).at(-1)?.input;

/**
 * Stands in for a Vercel-like plugin with several accounts: each account's token lives only in
 * the plugin's own storage, under that account's id. A token containing `noscope` links with a
 * warning; storing `expired:<id>` makes that one account report expired.
 */
const fakeProvider = defineDeployProvider({
  manifest: manifest("fake-deploy", ["deploy:provider", "network:outbound"]),
  provider: { id: "fake", label: "Fake Cloud", icon: "cloud" },
  start: Effect.gen(function* () {
    const { storage } = yield* PluginContext;
    const tokenKey = (account: DeployAccountRef) => `token:${account.accountId}`;
    const record = <A>(call: string, input: unknown, value: A) => {
      calls.push({ call, input });
      return value;
    };
    const scopeWarning = [{ code: "scope", message: "Token lacks the domains scope." }];
    return {
      deploy: {
        link: ({ account, token }) => {
          if (token === undefined) {
            return Effect.succeed({
              _tag: "pending" as const,
              authorizeUrl: "https://example.test/oauth",
            });
          }
          if (!token.startsWith("tok-")) {
            return Effect.fail(new PluginError({ message: `Token ${token} was rejected.` }));
          }
          return Effect.all([
            storage.set(tokenKey(account), token),
            storage.remove(`expired:${account.accountId}`),
          ]).pipe(
            Effect.as({
              _tag: "linked" as const,
              accountLabel: `team-${account.teamId ?? "personal"}`,
              ...(account.teamId === undefined ? { teamId: "team_found" } : {}),
              ...(token.includes("noscope") ? { warnings: scopeWarning } : {}),
            }),
          );
        },
        unlink: (account) => storage.remove(tokenKey(account)),
        status: (account) =>
          Effect.gen(function* () {
            const token = yield* storage.get(tokenKey(account));
            if (Option.isNone(token)) {
              return { state: "unlinked" as const, accountLabel: null, message: null };
            }
            if (Option.isSome(yield* storage.get(`expired:${account.accountId}`))) {
              return { state: "expired" as const, accountLabel: "acme", message: "Sign in again." };
            }
            return {
              state: "linked" as const,
              accountLabel: `team-${account.teamId ?? "personal"}`,
              message: null,
              ...(token.value.includes("noscope") ? { warnings: scopeWarning } : {}),
            };
          }),
        listProjects: (account) =>
          Effect.succeed(
            record("listProjects", account, [
              { id: "web", name: "acme-web", kind: "pages" as const, url: "https://acme.app" },
              { id: "api", name: "acme-api", kind: "worker" as const },
            ]),
          ),
        deploy: (input) =>
          Effect.sync(() =>
            record("deploy", input, {
              deploymentId: `dpl_${calls.filter((entry) => entry.call === "deploy").length + 1}`,
              url: "https://preview.acme.app",
            }),
          ),
        deploymentStatus: ({ deploymentId }) =>
          Effect.succeed({ deploymentId, state: "ready" as const, url: "https://acme.app" }),
        logs: ({ deploymentId }) => Stream.fromIterable([`building ${deploymentId}`, "done"]),
        rollback: (input) =>
          Effect.succeed(
            record("rollback", input, { deploymentId: input.deploymentId ?? "dpl_previous" }),
          ),
        listDomains: (input) =>
          Effect.succeed(record("listDomains", input, [{ name: "acme.app", verified: true }])),
        setEnv: (input) => Effect.sync(() => record("setEnv", input, undefined)),
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
      // No `kind`: a provider cannot leave the host guessing a target's kind.
      listProjects: () => Effect.succeed([{ id: "web", name: "x" }] as never),
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
    link: () => Effect.succeed({ _tag: "linked" as const, accountLabel: "liar" }),
    unlink: () => no,
    status: () => Effect.succeed({ state: "unlinked" as const, accountLabel: null, message: null }),
    listProjects: () => Effect.succeed([]),
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
const WORKTREE = ThreadId.make("thread-worktree");
const PROJECT = ProjectId.make("project-1");
const OTHER_PROJECT = ProjectId.make("project-2");
const ROOT = "/work/acme";
const WORK = AccountProfileId.make("work");
const HOME = AccountProfileId.make("home");

const threads: Record<string, { runtimeMode: RuntimeMode; worktreePath: string | null }> = {
  [FULL]: { runtimeMode: "full-access", worktreePath: null },
  [ASKING]: { runtimeMode: "auto-accept-edits", worktreePath: null },
  [WORKTREE]: { runtimeMode: "full-access", worktreePath: "/work/acme-wt/feature" },
};

const layerWorkspace = Layer.succeed(
  DeployWorkspace,
  DeployWorkspace.of({
    thread: (threadId) => {
      const thread = threads[threadId];
      return Effect.succeed(thread === undefined ? null : { ...thread, projectId: PROJECT });
    },
    projectRoot: (projectId) =>
      Effect.succeed(
        projectId === PROJECT ? ROOT : projectId === OTHER_PROJECT ? "/work/two" : null,
      ),
  }),
);

const layerDb = SqlitePersistence.layerMemory.pipe(Layer.provide(NodeServices.layer));

const layerFor = (
  plugins: ReadonlyArray<typeof fakeProvider>,
  builtins: Layer.Layer<BuiltinDeployProviders> = Layer.succeed(BuiltinDeployProviders, []),
) =>
  deployLayer.pipe(
    Layer.provideMerge(builtins),
    Layer.provideMerge(DeployStore.layer),
    Layer.provideMerge(
      pluginHostLayer.pipe(
        Layer.provide(Layer.succeed(BundledPlugins, BundledPlugins.of({ plugins, failures: [] }))),
        Layer.provide(layerBindings),
      ),
    ),
    Layer.provideMerge(layerWorkspace),
    Layer.provideMerge(layerDb),
    Layer.provideMerge(Layer.mergeAll(NodeCrypto.layer, NodeServices.layer)),
    Layer.provideMerge(
      ServerSettings.ServerSettingsService.layerTest({
        accountProfiles: [
          { id: WORK, name: "Work" },
          { id: HOME, name: "Home" },
        ],
      }),
    ),
  );

const failureOf = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => "succeeded" }));
const reasonOf = <A, R>(effect: Effect.Effect<A, { readonly reason: string }, R>) =>
  effect.pipe(Effect.match({ onFailure: (error) => error.reason, onSuccess: () => "succeeded" }));

const enable = Effect.gen(function* () {
  yield* (yield* PluginHost).setEnabled({ pluginId: "fake-deploy", enabled: true });
  return yield* DeployService;
});

const linkAccount = (input: { label?: string; teamId?: string; token?: string } = {}) =>
  Effect.gen(function* () {
    const deploy = yield* enable;
    return yield* deploy.link({ pluginId: "fake-deploy", token: TOKEN, ...input });
  });

const target = (accountId: string, overrides: Partial<DeployMappingTarget> = {}) => ({
  accountId,
  targetKind: "pages" as const,
  targetId: "web",
  targetName: "acme-web",
  defaultEnvironment: "preview" as const,
  ...overrides,
});

const setActiveProfile = (id: AccountProfileId | null) =>
  Effect.flatMap(ServerSettings.ServerSettingsService, (settings) =>
    settings.updateSettings({ activeAccountProfileId: id }),
  );

describe("DeployService", () => {
  it.layer(layerFor([]))((it) => {
    it.effect("lists no providers when no plugin declares deploy:provider", () =>
      Effect.gen(function* () {
        const overview = yield* (yield* DeployService).overview;
        assert.deepStrictEqual(overview.providers, []);
        assert.deepStrictEqual(overview.accounts, []);
        assert.deepStrictEqual(overview.deployments, []);
      }),
    );
  });

  it.layer(layerFor([fakeProvider, offProvider]))((it) => {
    it.effect("links several named accounts of one provider, each expiring on its own", () =>
      Effect.gen(function* () {
        const personal = yield* linkAccount({ label: "Personal" });
        const business = yield* linkAccount({ label: "Business-A", teamId: "team_a" });
        const deploy = yield* DeployService;
        assert.notStrictEqual(personal.accountId, business.accountId);
        assert.deepStrictEqual(business.result, { _tag: "linked", accountLabel: "team-team_a" });

        const listed = (yield* deploy.overview).accounts;
        const byId = (id: string) => listed.find((account) => account.id === id);
        assert.strictEqual(byId(personal.accountId)?.label, "Personal");
        // The provider named the team the personal token belongs to; the host keeps it.
        assert.strictEqual(byId(personal.accountId)?.teamId, "team_found");
        assert.strictEqual(byId(business.accountId)?.teamId, "team_a");
        assert.strictEqual(byId(business.accountId)?.status.accountLabel, "team-team_a");
        assert.strictEqual(byId(business.accountId)?.pluginId, "fake-deploy");

        // Credentials sit in the plugin's storage under each account's id, never in settings.
        const store = storageByPlugin.get("fake-deploy");
        assert.strictEqual(store?.get(`token:${personal.accountId}`), TOKEN);
        assert.strictEqual(store?.get(`token:${business.accountId}`), TOKEN);

        store?.set(`expired:${business.accountId}`, "1");
        const states = (yield* deploy.overview).accounts.map((account) => [
          account.id,
          account.status.state,
        ]);
        assert.deepInclude(states, [business.accountId, "expired"]);
        assert.deepInclude(states, [personal.accountId, "linked"]);

        // Relinking names the account, so the other one is untouched.
        const relinked = yield* deploy.link({
          pluginId: "fake-deploy",
          accountId: business.accountId,
          token: TOKEN,
        });
        assert.strictEqual(relinked.accountId, business.accountId);
        assert.strictEqual(
          (yield* deploy.overview).accounts.find((a) => a.id === business.accountId)?.status.state,
          "linked",
        );

        yield* deploy.unlink(personal.accountId);
        const after = (yield* deploy.overview).accounts.map((account) => account.id);
        assert.notInclude(after, personal.accountId);
        assert.include(after, business.accountId);
        assert.isUndefined(store?.get(`token:${personal.accountId}`));
        assert.strictEqual(
          yield* reasonOf(deploy.listProjects(personal.accountId)),
          "unknown-account",
        );
      }),
    );

    it.effect("keeps no new account the provider refused, and starts a pending sign-in", () =>
      Effect.gen(function* () {
        const deploy = yield* enable;
        const before = (yield* deploy.overview).accounts.length;
        assert.strictEqual(
          yield* failureOf(deploy.link({ pluginId: "fake-deploy", token: `bad-${TOKEN}` })),
          "Token [redacted] was rejected.",
        );
        assert.strictEqual((yield* deploy.overview).accounts.length, before);

        const pending = yield* deploy.link({ pluginId: "fake-deploy", label: "OAuth" });
        assert.strictEqual(pending.result._tag, "pending");
        const listed = (yield* deploy.overview).accounts.find((a) => a.id === pending.accountId);
        assert.strictEqual(listed?.status.state, "unlinked");
        yield* deploy.unlink(pending.accountId);
      }),
    );

    it.effect("shows a provider's non-fatal warnings on the account", () =>
      Effect.gen(function* () {
        const linked = yield* linkAccount({ token: `${TOKEN}-noscope` });
        assert.strictEqual(linked.result._tag, "linked");
        if (linked.result._tag !== "linked") return;
        assert.deepStrictEqual(
          linked.result.warnings?.map((w) => w.code),
          ["scope"],
        );
        const account = (yield* (yield* DeployService).overview).accounts.find(
          (a) => a.id === linked.accountId,
        );
        assert.strictEqual(account?.status.state, "linked");
        assert.deepStrictEqual(account?.status.warnings, [
          { code: "scope", message: "Token lacks the domains scope." },
        ]);
      }),
    );

    it.effect("maps a typed target, deploys with the account and default env, reads back", () =>
      Effect.gen(function* () {
        const { accountId } = yield* linkAccount({ label: "Mapper", teamId: "team_m" });
        const deploy = yield* DeployService;
        assert.include(
          yield* failureOf(deploy.start({ projectId: PROJECT, accountId, sourceKind: "git" })),
          "Choose a deploy target",
        );
        const projects = yield* deploy.listProjects(accountId);
        assert.deepStrictEqual(
          projects.map((project) => [project.id, project.kind]),
          [
            ["web", "pages"],
            ["api", "worker"],
          ],
        );
        assert.deepStrictEqual(lastCall("listProjects"), { accountId, teamId: "team_m" });

        const mapping = target(accountId, {
          targetKind: "worker",
          targetId: "api",
          targetName: "acme-api",
          defaultEnvironment: "production",
        });
        yield* deploy.mapProject({ projectId: PROJECT, mapping });
        assert.deepStrictEqual((yield* deploy.overview).mappings[PROJECT], {
          projectId: PROJECT,
          ...mapping,
        });

        const started = yield* deploy.start({
          projectId: PROJECT,
          accountId,
          sourceKind: "git",
          branch: "main",
        });
        assert.strictEqual(started._tag, "started");
        if (started._tag !== "started") return;
        assert.deepStrictEqual(lastCall("deploy"), {
          account: { accountId, teamId: "team_m" },
          target: { kind: "worker", id: "api" },
          environment: "production",
          source: { kind: "git", projectRoot: ROOT, directory: ROOT, branch: "main" },
        });
        assert.strictEqual(started.deployment.targetKind, "worker");
        assert.strictEqual(started.deployment.environment, "production");
        assert.isNull(started.deployment.threadId);

        const { deploymentId } = started.deployment;
        const status = yield* deploy.status({ accountId, deploymentId });
        assert.strictEqual(status.state, "ready");
        const record = (yield* deploy.overview).deployments.find(
          (entry) => entry.deploymentId === deploymentId,
        );
        assert.strictEqual(record?.state, "ready");
        assert.strictEqual(record?.url, "https://acme.app");

        const lines = yield* Stream.runCollect(deploy.logs({ accountId, deploymentId }));
        assert.deepStrictEqual(lines, [`building ${deploymentId}`, "done"]);
        assert.deepStrictEqual(yield* deploy.rollback({ projectId: PROJECT }), {
          deploymentId: "dpl_previous",
        });
        assert.deepStrictEqual(lastCall("rollback"), {
          account: { accountId, teamId: "team_m" },
          target: { kind: "worker", id: "api" },
        });
        assert.deepStrictEqual(yield* deploy.domains(PROJECT), [
          { name: "acme.app", verified: true },
        ]);

        // A deploy must name the account the project is mapped to.
        const other = yield* linkAccount({ label: "Other" });
        assert.strictEqual(
          yield* reasonOf(
            deploy.start({ projectId: PROJECT, accountId: other.accountId, sourceKind: "git" }),
          ),
          "account-mismatch",
        );

        yield* deploy.mapProject({ projectId: PROJECT, mapping: null });
        assert.isUndefined((yield* deploy.overview).mappings[PROJECT]);
      }),
    );

    it.effect("passes setEnv's environment, secret flag and removals through", () =>
      Effect.gen(function* () {
        const { accountId } = yield* linkAccount();
        const deploy = yield* DeployService;
        yield* deploy.mapProject({ projectId: OTHER_PROJECT, mapping: target(accountId) });
        yield* deploy.setEnv({
          projectId: OTHER_PROJECT,
          environment: "development",
          vars: { API_URL: "http://localhost" },
          secret: true,
          remove: ["OLD_KEY"],
        });
        assert.deepStrictEqual(lastCall("setEnv"), {
          account: { accountId, teamId: "team_found" },
          target: { kind: "pages", id: "web" },
          environment: "development",
          vars: { API_URL: "http://localhost" },
          secret: true,
          remove: ["OLD_KEY"],
        });
        yield* deploy.setEnv({ projectId: OTHER_PROJECT, environment: "preview", vars: {} });
        assert.deepInclude(lastCall("setEnv"), {
          environment: "preview",
          secret: false,
          remove: [],
        });
      }),
    );

    it.effect("resolves the folder from the project root and refuses one outside it", () =>
      Effect.gen(function* () {
        const { accountId } = yield* linkAccount();
        const deploy = yield* DeployService;
        yield* deploy.mapProject({
          projectId: PROJECT,
          mapping: target(accountId, { directory: "apps/web" }),
        });
        const sourceOf = () => (lastCall("deploy") as { readonly source: unknown }).source;

        yield* deploy.start({ projectId: PROJECT, accountId, sourceKind: "local-build" });
        assert.deepStrictEqual(sourceOf(), {
          kind: "local-build",
          projectRoot: ROOT,
          directory: `${ROOT}/apps/web`,
        });
        yield* deploy.start({
          projectId: PROJECT,
          accountId,
          sourceKind: "local-build",
          directory: `${ROOT}/dist`,
        });
        assert.deepInclude(sourceOf(), { directory: `${ROOT}/dist` });

        for (const directory of ["../elsewhere", "/etc", "apps/../../acme-evil"]) {
          assert.strictEqual(
            yield* reasonOf(
              deploy.start({ projectId: PROJECT, accountId, sourceKind: "local-build", directory }),
            ),
            "outside-project",
          );
        }
        yield* deploy.start({
          projectId: PROJECT,
          accountId,
          sourceKind: "local-build",
          directory: "../shared-dist",
          allowOutsideProject: true,
        });
        assert.deepInclude(sourceOf(), { directory: "/work/shared-dist" });

        // A thread's own worktree is the root it deploys from.
        yield* deploy.start({
          projectId: PROJECT,
          accountId,
          sourceKind: "local-build",
          threadId: WORKTREE,
        });
        assert.deepStrictEqual(sourceOf(), {
          kind: "local-build",
          projectRoot: "/work/acme-wt/feature",
          directory: "/work/acme-wt/feature/apps/web",
        });

        const unknown = ProjectId.make("project-unknown");
        yield* deploy.mapProject({ projectId: unknown, mapping: target(accountId) });
        assert.strictEqual(
          yield* reasonOf(deploy.start({ projectId: unknown, accountId, sourceKind: "git" })),
          "unknown-project",
        );
      }),
    );

    it.effect("holds a deploy from a thread below Full access until someone approves it", () =>
      Effect.gen(function* () {
        const { accountId } = yield* linkAccount();
        const deploy = yield* DeployService;
        yield* deploy.mapProject({ projectId: PROJECT, mapping: target(accountId) });
        const deploys = () => calls.filter((entry) => entry.call === "deploy").length;
        const before = deploys();

        const full = yield* deploy.start({
          projectId: PROJECT,
          accountId,
          sourceKind: "git",
          threadId: FULL,
        });
        assert.strictEqual(full._tag, "started");
        if (full._tag === "started") assert.strictEqual(full.deployment.threadId, FULL);
        assert.strictEqual(deploys(), before + 1);

        const held: Array<string> = [];
        for (const threadId of [ASKING, ThreadId.make("thread-unknown")]) {
          const result = yield* deploy.start({
            projectId: PROJECT,
            accountId,
            environment: "production",
            sourceKind: "git",
            branch: "feature",
            threadId,
          });
          assert.strictEqual(result._tag, "approval-required");
          if (result._tag !== "approval-required") return;
          assert.strictEqual(result.approval.threadId, threadId);
          assert.strictEqual(result.approval.directory, ROOT);
          assert.strictEqual(result.approval.accountId, accountId);
          held.push(result.approval.id);
        }
        assert.strictEqual(deploys(), before + 1);

        assert.isNull(yield* deploy.decideApproval({ approvalId: held[0]!, approve: false }));
        assert.strictEqual(deploys(), before + 1);
        const record = yield* deploy.decideApproval({ approvalId: held[1]!, approve: true });
        assert.strictEqual(record?.branch, "feature");
        assert.strictEqual(record?.environment, "production");
        assert.strictEqual(deploys(), before + 2);
        assert.deepStrictEqual((yield* deploy.overview).approvals, []);
        assert.include(
          yield* failureOf(deploy.decideApproval({ approvalId: held[1]!, approve: true })),
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
          const linked = yield* linkAccount();
          const deploy = yield* DeployService;
          const rejected = yield* failureOf(
            deploy.link({ pluginId: "fake-deploy", token: `bad-${TOKEN}` }),
          );
          yield* deploy.mapProject({ projectId: PROJECT, mapping: target(linked.accountId) });
          yield* deploy.start({
            projectId: PROJECT,
            accountId: linked.accountId,
            sourceKind: "git",
          });
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
      }),
    );

    it.effect("refuses a provider that is not turned on", () =>
      Effect.gen(function* () {
        const deploy = yield* DeployService;
        assert.include(yield* failureOf(deploy.link({ pluginId: "off-deploy" })), "Turn on");
        assert.strictEqual(yield* reasonOf(deploy.link({ pluginId: "nope" })), "unknown-provider");
      }),
    );
  });

  it.layer(layerFor([fakeProvider]))((it) => {
    it.effect("scopes accounts, mappings, deployments and approvals to the active profile", () =>
      Effect.gen(function* () {
        const work = yield* linkAccount({ label: "Business-B" });
        const deploy = yield* DeployService;
        yield* deploy.updateAccount({ accountId: work.accountId, profileIds: [WORK] });
        const everywhere = yield* linkAccount({ label: "Shared" });
        yield* deploy.mapProject({ projectId: PROJECT, mapping: target(work.accountId) });
        yield* deploy.mapProject({
          projectId: OTHER_PROJECT,
          mapping: target(everywhere.accountId),
        });
        yield* deploy.start({ projectId: PROJECT, accountId: work.accountId, sourceKind: "git" });
        const held = yield* deploy.start({
          projectId: PROJECT,
          accountId: work.accountId,
          sourceKind: "git",
          threadId: ASKING,
        });
        assert.strictEqual(held._tag, "approval-required");
        if (held._tag !== "approval-required") return;

        yield* setActiveProfile(WORK);
        const inWork = yield* deploy.overview;
        assert.strictEqual(inWork.activeProfileId, WORK);
        assert.sameMembers(
          inWork.accounts.map((account) => account.id),
          [work.accountId, everywhere.accountId],
        );

        yield* setActiveProfile(HOME);
        const inHome = yield* deploy.overview;
        assert.deepStrictEqual(
          inHome.accounts.map((account) => account.id),
          [everywhere.accountId],
        );
        assert.deepStrictEqual(Object.keys(inHome.mappings), [OTHER_PROJECT]);
        assert.isFalse(inHome.deployments.some((record) => record.accountId === work.accountId));
        assert.deepStrictEqual(inHome.approvals, []);

        // Every call naming the hidden account is refused on the server, not only hidden.
        for (const effect of [
          deploy.start({ projectId: PROJECT, accountId: work.accountId, sourceKind: "git" }),
          deploy.listProjects(work.accountId),
          deploy.decideApproval({ approvalId: held.approval.id, approve: true }),
          deploy.status({ accountId: work.accountId, deploymentId: "dpl_1" }),
          Stream.runCollect(deploy.logs({ accountId: work.accountId, deploymentId: "dpl_1" })),
          deploy.domains(PROJECT),
          deploy.rollback({ projectId: PROJECT }),
          deploy.setEnv({ projectId: PROJECT, environment: "preview", vars: {} }),
          deploy.mapProject({ projectId: PROJECT, mapping: null }),
          deploy.mapProject({ projectId: OTHER_PROJECT, mapping: target(work.accountId) }),
          deploy.updateAccount({ accountId: work.accountId, profileIds: [] }),
          deploy.unlink(work.accountId),
        ]) {
          assert.strictEqual(yield* reasonOf(effect), "not-in-profile");
        }

        // A new account made while Home is active lands in Home.
        const home = yield* linkAccount({ label: "Personal" });
        assert.deepStrictEqual(
          (yield* deploy.overview).accounts.find((a) => a.id === home.accountId)?.profileIds,
          [HOME],
        );

        yield* setActiveProfile(WORK);
        assert.strictEqual((yield* deploy.overview).approvals[0]?.id, held.approval.id);
        assert.isNotNull(
          yield* deploy.decideApproval({ approvalId: held.approval.id, approve: true }),
        );
        yield* setActiveProfile(null);
      }),
    );

    it.effect("keeps history and approvals across a restart, capped per project", () =>
      Effect.gen(function* () {
        const { accountId } = yield* linkAccount({ label: "Persisted" });
        const deploy = yield* DeployService;
        threads["thread-persist"] = { runtimeMode: "approval-required", worktreePath: null };
        yield* deploy.mapProject({ projectId: OTHER_PROJECT, mapping: target(accountId) });
        for (let index = 0; index < DeployStore.MAX_RECORDS_PER_PROJECT + 5; index++) {
          yield* deploy.start({ projectId: OTHER_PROJECT, accountId, sourceKind: "git" });
        }
        for (let index = 0; index < DeployStore.MAX_APPROVALS_PER_PROJECT + 3; index++) {
          const extra = yield* deploy.start({
            projectId: OTHER_PROJECT,
            accountId,
            sourceKind: "git",
            threadId: ThreadId.make("thread-persist"),
          });
          assert.strictEqual(extra._tag, "approval-required");
        }
        const held = yield* deploy.start({
          projectId: OTHER_PROJECT,
          accountId,
          sourceKind: "git",
          threadId: ThreadId.make("thread-persist"),
        });
        assert.strictEqual(held._tag, "approval-required");

        // A second service over the same database is what the next server start sees.
        const restarted = yield* Layer.build(Layer.fresh(deployLayer)).pipe(
          Effect.map((context) => Context.get(context, DeployService)),
        );
        const overview = yield* restarted.overview;
        const kept = overview.deployments.filter((record) => record.projectId === OTHER_PROJECT);
        assert.strictEqual(kept.length, DeployStore.MAX_RECORDS_PER_PROJECT);
        assert.isTrue(kept.every((record) => record.accountId === accountId));
        assert.strictEqual(overview.mappings[OTHER_PROJECT]?.accountId, accountId);
        assert.strictEqual(
          overview.approvals.filter((entry) => entry.projectId === OTHER_PROJECT).length,
          DeployStore.MAX_APPROVALS_PER_PROJECT,
        );
        if (held._tag !== "approval-required") return;
        const approved = yield* restarted.decideApproval({
          approvalId: held.approval.id,
          approve: true,
        });
        assert.strictEqual(approved?.threadId, "thread-persist");
      }).pipe(Effect.scoped),
    );
  });

  it.layer(layerFor([liarProvider, undeclaredProvider]))((it) => {
    it.effect("checks provider output against the contract and the manifest's capability", () =>
      Effect.gen(function* () {
        const host = yield* PluginHost;
        const deploy = yield* DeployService;
        yield* host.setEnabled({ pluginId: "liar-deploy", enabled: true });
        const { accountId } = yield* deploy.link({ pluginId: "liar-deploy" });
        assert.include(yield* failureOf(deploy.listProjects(accountId)), "invalid project list");
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

  /** A built-in claiming the same id as an installed plugin. */
  const builtinCalls: Array<string> = [];
  const shadowingBuiltin: BuiltinDeployProvider = {
    info: {
      id: "fake-deploy",
      label: "Built-in Fake",
      icon: "cloud",
      version: "9.9.9",
      description: "Ships with p0code.",
      supportedOperations: ["link", "status"],
      supportedTargetKinds: ["pages"],
      supportedSourceKinds: ["git"],
    },
    provider: checkDeployProvider(
      { id: "fake-deploy", label: "Built-in Fake", icon: "cloud" },
      {
        ...offStub(),
        link: () =>
          Effect.sync(() => {
            builtinCalls.push("link");
            return { _tag: "linked" as const, accountLabel: "builtin" };
          }),
        status: () =>
          Effect.succeed({ state: "linked" as const, accountLabel: "builtin", message: null }),
      },
    ),
  };

  it.layer(
    layerFor(
      [fakeProvider, offProvider],
      Layer.succeed(BuiltinDeployProviders, [shadowingBuiltin]),
    ),
  )((it) => {
    it.effect(
      "resolves a built-in before a plugin, falls back to plugins, refuses unknown ids",
      () =>
        Effect.gen(function* () {
          const deploy = yield* DeployService;
          // The built-in answers without the same-id plugin ever being turned on.
          const linked = yield* deploy.link({ pluginId: "fake-deploy", token: TOKEN });
          assert.deepStrictEqual(linked.result, { _tag: "linked", accountLabel: "builtin" });
          assert.deepStrictEqual(builtinCalls, ["link"]);
          assert.isUndefined(storageByPlugin.get("fake-deploy")?.get(`token:${linked.accountId}`));

          const overview = yield* deploy.overview;
          assert.deepStrictEqual(overview.providers, [
            {
              pluginId: "fake-deploy",
              label: "Built-in Fake",
              icon: "cloud",
              running: true,
              origin: "builtin",
              version: "9.9.9",
              description: "Ships with p0code.",
              supportedOperations: ["link", "status"],
              supportedTargetKinds: ["pages"],
              supportedSourceKinds: ["git"],
            },
            {
              pluginId: "off-deploy",
              label: "off-deploy plugin",
              icon: null,
              running: false,
              origin: "plugin",
              version: "1.0.0",
              description: "Test deploy provider.",
              supportedOperations: [
                "link",
                "unlink",
                "status",
                "list-projects",
                "deploy",
                "deployment-status",
                "logs",
                "rollback",
                "list-domains",
                "set-env",
              ],
            },
          ]);
          assert.strictEqual(
            overview.accounts.find((account) => account.id === linked.accountId)?.status
              .accountLabel,
            "builtin",
          );

          // Plugin providers no built-in claims still resolve.
          assert.include(yield* failureOf(deploy.link({ pluginId: "off-deploy" })), "Turn on");
          assert.strictEqual(
            yield* reasonOf(deploy.link({ pluginId: "nope" })),
            "unknown-provider",
          );
        }),
    );
  });

  const memorySecrets = new Map<string, Uint8Array>();
  const layerMemorySecrets = Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromNullishOr(memorySecrets.get(name))),
      set: (name, value) => Effect.sync(() => void memorySecrets.set(name, value)),
      create: (name, value) => Effect.sync(() => void memorySecrets.set(name, value)),
      getOrCreateRandom: () => Effect.die("unused"),
      remove: (name) => Effect.sync(() => void memorySecrets.delete(name)),
    }),
  );
  const layerRealBuiltins = builtinsLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerMemorySecrets,
        FetchHttpClient.layer,
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    ),
  );

  it.layer(layerFor([], layerRealBuiltins))((it) => {
    it.effect("lists Vercel and Cloudflare as built-ins with their metadata", () =>
      Effect.gen(function* () {
        const providers = (yield* (yield* DeployService).overview).providers;
        assert.deepStrictEqual(
          providers.map((provider) => [provider.pluginId, provider.origin, provider.running]),
          [
            ["vercel", "builtin", true],
            ["cloudflare", "builtin", true],
          ],
        );
        assert.deepStrictEqual(providers[0]?.supportedTargetKinds, ["vercel-project"]);
        assert.deepStrictEqual(providers[1]?.supportedTargetKinds, ["pages", "worker"]);
        assert.strictEqual(providers[0]?.version, "0.2.0");
        assert.strictEqual(providers[1]?.version, "0.3.0");
      }),
    );

    it.effect("keeps an account linked through the former vercel plugin working", () =>
      Effect.gen(function* () {
        // What the `vercel` plugin left behind: its account row and its namespaced secrets.
        const store = yield* DeployStore.DeployStore;
        yield* store.insertAccount({
          id: "legacy-vercel",
          pluginId: "vercel",
          label: "Old plugin",
          teamId: null,
          profileIds: [],
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        const encode = (text: string) => new TextEncoder().encode(text);
        memorySecrets.set(builtinSecretName("vercel", "legacy-vercel:token"), encode(TOKEN));
        memorySecrets.set(
          builtinSecretName("vercel", "legacy-vercel:account"),
          encode(JSON.stringify({ accountLabel: "acme", userId: "u_1", linkedAt: 1 })),
        );
        assert.strictEqual(builtinSecretName("vercel", "k"), "plugin-vercel-k");

        const deploy = yield* DeployService;
        const account = (yield* deploy.overview).accounts.find(
          (candidate) => candidate.id === "legacy-vercel",
        );
        assert.deepStrictEqual(account?.status, {
          state: "linked",
          accountLabel: "acme",
          message: null,
          warnings: [],
        });

        yield* deploy.unlink("legacy-vercel");
        assert.isFalse(memorySecrets.has("plugin-vercel-legacy-vercel:token"));
        assert.isFalse(memorySecrets.has("plugin-vercel-legacy-vercel:account"));
      }),
    );
  });

  it.effect("keeps the own-server stub unwired: it refuses to deploy", () =>
    Effect.gen(function* () {
      assert.strictEqual(ownServerDeployProvider.descriptor.id, "p0deploy");
      assert.include(
        yield* failureOf(
          ownServerDeployProvider.deploy({
            account: { accountId: "a" },
            target: { kind: "worker", id: "p" },
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

  it("needs read for reads, providers:manage for accounts, settings:write to map, operate to deploy", () => {
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
    for (const method of [
      WS_METHODS.deployLink,
      WS_METHODS.deployUnlink,
      WS_METHODS.deployUpdateAccount,
    ]) {
      assert.deepStrictEqual(scopes(method), [AuthProvidersManageScope]);
    }
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
