#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A one-shot generator; synchronous Node APIs keep it small.
// Generates the native client's design tokens (`native/crates/p0-theme/src/generated.rs`) from the
// web app's sources: the built-in theme palettes, `apps/web/src/index.css`, and Tailwind's theme.
// `--check` fails when the checked-in file is stale.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { BUILT_IN_THEMES, DEFAULT_THEME_ID } from "../packages/shared/src/themePalettes.ts";

const root = NodePath.resolve(import.meta.dirname, "..");
export const OUTPUT = "native/crates/p0-theme/src/generated.rs";

// Channels are floats in 0..1 (sRGB, not linear) until the final rounding.

export type Rgba = { r: number; g: number; b: number; a: number };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const toLinear = (c: number) =>
  Math.abs(c) <= 0.04045 ? c / 12.92 : Math.sign(c) * ((Math.abs(c) + 0.055) / 1.055) ** 2.4;
const fromLinear = (c: number) =>
  Math.abs(c) <= 0.0031308 ? c * 12.92 : Math.sign(c) * (1.055 * Math.abs(c) ** (1 / 2.4) - 0.055);

type Lab = [number, number, number];

export function oklabToSrgb([L, a, b]: Lab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

export function srgbToOklab(r: number, g: number, b: number): Lab {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklch(L: number, C: number, H: number, alpha = 1): Rgba {
  const h = (H * Math.PI) / 180;
  const [r, g, b] = oklabToSrgb([L, C * Math.cos(h), C * Math.sin(h)]);
  return { r, g, b, a: alpha };
}

/** `#rrggbbaa`, each channel clipped to the sRGB gamut the way Chromium paints it. */
export function toHex(c: Rgba): string {
  const byte = (v: number) =>
    Math.round(clamp01(v) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(c.r)}${byte(c.g)}${byte(c.b)}${byte(c.a)}`;
}

type Space = "srgb" | "oklab" | "oklch";

/** CSS Color 5 `color-mix()`: premultiplied interpolation; percentages under 100% scale alpha. */
export function colorMix(
  space: Space,
  c1: Rgba,
  p1: number | null,
  c2: Rgba,
  p2: number | null,
): Rgba {
  let w1 = p1 ?? (p2 === null ? 0.5 : 1 - p2);
  let w2 = p2 ?? 1 - w1;
  const sum = w1 + w2;
  const scale = Math.min(1, sum);
  w1 /= sum;
  w2 /= sum;
  const a = c1.a * w1 + c2.a * w2;
  const coords = (c: Rgba): [number, number, number] => {
    if (space === "srgb") return [c.r, c.g, c.b];
    const lab = srgbToOklab(c.r, c.g, c.b);
    if (space === "oklab") return lab;
    const chroma = Math.hypot(lab[1], lab[2]);
    const hue = chroma < 1e-6 ? Number.NaN : (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
    return [lab[0], chroma, hue];
  };
  const x1 = coords(c1);
  const x2 = coords(c2);
  const mixed: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (space === "oklch" && i === 2) continue;
    const v1 = x1[i]! * c1.a;
    const v2 = x2[i]! * c2.a;
    mixed[i] = a === 0 ? 0 : (v1 * w1 + v2 * w2) / a;
  }
  if (space === "oklch") {
    let h1 = x1[2]!;
    let h2 = x2[2]!;
    if (Number.isNaN(h1)) h1 = h2;
    if (Number.isNaN(h2)) h2 = h1;
    if (Number.isNaN(h1)) {
      mixed[2] = 0;
    } else {
      if (h2 - h1 > 180) h1 += 360;
      else if (h2 - h1 < -180) h2 += 360;
      mixed[2] = h1 * w1 + h2 * w2;
    }
  }
  const out =
    space === "srgb"
      ? { r: mixed[0], g: mixed[1], b: mixed[2] }
      : (() => {
          const lab: Lab =
            space === "oklab"
              ? mixed
              : [
                  mixed[0],
                  mixed[1] * Math.cos((mixed[2] * Math.PI) / 180),
                  mixed[1] * Math.sin((mixed[2] * Math.PI) / 180),
                ];
          const [r, g, b] = oklabToSrgb(lab);
          return { r, g, b };
        })();
  return { ...out, a: a * scale };
}

// CSS: a brace-matching parser that keeps rule nesting (`@variant dark { ... }`) and resolves
// custom properties by textual `var()` substitution, the way computed values work.

export type Rule = { selector: string; decls: Map<string, string>; children: Rule[] };

export function parseCss(source: string): Rule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  const parseBlock = (): Rule[] & { decls?: Map<string, string> } => {
    const rules: Rule[] = [];
    const decls = new Map<string, string>();
    let buf = "";
    let depth = 0;
    while (i < css.length) {
      const ch = css[i++]!;
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (depth > 0) {
        buf += ch;
        continue;
      }
      if (ch === "{") {
        const selector = buf.trim().replace(/\s+/g, " ");
        buf = "";
        const children = parseBlock();
        rules.push({ selector, decls: children.decls!, children });
      } else if (ch === "}") {
        break;
      } else if (ch === ";") {
        addDecl(decls, buf);
        buf = "";
      } else {
        buf += ch;
      }
    }
    addDecl(decls, buf);
    return Object.assign(rules, { decls });
  };
  const top = parseBlock();
  return top;
}

function addDecl(decls: Map<string, string>, text: string) {
  const colon = text.indexOf(":");
  if (colon <= 0) return;
  const name = text.slice(0, colon).trim();
  if (!/^-{0,2}[a-z][\w-]*$/.test(name)) return;
  decls.set(
    name,
    text
      .slice(colon + 1)
      .trim()
      .replace(/\s+/g, " "),
  );
}

const rulesFor = (rules: Rule[], selector: string) => rules.filter((r) => r.selector === selector);
const variant = (rule: Rule, name: string) =>
  rule.children.filter((c) => c.selector === `@variant ${name}`);

type Scope = Map<string, string>;

function overlay(scope: Scope, decls: Map<string, string>): Scope {
  const next = new Map(scope);
  for (const [k, v] of decls) next.set(k, v);
  return next;
}

/** Matching close paren for the open paren at `open`. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    if (text[i] === ")" && --depth === 0) return i;
  }
  throw new Error(`unbalanced parens in ${text}`);
}

/** Top-level comma split. */
function splitArgs(text: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && (sep === " " ? /\s/.test(ch) : ch === sep)) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function substitute(value: string, scope: Scope, seen: string[] = []): string {
  let out = value;
  for (;;) {
    const at = out.indexOf("var(");
    if (at < 0) return out;
    const end = closeParen(out, at + 3);
    const [name, ...rest] = splitArgs(out.slice(at + 4, end));
    if (!name) throw new Error(`empty var() in ${value}`);
    if (seen.includes(name)) throw new Error(`cycle: ${[...seen, name].join(" -> ")}`);
    const raw = scope.get(name) ?? (rest.length > 0 ? rest.join(",") : undefined);
    if (raw === undefined) throw new Error(`undefined ${name} (via ${seen.join(" -> ")})`);
    out = out.slice(0, at) + substitute(raw, scope, [...seen, name]) + out.slice(end + 1);
  }
}

const NAMED: Record<string, Rgba> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  white: { r: 1, g: 1, b: 1, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
};

function number(token: string, percentScale = 1): number {
  if (token.endsWith("%")) return (Number.parseFloat(token) / 100) * percentScale;
  const n = Number(token);
  if (Number.isNaN(n)) throw new Error(`not a number: ${token}`);
  return n;
}

function alphaPart(args: string): [string, number] {
  const [body, alpha] = args.split("/").map((s) => s.trim());
  return [body!, alpha === undefined ? 1 : number(alpha)];
}

/** A fully substituted CSS color. */
export function parseColor(text: string, dark = false): Rgba {
  const t = text.trim();
  if (NAMED[t]) return NAMED[t];
  if (t.startsWith("#")) {
    let hex = t.slice(1);
    if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("");
    const n = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) : 1 };
  }
  const fn = /^(--alpha|[a-z-]+)\(/.exec(t);
  if (!fn || closeParen(t, fn[0].length - 1) !== t.length - 1) {
    throw new Error(`unsupported color: ${t}`);
  }
  const inner = t.slice(fn[0].length, -1);
  switch (fn[1]) {
    case "oklch": {
      const [body, alpha] = alphaPart(inner);
      const [L, C, H] = splitArgs(body, " ");
      return oklch(number(L!), number(C!, 0.4), number(H!), alpha);
    }
    case "rgb":
    case "rgba": {
      const [body, alpha] = alphaPart(inner.replaceAll(",", " "));
      const ch = splitArgs(body, " ");
      const c = (i: number) => number(ch[i]!, 255) / 255;
      return { r: c(0), g: c(1), b: c(2), a: ch[3] === undefined ? alpha : number(ch[3]) };
    }
    case "light-dark": {
      const [light, darkValue] = splitArgs(inner);
      return parseColor(dark ? darkValue! : light!, dark);
    }
    case "--alpha": {
      const [body, alpha] = alphaPart(inner);
      const c = parseColor(body, dark);
      return { ...c, a: c.a * alpha };
    }
    case "color-mix": {
      const [spaceArg, a, b] = splitArgs(inner);
      const space = /^in (srgb|oklab|oklch)$/.exec(spaceArg!)?.[1] as Space | undefined;
      if (!space) throw new Error(`unsupported color-mix space: ${spaceArg}`);
      const part = (arg: string): [Rgba, number | null] => {
        const tokens = splitArgs(arg, " ");
        const pct = tokens.findIndex((tok) => /^[\d.]+%$/.test(tok));
        if (pct < 0) return [parseColor(arg, dark), null];
        const p = number(tokens[pct]!);
        tokens.splice(pct, 1);
        return [parseColor(tokens.join(" "), dark), p];
      };
      const [c1, p1] = part(a!);
      const [c2, p2] = part(b!);
      return colorMix(space, c1, p1, c2, p2);
    }
    default:
      throw new Error(`unsupported color function: ${fn[1]}`);
  }
}

/** A length in px (`rem` at 16px, `calc(a / b)` for unitless ratios). */
export function parseLength(text: string): number {
  const t = text.trim();
  const calc = /^calc\(([\d.]+) \/ ([\d.]+)\)$/.exec(t);
  if (calc) return Number(calc[1]) / Number(calc[2]);
  if (t.endsWith("rem")) return Number.parseFloat(t) * 16;
  if (t.endsWith("px")) return Number.parseFloat(t);
  if (t === "0") return 0;
  return number(t);
}

const read = (file: string) => NodeFS.readFileSync(NodePath.join(root, file), "utf8");

const THEME_BLOCK = 'html[data-theme-id]:not([data-theme-id=""])';
const SIDEBAR = "[data-app-sidebar]";
const THEMED_SIDEBAR = "html[data-theme-id] [data-app-sidebar]";
const CONTRAST = ":root, [data-app-sidebar]";

type Variant = { app: Map<string, string>; sidebar: Map<string, string>; sidebarEdge: string };

export function buildTokens() {
  const tailwind = parseCss(read("apps/web/node_modules/tailwindcss/theme.css"));
  const web = parseCss(read("apps/web/src/index.css"));
  const appThemeVars = new Map(
    [...read("apps/web/src/themePalette.ts").matchAll(/^\s+(\w+): "(--app-theme-[\w-]+)",$/gm)].map(
      (m) => [m[1]!, m[2]!],
    ),
  );

  let base: Scope = new Map();
  for (const r of rulesFor(tailwind, "@theme default")) base = overlay(base, r.decls);
  const themeInline = rulesFor(web, "@theme inline")[0]!;
  for (const r of [...rulesFor(web, "@theme"), themeInline]) base = overlay(base, r.decls);

  const colorNames = [...themeInline.decls.keys()]
    .filter((k) => k.startsWith("--color-") && !/^--color-zinc-/.test(k))
    .map((k) => k.slice("--color-".length));

  const roots = rulesFor(web, ":root");
  const themed = rulesFor(web, THEME_BLOCK);
  const sidebarRules = rulesFor(web, SIDEBAR);
  const themedSidebar = rulesFor(web, THEMED_SIDEBAR);
  const contrast = rulesFor(web, CONTRAST);
  if (!themed.length || !sidebarRules.length || !themedSidebar.length || !contrast.length) {
    throw new Error("index.css no longer has the theme/sidebar blocks this generator reads");
  }

  const scopeFor = (dark: boolean, colors: Record<string, string>) => {
    // Specificity order: :root < :root dark < the theme block, which outranks both.
    let app = base;
    for (const r of roots) app = overlay(app, r.decls);
    if (dark)
      for (const r of roots) for (const v of variant(r, "dark")) app = overlay(app, v.decls);
    for (const r of themed) app = overlay(app, r.decls);
    for (const [role, value] of Object.entries(colors)) {
      const name = appThemeVars.get(role);
      if (!name) throw new Error(`no --app-theme variable for role ${role}`);
      app = overlay(app, new Map([[name, value]]));
    }
    for (const r of contrast) app = overlay(app, r.decls);
    // The sidebar element redeclares its palette; contrast tokens are recomputed there.
    let sidebar = app;
    // Each later layer is more specific than the one before, its dark variant included.
    for (const r of [...sidebarRules, ...themedSidebar]) {
      sidebar = overlay(sidebar, r.decls);
      if (dark) for (const v of variant(r, "dark")) sidebar = overlay(sidebar, v.decls);
    }
    for (const r of contrast) sidebar = overlay(sidebar, r.decls);
    return { app, sidebar };
  };

  const themes = BUILT_IN_THEMES.map((theme) => {
    const variants: Record<"light" | "dark", Variant> = {} as never;
    for (const mode of ["light", "dark"] as const) {
      const colors = mode === theme.appearance ? theme.colors : theme.variants?.[mode];
      if (!colors) throw new Error(`${theme.id} has no ${mode} variant`);
      const dark = mode === "dark";
      const { app, sidebar } = scopeFor(dark, colors);
      const evalColor = (expr: string, scope: Scope) =>
        toHex(parseColor(substitute(expr, scope), dark));
      const resolve = (scope: Scope) =>
        new Map(colorNames.map((n) => [n, evalColor(`var(--color-${n})`, scope)]));
      const edgeRule = themedSidebar.find((r) => r.decls.has("border-color"))!;
      const edge =
        mode === "dark"
          ? (variant(edgeRule, "dark")[0]?.decls.get("border-color") ??
            edgeRule.decls.get("border-color")!)
          : edgeRule.decls.get("border-color")!;
      variants[mode] = {
        app: resolve(app),
        sidebar: resolve(sidebar),
        sidebarEdge: evalColor(edge, sidebar),
      };
    }
    return { id: theme.id, label: theme.label, ...variants };
  });

  const rootVars = roots.reduce((s, r) => overlay(s, r.decls), base);
  const px = (name: string) => parseLength(substitute(`var(${name})`, rootVars));
  const textSizes = ["5xs", "4xs", "3xs", "2xs", "xs", "sm", "base", "lg", "xl", "2xl", "3xl"].map(
    (n) => ({
      name: n,
      size: px(`--text-${n}`),
      lineHeight: px(`--text-${n}--line-height`) * px(`--text-${n}`),
    }),
  );
  const radii = ["sm", "md", "lg", "xl", "2xl", "3xl"].map((n) => ({
    name: n,
    px: evalCalc(substitute(`var(--radius-${n})`, rootVars)),
  }));
  const fontStack = (name: string) =>
    splitArgs(substitute(`var(${name})`, base)).map((f) => f.replace(/^"(.*)"$/, "$1"));
  const geometry = [
    "--control-radius",
    "--sidebar-content-inset",
    "--sidebar-control-gap",
    "--sidebar-row-content-inset",
    "--command-shell-inset",
    "--command-content-inset",
    "--floating-content-inset",
    "--workspace-topbar-height",
    "--workspace-titlebar-control-size",
    "--workspace-titlebar-control-gap",
    "--chat-content-max-width",
    "--thread-details-panel-width",
    "--workspace-gutter",
    "--spacing",
  ].map((name) => ({ name, px: px(name) }));
  const shadows = [
    "--shadow-xs",
    "--shadow-sm",
    "--shadow-md",
    "--shadow-lg",
    "--shadow-composer",
    "--shadow-composer-dark",
  ].map((name) => ({ name, layers: parseShadow(substitute(`var(${name})`, rootVars)) }));
  const contracts = read("packages/contracts/src/settings.ts");
  const fontSize = (name: string) => {
    const m = new RegExp(`export const ${name}(?:: \\w+)? = (\\d+)`).exec(contracts);
    if (!m) throw new Error(`${name} not found in packages/contracts/src/settings.ts`);
    return Number(m[1]);
  };
  return {
    defaultThemeId: DEFAULT_THEME_ID,
    colorNames,
    themes,
    textSizes,
    radii,
    fonts: { sans: fontStack("--font-sans"), mono: fontStack("--font-mono") },
    fontSizes: {
      interface: fontSize("DEFAULT_INTERFACE_FONT_SIZE"),
      prompt: fontSize("DEFAULT_PROMPT_FONT_SIZE"),
      code: fontSize("DEFAULT_CODE_FONT_SIZE"),
    },
    geometry,
    shadows,
  };
}

/** `calc(0.5rem - 4px)`-style sums of lengths. */
function evalCalc(text: string): number {
  const inner = text.replace(/^calc\((.*)\)$/, "$1");
  const parts = inner.split(/\s+([+-])\s+/);
  let total = parseLength(parts[0]!);
  for (let i = 1; i < parts.length; i += 2) {
    const v = parseLength(parts[i + 1]!.replace(/^calc\((.*)\)$/, "$1"));
    total += parts[i] === "+" ? v : -v;
  }
  return total;
}

type ShadowLayer = { x: number; y: number; blur: number; spread: number; color: string };

function parseShadow(text: string): ShadowLayer[] {
  return splitArgs(text).map((layer) => {
    const tokens = splitArgs(layer, " ");
    const colorAt = tokens.findIndex((t) => /^(rgb|oklch|#|color-mix|--alpha)/.test(t));
    const color = toHex(parseColor(tokens[colorAt]!));
    const lengths = tokens.filter((_, i) => i !== colorAt).map(parseLength);
    const [x = 0, y = 0, blur = 0, spread = 0] = lengths;
    return { x, y, blur, spread, color };
  });
}

const snake = (name: string) => name.replaceAll("-", "_");
const hexLit = (hex: string) => `0x${hex.slice(1)}`;
const f32 = (n: number) => {
  const s = Number(n.toFixed(4)).toString();
  return s.includes(".") || s.includes("e") ? s : `${s}.0`;
};

export function renderRust(tokens: ReturnType<typeof buildTokens>): string {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);
  push("// @generated by `node scripts/native-theme.ts` from the web app's theme sources.");
  push(
    "// Do not edit; run `vp run native-theme:generate`. `vp run native-theme:check` fails when stale.",
  );
  push();
  push("/// Colors as `0xRRGGBBAA`, sRGB, resolved the way the web app computes them.");
  push("#[derive(Debug, Clone, Copy, PartialEq, Eq)]");
  push("pub struct Palette {");
  for (const n of tokens.colorNames) push(`    pub ${snake(n)}: u32,`);
  push("}");
  push();
  push("/// One appearance of a theme: the app canvas palette and the sidebar's own palette.");
  push("#[derive(Debug, Clone, Copy, PartialEq, Eq)]");
  push("pub struct ThemeVariant {");
  push("    pub app: Palette,");
  push("    pub sidebar: Palette,");
  push("    /// The sidebar's outer border (`border-color` on `[data-app-sidebar]`).");
  push("    pub sidebar_edge: u32,");
  push("}");
  push();
  push("#[derive(Debug, Clone, Copy, PartialEq, Eq)]");
  push("pub struct ThemeDef {");
  push("    pub id: &'static str,");
  push("    pub label: &'static str,");
  push("    pub light: ThemeVariant,");
  push("    pub dark: ThemeVariant,");
  push("}");
  push();
  push("#[derive(Debug, Clone, Copy, PartialEq)]");
  push("pub struct TextSize {");
  push("    pub size: f32,");
  push("    pub line_height: f32,");
  push("}");
  push();
  push("#[derive(Debug, Clone, Copy, PartialEq)]");
  push("pub struct ShadowLayer {");
  push("    pub x: f32,");
  push("    pub y: f32,");
  push("    pub blur: f32,");
  push("    pub spread: f32,");
  push("    pub color: u32,");
  push("}");
  push();
  push(`pub const DEFAULT_THEME_ID: &str = ${JSON.stringify(tokens.defaultThemeId)};`);
  push();
  const palette = (p: Map<string, string>, indent: string) => {
    push(`${indent}Palette {`);
    for (const [n, hex] of p) push(`${indent}    ${snake(n)}: ${hexLit(hex)},`);
    push(`${indent}},`);
  };
  push("pub const THEMES: &[ThemeDef] = &[");
  for (const t of tokens.themes) {
    push("    ThemeDef {");
    push(`        id: ${JSON.stringify(t.id)},`);
    push(`        label: ${JSON.stringify(t.label)},`);
    for (const mode of ["light", "dark"] as const) {
      const v = t[mode];
      push(`        ${mode}: ThemeVariant {`);
      push("            app:");
      palette(v.app, "            ");
      push("            sidebar:");
      palette(v.sidebar, "            ");
      push(`            sidebar_edge: ${hexLit(v.sidebarEdge)},`);
      push("        },");
    }
    push("    },");
  }
  push("];");
  push();
  push("/// Tailwind `text-*` sizes in px with their line heights in px.");
  for (const t of tokens.textSizes) {
    push(
      `pub const TEXT_${snake(t.name).toUpperCase().replace(/^(\d)/, "X$1")}: TextSize = TextSize { size: ${f32(t.size)}, line_height: ${f32(t.lineHeight)} };`,
    );
  }
  push();
  push("/// `rounded-*` radii in px.");
  for (const r of tokens.radii) {
    push(`pub const RADIUS_${r.name.toUpperCase().replace(/^(\d)/, "X$1")}: f32 = ${f32(r.px)};`);
  }
  push();
  push("/// Compact UI geometry from `:root` in `index.css`, in px.");
  for (const g of tokens.geometry) {
    push(`pub const ${snake(g.name.slice(2)).toUpperCase()}: f32 = ${f32(g.px)};`);
  }
  push();
  push("/// Font stacks in CSS order; the first family installed or bundled wins.");
  push(
    `pub const FONT_SANS: &[&str] = &[${tokens.fonts.sans.map((f) => JSON.stringify(f)).join(", ")}];`,
  );
  push(
    `pub const FONT_MONO: &[&str] = &[${tokens.fonts.mono.map((f) => JSON.stringify(f)).join(", ")}];`,
  );
  push(`pub const DEFAULT_INTERFACE_FONT_SIZE: f32 = ${f32(tokens.fontSizes.interface)};`);
  push(`pub const DEFAULT_PROMPT_FONT_SIZE: f32 = ${f32(tokens.fontSizes.prompt)};`);
  push(`pub const DEFAULT_CODE_FONT_SIZE: f32 = ${f32(tokens.fontSizes.code)};`);
  push();
  for (const s of tokens.shadows) {
    push(`pub const ${snake(s.name.slice(2)).toUpperCase()}: &[ShadowLayer] = &[`);
    for (const l of s.layers) {
      push(
        `    ShadowLayer { x: ${f32(l.x)}, y: ${f32(l.y)}, blur: ${f32(l.blur)}, spread: ${f32(l.spread)}, color: ${hexLit(l.color)} },`,
      );
    }
    push("];");
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const out = renderRust(buildTokens());
  const file = NodePath.join(root, OUTPUT);
  const current = NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : "";
  if (check) {
    if (current !== out) {
      console.error(`${OUTPUT} is stale; run \`vp run native-theme:generate\`.`);
      process.exit(1);
    }
  } else if (current !== out) {
    NodeFS.writeFileSync(file, out);
    console.log(`wrote ${OUTPUT}`);
  }
}
