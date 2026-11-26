import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { hasNoFields, hasNoRequiredFields, printDoc, printType } from "./typescript.ts";

/** A failure the snippet can read and handle; `detail` never carries raw provider or SQL text. */
export class P0ApiError extends Schema.TaggedError<P0ApiError>()("P0ApiError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface P0Method<R> {
  readonly name: string;
  readonly doc: string;
  /** `write` methods change the environment, so `p0_code` checks the caller may act first. */
  readonly access: "read" | "write";
  readonly input: Schema.Constraint;
  readonly output: Schema.Constraint;
  /** Decodes the snippet's argument, then runs; the result is plain JSON-able data. */
  readonly run: (raw: unknown) => Effect.Effect<unknown, P0ApiError, R>;
}

export interface P0Namespace<R> {
  readonly name: string;
  readonly doc: string;
  readonly methods: ReadonlyArray<P0Method<R>>;
}

const decodeOptions = (schema: Schema.Codec<unknown, unknown>, raw: unknown) => {
  const options: unknown = raw ?? {};
  return Schema.decodeUnknownEffect(schema)(options);
};

/**
 * One `p0.<namespace>.<name>(options)` function. The schemas are the single source of its
 * decoding and of the TypeScript declarations agents read, so the two cannot drift.
 */
export const method = <I extends Schema.Codec<unknown, unknown>, O extends Schema.Constraint, R>(
  namespace: string,
  definition: {
    readonly name: string;
    readonly doc: string;
    readonly access?: "read" | "write";
    readonly input: I;
    readonly output: O;
    readonly run: (input: I["Type"]) => Effect.Effect<O["Type"], P0ApiError, R>;
  },
): P0Method<R> => ({
  name: definition.name,
  doc: definition.doc,
  access: definition.access ?? "read",
  input: definition.input,
  output: definition.output,
  run: (raw) =>
    decodeOptions(definition.input, raw).pipe(
      Effect.mapError(
        (cause) =>
          new P0ApiError({
            detail: `Invalid options for p0.${namespace}.${definition.name}: ${cause.message.slice(0, 300)}`,
            cause,
          }),
      ),
      Effect.flatMap(definition.run),
    ),
});

/** Paths a snippet may call, such as `usage.limits`. */
export const methodPaths = <R>(namespaces: ReadonlyArray<P0Namespace<R>>) =>
  namespaces.flatMap(({ name, methods }) => methods.map((entry) => `${name}.${entry.name}`));

export const findMethod = <R>(namespaces: ReadonlyArray<P0Namespace<R>>, path: string) => {
  const [namespace, name] = path.split(".");
  return namespaces
    .find((candidate) => candidate.name === namespace)
    ?.methods.find((entry) => entry.name === name);
};

const declareNamespace = <R>({ name, doc, methods }: P0Namespace<R>) => {
  const docs = new Set<string>();
  const functions = methods.map((entry) => {
    const options = hasNoFields(entry.input)
      ? ""
      : `options${hasNoRequiredFields(entry.input) ? "?" : ""}: ${printType(entry.input, "  ", docs)}`;
    return `${printDoc(entry.doc, "  ")}  function ${entry.name}(${options}): Promise<${printType(entry.output, "  ", docs)}>;`;
  });
  return `// p0.${name}: ${doc}\ndeclare namespace p0.${name} {\n${functions.join("\n")}\n}`;
};

const GENERAL_TERMS = new Set(["p0", "api", "p0_code", "code", "script", "sandbox"]);

/**
 * TypeScript declarations for the namespaces a query is about, or all of them when it asks for
 * the API in general. Matches names and docs, not field names, so a stray word like "thread"
 * does not pull in every namespace that happens to mention one.
 */
export const declarationsFor = <R>(
  namespaces: ReadonlyArray<P0Namespace<R>>,
  query: string,
): string | undefined => {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .filter(Boolean);
  const wantsAll = terms.length === 0 || terms.some((term) => GENERAL_TERMS.has(term));
  const matching = namespaces.filter((namespace) => {
    if (wantsAll) return true;
    const words = [
      namespace.name,
      namespace.doc,
      ...namespace.methods.flatMap((entry) => [entry.name, entry.doc]),
    ]
      .join(" ")
      .toLowerCase();
    return terms.some((term) => words.includes(term) || words.includes(term.replace(/s$/, "")));
  });
  return matching.length === 0 ? undefined : matching.map(declareNamespace).join("\n\n");
};
