import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as AntigravityUsage from "./AntigravityUsage.ts";

it.effect("only the driver's default entry reads the shared ~/.gemini history", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "antigravity-usage-" });
    const shared = path.join(home, ".gemini", "antigravity", "conversations");
    yield* fileSystem.makeDirectory(shared, { recursive: true });
    const sharedReal = yield* fileSystem.realPath(shared);
    const scannedDirs = (configured: boolean) =>
      AntigravityUsage.AntigravityUsage.pipe(
        Effect.flatMap((usage) =>
          usage.scan({
            instances: [
              {
                instanceId: ProviderInstanceId.make("antigravityTrial"),
                config: undefined,
                environment: {},
                configured,
              },
            ],
            windowStartMs: 0,
          }),
        ),
        Effect.map((scans) => scans.map((scan) => scan.dir)),
        Effect.provide(
          AntigravityUsage.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                NodeServices.layer,
                NodeCrypto.layer,
                Layer.mock(ProviderHost.ProviderHost)({
                  paths: {
                    cwd: home,
                    baseDir: home,
                    stateDir: path.join(home, "state"),
                    providerStatusCacheDir: home,
                    attachmentsDir: home,
                  },
                  settings: {
                    get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
                    withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
                    changes: Stream.empty,
                    subscribe: Effect.succeed(Stream.empty),
                  },
                  resolveAttachmentPath: () => null,
                }),
              ),
            ),
          ),
        ),
        Effect.provideService(HostProcess.HomeDirectory, home),
      );
    assert.notInclude(yield* scannedDirs(true), sharedReal);
    assert.include(yield* scannedDirs(false), sharedReal);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
