import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { declarationsFor } from "./api.ts";
import { P0_NAMESPACES } from "./namespaces.ts";
import { hasNoRequiredFields, printType } from "./typescript.ts";

type Json = Record<string, unknown>;

/** Every property name a schema can produce, nested ones included. */
const fieldNames = (schema: Schema.Constraint): ReadonlySet<string> => {
  const names = new Set<string>();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (typeof node === "object" && node !== null) {
      const { properties, ...rest } = node as Json;
      if (typeof properties === "object" && properties !== null) {
        for (const [name, property] of Object.entries(properties)) {
          names.add(name);
          visit(property);
        }
      }
      Object.values(rest).forEach(visit);
    }
  };
  const document = Schema.toJsonSchemaDocument(schema);
  visit(document.schema);
  visit(document.definitions);
  return names;
};

it("prints a schema as the TypeScript an agent writes against", () => {
  const schema = Schema.Struct({
    name: Schema.String.annotate({ description: "Who." }),
    kind: Schema.Literals(["a", "b"]),
    count: Schema.optionalKey(Schema.Int),
    tags: Schema.Array(Schema.String),
    maybe: Schema.NullOr(Schema.Finite),
    items: Schema.Array(Schema.Struct({ id: Schema.String, on: Schema.Boolean })),
    flag: Schema.Literal(true),
  });
  expect(printType(schema)).toBe(`{
  /** Who. */
  name: string;
  kind: "a" | "b";
  count?: number;
  tags: string[];
  maybe: number | null;
  items: {
    id: string;
    on: boolean;
  }[];
  flag: true;
}`);
  expect(hasNoRequiredFields(Schema.Struct({ a: Schema.optionalKey(Schema.String) }))).toBe(true);
  expect(hasNoRequiredFields(schema)).toBe(false);
});

it("declares every method and every field of its input and output", () => {
  const text = declarationsFor(P0_NAMESPACES, "p0") ?? "";
  for (const namespace of P0_NAMESPACES) {
    expect(text).toContain(`declare namespace p0.${namespace.name} {`);
    for (const method of namespace.methods) {
      expect(text).toContain(`function ${method.name}(`);
      expect(text).toContain(`/** ${method.doc} */`);
      for (const name of [...fieldNames(method.input), ...fieldNames(method.output)]) {
        expect(text, `${namespace.name}.${method.name} field ${name}`).toMatch(
          new RegExp(`\\b${name}\\??:`),
        );
      }
    }
  }
});

it("answers a query with only the namespaces it is about", () => {
  for (const query of ["usage", "cost", "spend", "how much quota is left", "tokens"]) {
    expect(declarationsFor(P0_NAMESPACES, query), query).toContain("declare namespace p0.usage");
  }
  expect(declarationsFor(P0_NAMESPACES, "browser preview")).toBeUndefined();
  expect(declarationsFor(P0_NAMESPACES, "")).toContain("declare namespace p0.usage");
});

it("keeps the declarations compact", () => {
  expect((declarationsFor(P0_NAMESPACES, "usage") ?? "").length).toBeLessThan(3_500);
});
