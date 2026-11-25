import {
  AuthStandardClientScopes,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type PluginCapability,
  type PluginManifest,
  type ThreadId,
  type UsageBucket,
  UsageSummaryInput,
} from "@t3tools/contracts";
import {
  PluginContext,
  PluginError,
  type PluginServices,
  type UsageDailyTotal,
} from "@t3tools/plugin-api";
import {
  projectThreadAwarenessV2,
  turnItemCanChangeUserWait,
} from "@t3tools/shared/agentAwareness";
import { turnItemUpdateCanEndBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type * as ServerSettings from "../serverSettings.ts";
import { loopbackUrlHostForAddress } from "../startupAccess.ts";
import * as UsageService from "../usage/UsageService.ts";
import { migrateObsidianSharedMemory } from "./migrateObsidianSharedMemory.ts";
import { PluginHostBindings } from "./PluginHost.ts";

/** Sessions and links a plugin mints carry this subject, so disabling it can end them. */
const pluginSubject = (pluginId: string) => `plugin:${pluginId}`;

const ALWAYS_PUBLISHED = new Set<string>([
  "thread.created",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.metadata-updated",
  "thread.settled",
  "thread.model-selection-updated",
  "thread.provider-switched",
  "run.created",
  "run.updated",
  "runtime-request.updated",
  "subagent.updated",
  "provider-thread.updated",
]);

/** Events that can change what a phone shows for a thread; the rest would only add load. */
function canChangeAgentActivity(
  event: Pick<OrchestrationV2DomainEvent, "type"> & { readonly payload?: unknown },
): boolean {
  if (ALWAYS_PUBLISHED.has(event.type)) return true;
  if (event.type !== "turn-item.updated") return false;
  const payload = event.payload;
  return (
    isTurnItemPayload(payload) &&
    (turnItemUpdateCanEndBackgroundWork(payload) || turnItemCanChangeUserWait(payload))
  );
}

function isTurnItemPayload(
  payload: unknown,
): payload is Pick<OrchestrationV2TurnItem, "type" | "status"> {
  return (
    typeof payload === "object" && payload !== null && "type" in payload && "status" in payload
  );
}

const hostError = (message: string) => (cause: unknown) => new PluginError({ message, cause });

const decodeUsageSummaryInput = Schema.decodeUnknownEffect(UsageSummaryInput);

/** One row per day, provider and model; drops sourcePath, hourStart and session counts. */
function toDailyTotals(buckets: ReadonlyArray<UsageBucket>): Array<UsageDailyTotal> {
  const rows = new Map<string, UsageDailyTotal>();
  for (const bucket of buckets) {
    const key = `${bucket.day}\u0000${bucket.provider}\u0000${bucket.model}`;
    const row = rows.get(key);
    rows.set(key, {
      day: bucket.day,
      provider: bucket.provider,
      model: bucket.model,
      uncachedInputTokens: (row?.uncachedInputTokens ?? 0) + bucket.totals.uncachedInputTokens,
      cachedInputTokens: (row?.cachedInputTokens ?? 0) + bucket.totals.cachedInputTokens,
      cacheCreationTokens: (row?.cacheCreationTokens ?? 0) + bucket.totals.cacheCreationTokens,
      outputTokens: (row?.outputTokens ?? 0) + bucket.totals.outputTokens,
      reasoningTokens: (row?.reasoningTokens ?? 0) + bucket.totals.reasoningTokens,
      costUsd: (row?.costUsd ?? 0) + bucket.costUsd,
      records: (row?.records ?? 0) + bucket.records,
      unpricedRecords: (row?.unpricedRecords ?? 0) + bucket.unpricedRecords,
    });
  }
  return [...rows.values()];
}

export const layer = Layer.effect(
  PluginHostBindings,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const config = yield* ServerConfig.ServerConfig;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const pairingLinks = yield* PairingGrantStore.PairingGrantStore;
    const httpServer = yield* HttpServer.HttpServer;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const projects = yield* ProjectService.ProjectService;
    const usage = yield* UsageService.UsageService;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* Effect.context<Exclude<PluginServices, PluginContext>>();

    const revokeIssued = Effect.fn("PluginHostBindings.revokeIssued")(
      function* (pluginId: string) {
        const subject = pluginSubject(pluginId);
        const active = yield* sessions.listActive();
        yield* Effect.forEach(
          active.filter((session) => session.subject === subject),
          (session) => sessions.revoke(session.sessionId),
          { discard: true },
        );
        const links = yield* pairingLinks.listActive();
        yield* Effect.forEach(
          links.filter((link) => link.subject === subject),
          (link) => pairingLinks.revoke(link.id),
          { discard: true },
        );
      },
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not revoke a plugin's sessions", { cause }),
      ),
    );

    const readActivity = Effect.fn("PluginHostBindings.readActivity")(function* (
      threadId: ThreadId,
    ) {
      const environmentId = yield* environment.getEnvironmentId;
      const snapshot = yield* threads.getAgentAwarenessSnapshot(threadId);
      const thread = snapshot.threads[0];
      if (thread === undefined || thread.archivedAt !== null) return null;
      const project = yield* projects.getById(thread.projectId);
      if (Option.isNone(project)) return null;
      return projectThreadAwarenessV2({ environmentId, project: project.value, thread });
    });

    const activeThreadIds = Effect.gen(function* () {
      const environmentId = yield* environment.getEnvironmentId;
      const snapshot = yield* threads.getAgentAwarenessSnapshot();
      const ids: Array<ThreadId> = [];
      for (const thread of snapshot.threads) {
        const project = yield* projects.getById(thread.projectId);
        if (Option.isNone(project)) continue;
        const state = projectThreadAwarenessV2({ environmentId, project: project.value, thread });
        if (state !== null && state.phase !== "completed" && state.phase !== "failed") {
          ids.push(thread.id);
        }
      }
      return ids;
    });

    const contextFor = Effect.fn("PluginHostBindings.contextFor")(function* (
      manifest: PluginManifest,
      reportStatus: (message: string | null) => Effect.Effect<void>,
    ) {
      const declared = (capability: PluginCapability) => manifest.capabilities.includes(capability);
      const refused = Effect.fail(
        new PluginError({ message: "The plugin did not declare this capability." }),
      );
      const secretName = (key: string) => `plugin-${manifest.id}-${key}`;
      const dataDir = path.join(config.stateDir, "plugins", manifest.id);
      yield* fileSystem.makeDirectory(dataDir, { recursive: true }).pipe(Effect.ignore);

      return PluginContext.of({
        pluginId: manifest.id,
        dataDir,
        storage: {
          get: (key) =>
            secrets
              .get(secretName(key))
              .pipe(
                Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
                Effect.mapError(hostError("Could not read plugin storage.")),
              ),
          set: (key, value) =>
            secrets
              .set(secretName(key), new TextEncoder().encode(value))
              .pipe(Effect.mapError(hostError("Could not write plugin storage."))),
          remove: (key) =>
            secrets
              .remove(secretName(key))
              .pipe(Effect.mapError(hostError("Could not write plugin storage."))),
        },
        reportStatus,
        environment: {
          environmentId: environment.getEnvironmentId,
          descriptor: environment.getDescriptor,
          localOrigin: Effect.suspend(() => {
            const address = httpServer.address;
            return typeof address === "string" || !("port" in address)
              ? Effect.fail(new PluginError({ message: "This server has no TCP address." }))
              : Effect.succeed(`http://${loopbackUrlHostForAddress(address)}:${address.port}`);
          }),
        },
        deviceAccess: declared("auth:issue-device-credentials")
          ? {
              issueCredential: (input) =>
                auth
                  .createPairingLink({
                    scopes: AuthStandardClientScopes,
                    subject: pluginSubject(manifest.id),
                    // Spent within seconds by the device the relay just vouched for.
                    ttl: Duration.minutes(2),
                    label: input.label,
                    proofKeyThumbprint: input.proofKeyThumbprint,
                  })
                  .pipe(
                    Effect.map((issued) => ({
                      credential: issued.credential,
                      expiresAt: issued.expiresAt,
                    })),
                    Effect.mapError(hostError("Could not issue a device credential.")),
                  ),
              revokeAll: revokeIssued(manifest.id),
            }
          : { issueCredential: () => refused, revokeAll: refused },
        agentActivity: declared("orchestration:read-activity")
          ? {
              changes: threads.streamDomainEvents.pipe(
                Stream.filter(canChangeAgentActivity),
                Stream.map((event) => event.threadId),
                Stream.catchCause(() => Stream.empty),
              ),
              read: (threadId) =>
                readActivity(threadId).pipe(Effect.mapError(hostError("Could not read activity."))),
              activeThreadIds: activeThreadIds.pipe(
                Effect.mapError(hostError("Could not read activity.")),
              ),
            }
          : { changes: Stream.empty, read: () => refused, activeThreadIds: refused },
        usage: declared("usage:read")
          ? {
              dailyTotals: (input) =>
                decodeUsageSummaryInput({
                  sinceDay: input.sinceDay,
                  untilDay: input.untilDay,
                  timeZone: input.timeZone,
                  resolution: "day",
                  awaitRefresh: true,
                }).pipe(
                  Effect.mapError(hostError("Could not read usage.")),
                  Effect.flatMap((summaryInput) =>
                    usage.readSummary(summaryInput).pipe(
                      Effect.map((summary) => toDailyTotals(summary.buckets)),
                      Effect.mapError(hostError("Could not read usage.")),
                    ),
                  ),
                ),
            }
          : { dailyTotals: () => refused },
      });
    });

    const migrateLegacyData = Effect.fn("PluginHostBindings.migrateLegacyData")(function* (
      settings: ServerSettings.ServerSettingsService["Service"],
    ) {
      yield* migrateObsidianSharedMemory({
        stateDir: config.stateDir,
        fileSystem,
        path,
        secrets,
        settings,
      });
    });

    return PluginHostBindings.of({
      contextFor,
      revokeIssued,
      migrateLegacyData,
      platform,
    });
  }),
);
