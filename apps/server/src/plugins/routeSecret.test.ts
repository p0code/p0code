import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { removeObsoleteRouteSecrets, routeSecret } from "./routeSecret.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))((it) => {
  it.effect("keeps each plugin's secret across store restarts and rotates after removal", () =>
    Effect.gen(function* () {
      const restart = <A, E>(operation: Effect.Effect<A, E, ServerSecretStore.ServerSecretStore>) =>
        Effect.scoped(operation.pipe(Effect.provide(ServerSecretStore.layer)));
      const first = yield* restart(routeSecret("bridge"));
      assert.match(first, /^[A-Za-z0-9_-]{43}$/u);
      assert.strictEqual(yield* restart(routeSecret("bridge")), first);
      assert.notStrictEqual(yield* restart(routeSecret("other")), first);
      yield* restart(removeObsoleteRouteSecrets([{ id: "bridge", capabilities: ["http:routes"] }]));
      assert.strictEqual(yield* restart(routeSecret("bridge")), first);
      yield* restart(removeObsoleteRouteSecrets([]));
      assert.notStrictEqual(yield* restart(routeSecret("bridge")), first);
    }).pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "plugin-routes-test-" })),
    ),
  );
});
