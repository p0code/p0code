import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { defaultProjectsRoot, resolveProjectsRoot } from "./projectsRoot.ts";

const withPath = <A>(use: (path: Path.Path) => A) =>
  Effect.gen(function* () {
    return use(yield* Path.Path);
  }).pipe(Effect.provide(Path.layer));

it.effect("resolves the default under the T3 home when unset", () =>
  withPath((path) => {
    assert.equal(resolveProjectsRoot(null, "/t3", path, "/home/me"), "/t3/projects");
    assert.equal(resolveProjectsRoot("  ", "/t3", path, "/home/me"), "/t3/projects");
    assert.equal(defaultProjectsRoot("/t3", path), "/t3/projects");
  }),
);

it.effect("expands a home-relative folder", () =>
  withPath((path) => {
    assert.equal(resolveProjectsRoot("~/code", "/t3", path, "/home/me"), "/home/me/code");
    assert.equal(resolveProjectsRoot("~", "/t3", path, "/home/me"), "/home/me");
  }),
);

it.effect("rejects a relative folder", () =>
  withPath((path) => {
    assert.isNull(resolveProjectsRoot("code/projects", "/t3", path, "/home/me"));
  }),
);
