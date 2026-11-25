import { Persistence } from "@t3tools/client-runtime/platform";
import { EnvironmentQueryStore } from "@t3tools/client-runtime/state/query-persistence";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";

import * as ConnectionStorage from "./storage";

describe("IndexedDB query cache", () => {
  it.effect("round trips per environment and clears with the environment", () =>
    Effect.gen(function* () {
      const store = (yield* EnvironmentQueryStore)!;
      const first = EnvironmentId.make("query-first");
      yield* store.save(first, "pr", "cached");
      expect(yield* store.load(first, "pr")).toEqual(Option.some("cached"));
      expect(yield* store.load(EnvironmentId.make("query-second"), "pr")).toEqual(Option.none());
      yield* (yield* Persistence.EnvironmentCacheStore).clear(first);
      expect(yield* store.load(first, "pr")).toEqual(Option.none());
    }).pipe(Effect.provide(ConnectionStorage.layer)),
  );

  it.effect("two tabs' bursts of saves end within 256 rows and 32 MiB", () =>
    Effect.gen(function* () {
      const openTab = Layer.build(Layer.fresh(ConnectionStorage.layer)).pipe(
        Effect.map((context) => Context.get(context, EnvironmentQueryStore)!),
      );
      const tabs = [yield* openTab, yield* openTab];
      const environmentId = EnvironmentId.make("query-bounded");
      const saveAll = (keys: ReadonlyArray<string>, payload: (key: string) => string) =>
        Effect.forEach(keys, (key, index) =>
          tabs[index % 2]!.save(environmentId, key, payload(key)).pipe(
            Effect.andThen(TestClock.adjust("1 millis")),
          ),
        );
      const loadAll = (keys: ReadonlyArray<string>) =>
        Effect.forEach(keys, (key) => tabs[0]!.load(environmentId, key)).pipe(
          Effect.map((loaded) => loaded.filter(Option.isSome).map((stored) => stored.value)),
        );

      const rows = Array.from({ length: 300 }, (_, index) => `row-${index}`);
      yield* saveAll(rows, (key) => key);
      const keptRows = yield* loadAll(rows);
      expect(keptRows.length).toBeLessThanOrEqual(256);
      expect(keptRows).not.toContain("row-0");
      expect(keptRows).toContain("row-299");

      const answer = "x".repeat(4 * 1024 * 1024);
      const large = Array.from({ length: 9 }, (_, index) => `large-${index}`);
      yield* saveAll(large, () => answer);
      const keptBytes = (yield* loadAll([...rows, ...large])).reduce(
        (total, payload) => total + payload.length,
        0,
      );
      expect(keptBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
      expect(yield* tabs[1]!.load(environmentId, "large-8")).toEqual(Option.some(answer));
    }),
  );

  it.effect("drops the older copy when an answer grows too large to keep", () =>
    Effect.gen(function* () {
      const store = (yield* EnvironmentQueryStore)!;
      const environmentId = EnvironmentId.make("query-oversize");
      yield* store.save(environmentId, "diff", "small");
      yield* store.save(environmentId, "diff", "x".repeat(4 * 1024 * 1024 + 1));
      expect(yield* store.load(environmentId, "diff")).toEqual(Option.none());
    }).pipe(Effect.provide(ConnectionStorage.layer)),
  );
});

const CATALOG_TEST_DATABASE = "t3code:connection-runtime";
const CATALOG_TEST_STORE = "catalog";

function openCatalogTestDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CATALOG_TEST_DATABASE, 5);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(CATALOG_TEST_STORE)) {
        request.result.createObjectStore(CATALOG_TEST_STORE);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function deleteCatalogTestDatabase(): Effect.Effect<void> {
  return Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(CATALOG_TEST_DATABASE);
        request.addEventListener("success", () => resolve());
        request.addEventListener("error", () => resolve());
        request.addEventListener("blocked", () => resolve());
      }),
  );
}

function readCatalogTestValues(): Effect.Effect<Readonly<Record<string, unknown>>> {
  return Effect.promise(async () => {
    const database = await openCatalogTestDatabase();
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const transaction = database.transaction(CATALOG_TEST_STORE, "readonly");
        const values: Record<string, unknown> = {};
        const request = transaction.objectStore(CATALOG_TEST_STORE).openCursor();
        request.addEventListener("success", () => {
          const cursor = request.result;
          if (cursor === null) return;
          values[String(cursor.key)] = cursor.value;
          cursor.continue();
        });
        transaction.addEventListener("complete", () => resolve(values));
        transaction.addEventListener("abort", () => reject(transaction.error));
      });
    } finally {
      database.close();
    }
  });
}

describe("IndexedDB catalog recovery", () => {
  it.effect("keeps the unreadable value and reports where it was kept", () =>
    Effect.gen(function* () {
      yield* deleteCatalogTestDatabase();
      const database = yield* Effect.promise(openCatalogTestDatabase);
      yield* Effect.callback<void>((resume) => {
        const transaction = database.transaction(CATALOG_TEST_STORE, "readwrite");
        transaction.objectStore(CATALOG_TEST_STORE).put("{not-json", "document");
        transaction.addEventListener("complete", () => resume(Effect.void));
        transaction.addEventListener("abort", () => resume(Effect.die(transaction.error)));
      });
      database.close();

      yield* Effect.gen(function* () {
        const targets = yield* (yield* Persistence.ConnectionTargetStore).list.pipe(Effect.flip);
        expect(targets.message).toContain("saved connections could not be read");
        const problem = yield* (yield* Persistence.ConnectionCatalogProblemStore).read;
        expect(Option.getOrThrow(problem).preservedKey).toMatch(/^catalog:unreadable:/);
      }).pipe(Effect.provide(ConnectionStorage.layer));

      const stored = yield* readCatalogTestValues();
      // The original value is still there and no empty catalog replaced it.
      expect(stored.document).toBe("{not-json");
      expect(
        Object.keys(stored).filter((key) => key.startsWith("catalog:unreadable:")),
      ).toHaveLength(1);
      yield* deleteCatalogTestDatabase();
    }).pipe(Effect.scoped),
  );
});
