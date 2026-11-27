/*
 * MIT License
 * Copyright (c) 2026 p0code
 * Ported from https://github.com/p0code/deploy-cloudflare (v0.3.0)
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Lightweight parser for wrangler.json, wrangler.jsonc, and wrangler.toml worker configs.
 * Extracts only the fields needed for multipart Workers script uploads:
 * main entrypoint, compatibility_date, compatibility_flags, vars, and resource bindings.
 */
export interface WorkerBinding {
  readonly name: string;
  readonly type: string;
  readonly text?: string;
  readonly namespace_id?: string;
  readonly id?: string;
  readonly bucket_name?: string;
  readonly service?: string;
  readonly environment?: string;
  readonly class_name?: string;
  readonly script_name?: string;
}

export interface ParsedWranglerConfig {
  readonly name?: string;
  readonly main?: string;
  readonly compatibilityDate?: string;
  readonly compatibilityFlags: ReadonlyArray<string>;
  readonly bindings: ReadonlyArray<WorkerBinding>;
  readonly routes: ReadonlyArray<string>;
}

const WranglerJsonShape = Schema.Record(Schema.String, Schema.Unknown);
const decodeJsonObject = Schema.decodeUnknownEffect(Schema.fromJsonString(WranglerJsonShape));

/** Strips // comments, /* block comments * /, and trailing commas for JSONC parsing. */
function stripJsonCommentsAndTrailingCommas(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let index = 0;
  while (index < input.length) {
    const ch = input[index]!;
    const next = input[index + 1];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      index += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      index += 2;
      while (index < input.length && input[index] !== "\n") index += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      index += 2;
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }
    out += ch;
    index += 1;
  }
  // Remove trailing commas before } or ] outside strings.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isSafeKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_OBJECT_KEYS.has(key);
}

function createNullRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function ownProp(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): Array<string> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function extractBindingsFromObject(obj: Record<string, unknown>): Array<WorkerBinding> {
  const bindings: Array<WorkerBinding> = [];

  const vars = asRecord(ownProp(obj, "vars"));
  if (vars) {
    for (const [key, val] of Object.entries(vars)) {
      if (!isSafeKey(key)) continue;
      if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
        bindings.push({ name: key, type: "plain_text", text: String(val) });
      }
    }
  }

  const kvNamespaces = ownProp(obj, "kv_namespaces");
  if (Array.isArray(kvNamespaces)) {
    for (const entry of kvNamespaces) {
      const rec = asRecord(entry);
      const name = rec ? asString(ownProp(rec, "binding")) : undefined;
      const namespaceId = rec ? asString(ownProp(rec, "id")) : undefined;
      if (name && namespaceId) {
        bindings.push({ name, type: "kv_namespace", namespace_id: namespaceId });
      }
    }
  }

  const d1Databases = ownProp(obj, "d1_databases");
  if (Array.isArray(d1Databases)) {
    for (const entry of d1Databases) {
      const rec = asRecord(entry);
      const name = rec ? asString(ownProp(rec, "binding")) : undefined;
      const id = rec ? asString(ownProp(rec, "database_id")) : undefined;
      if (name && id) {
        bindings.push({ name, type: "d1", id });
      }
    }
  }

  const r2Buckets = ownProp(obj, "r2_buckets");
  if (Array.isArray(r2Buckets)) {
    for (const entry of r2Buckets) {
      const rec = asRecord(entry);
      const name = rec ? asString(ownProp(rec, "binding")) : undefined;
      const bucketName = rec ? asString(ownProp(rec, "bucket_name")) : undefined;
      if (name && bucketName) {
        bindings.push({ name, type: "r2_bucket", bucket_name: bucketName });
      }
    }
  }

  const services = ownProp(obj, "services");
  if (Array.isArray(services)) {
    for (const entry of services) {
      const rec = asRecord(entry);
      const name = rec ? asString(ownProp(rec, "binding")) : undefined;
      const service = rec ? asString(ownProp(rec, "service")) : undefined;
      const environment = rec ? asString(ownProp(rec, "environment")) : undefined;
      if (name && service) {
        bindings.push({
          name,
          type: "service",
          service,
          ...(environment ? { environment } : {}),
        });
      }
    }
  }

  return bindings;
}

function extractRoutesFromObject(obj: Record<string, unknown>): Array<string> {
  const routes: Array<string> = [];
  const single = asString(ownProp(obj, "route"));
  if (single) routes.push(single);
  const rawRoutes = ownProp(obj, "routes");
  if (Array.isArray(rawRoutes)) {
    for (const entry of rawRoutes) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        routes.push(entry.trim());
      } else {
        const rec = asRecord(entry);
        const pattern = rec ? asString(ownProp(rec, "pattern")) : undefined;
        if (pattern) routes.push(pattern);
      }
    }
  }
  return routes;
}

function fromConfigRecord(raw: Record<string, unknown>, envName?: string): ParsedWranglerConfig {
  const envs = asRecord(ownProp(raw, "env"));
  const envSection =
    envName && isSafeKey(envName) && envs ? asRecord(ownProp(envs, envName)) : undefined;
  const merged: Record<string, unknown> = envSection
    ? Object.assign(createNullRecord(), raw, envSection)
    : raw;

  const baseBindings = extractBindingsFromObject(raw);
  const envBindings = envSection ? extractBindingsFromObject(envSection) : [];
  const bindingsByName = new Map<string, WorkerBinding>();
  for (const b of baseBindings) bindingsByName.set(b.name, b);
  for (const b of envBindings) bindingsByName.set(b.name, b);

  const name = asString(ownProp(merged, "name"));
  const main = asString(ownProp(merged, "main"));
  const compatibilityDate = asString(ownProp(merged, "compatibility_date"));
  const compatibilityFlags = asStringArray(ownProp(merged, "compatibility_flags"));
  const routes = extractRoutesFromObject(merged);

  return {
    ...(name ? { name } : {}),
    ...(main ? { main } : {}),
    ...(compatibilityDate ? { compatibilityDate } : {}),
    compatibilityFlags,
    bindings: [...bindingsByName.values()],
    routes,
  };
}

export const parseWranglerJsonc = Effect.fn("wranglerConfig.parseJsonc")(function* (
  content: string,
  envName?: string,
) {
  const cleaned = stripJsonCommentsAndTrailingCommas(content);
  const decoded = yield* decodeJsonObject(cleaned);
  return fromConfigRecord(decoded, envName);
});

function parseTomlValue(rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return inner.split(",").map((part) => parseTomlValue(part));
  }
  return trimmed;
}

function stripTomlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && line[i - 1] !== "\\") inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function ensureNestedObject(
  root: Record<string, unknown>,
  path: ReadonlyArray<string>,
): Record<string, unknown> | null {
  let current = root;
  for (const segment of path) {
    if (!isSafeKey(segment)) return null;
    const existing = asRecord(ownProp(current, segment));
    if (existing) {
      current = existing;
    } else {
      const next = createNullRecord();
      current[segment] = next;
      current = next;
    }
  }
  return current;
}

/**
 * Parses common wrangler.toml directives (top-level keys, [vars], [[kv_namespaces]],
 * [[d1_databases]], [[r2_buckets]], [[services]], [[routes]], and [env.<name>.*]).
 */
export function parseWranglerToml(content: string, envName?: string): ParsedWranglerConfig {
  const root = createNullRecord();
  let currentTable: Record<string, unknown> | null = root;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (line.length === 0) continue;

    if (line.startsWith("[[") && line.endsWith("]]")) {
      const segments = line
        .slice(2, -2)
        .trim()
        .split(".")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter((s) => s.length > 0);
      if (segments.length === 0 || !segments.every(isSafeKey)) {
        currentTable = null;
        continue;
      }
      const parent = ensureNestedObject(root, segments.slice(0, -1));
      if (parent === null) {
        currentTable = null;
        continue;
      }
      const leaf = segments[segments.length - 1]!;
      const existing = ownProp(parent, leaf);
      const list = Array.isArray(existing) ? (existing as Array<unknown>) : [];
      const item = createNullRecord();
      list.push(item);
      parent[leaf] = list;
      currentTable = item;
      continue;
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      const segments = line
        .slice(1, -1)
        .trim()
        .split(".")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter((s) => s.length > 0);
      if (segments.length === 0 || !segments.every(isSafeKey)) {
        currentTable = null;
        continue;
      }
      currentTable = ensureNestedObject(root, segments);
      continue;
    }

    if (currentTable === null) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = line
      .slice(0, eqIndex)
      .trim()
      .replace(/^["']|["']$/g, "");
    const value = parseTomlValue(line.slice(eqIndex + 1));
    if (isSafeKey(key)) {
      currentTable[key] = value;
    }
  }

  return fromConfigRecord(root, envName);
}
