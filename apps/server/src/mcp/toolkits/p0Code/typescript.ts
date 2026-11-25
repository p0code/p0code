import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

type Json = Record<string, unknown>;

const isJson = (value: unknown): value is Json => Predicate.isObject(value);

const literal = (value: unknown) => JSON.stringify(value);

export const printDoc = (text: string, indent: string) =>
  `${indent}/** ${text.replaceAll("*/", "* /")} */\n`;

interface Printing {
  readonly definitions: Json;
  /** Descriptions already printed once; a field repeated across shapes keeps only its first. */
  readonly docs: Set<string>;
}

const printNode = (
  node: unknown,
  printing: Printing,
  indent: string,
  resolving: ReadonlySet<string>,
): string => {
  if (!isJson(node)) return "unknown";
  if (typeof node.$ref === "string") {
    const name = node.$ref.replace(/^#\/\$defs\//, "");
    const target = printing.definitions[name];
    if (target === undefined || resolving.has(name)) return "unknown";
    return printNode(target, printing, indent, new Set([...resolving, name]));
  }
  if (Array.isArray(node.enum)) return node.enum.map(literal).join(" | ");
  if ("const" in node) return literal(node.const);
  if (Array.isArray(node.anyOf)) {
    return [
      ...new Set(node.anyOf.map((branch) => printNode(branch, printing, indent, resolving))),
    ].join(" | ");
  }
  switch (node.type) {
    case "string":
    case "boolean":
    case "null":
      return node.type;
    case "number":
    case "integer":
      return "number";
    case "array": {
      const item = printNode(node.items, printing, indent, resolving);
      return item.includes(" | ") ? `Array<${item}>` : `${item}[]`;
    }
    case "object": {
      const properties = isJson(node.properties) ? node.properties : {};
      const required = new Set(Array.isArray(node.required) ? node.required : []);
      const inner = `${indent}  `;
      const lines = Object.entries(properties).map(([name, property]) => {
        const description = isJson(property) ? property.description : undefined;
        const doc =
          typeof description === "string" && !printing.docs.has(description)
            ? printDoc(description, inner)
            : "";
        if (typeof description === "string") printing.docs.add(description);
        const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : literal(name);
        return `${doc}${inner}${key}${required.has(name) ? "" : "?"}: ${printNode(property, printing, inner, resolving)};\n`;
      });
      return lines.length === 0 ? "{}" : `{\n${lines.join("")}${indent}}`;
    }
    default:
      return "unknown";
  }
};

/**
 * The TypeScript type of what `schema` decodes from JSON. Pass the same `docs` set to several
 * calls that print into one declaration so a description repeats only once.
 */
export const printType = (
  schema: Schema.Constraint,
  indent = "",
  docs: Set<string> = new Set(),
): string => {
  const document = Schema.toJsonSchemaDocument(schema);
  return printNode(document.schema, { definitions: document.definitions, docs }, indent, new Set());
};

const objectShape = (schema: Schema.Constraint) => {
  const { properties, required } = Schema.toJsonSchemaDocument(schema).schema as Json;
  return {
    fields: isJson(properties) ? Object.keys(properties).length : 0,
    required: Array.isArray(required) ? required.length : 0,
  };
};

/** Whether an object schema takes no fields at all, so the function takes no argument. */
export const hasNoFields = (schema: Schema.Constraint): boolean => objectShape(schema).fields === 0;

/** Whether every field of an object schema may be left out, so the argument can be too. */
export const hasNoRequiredFields = (schema: Schema.Constraint): boolean =>
  objectShape(schema).required === 0;
