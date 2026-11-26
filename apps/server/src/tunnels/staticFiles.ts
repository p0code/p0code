// Native filesystem descriptors and fstat identity checks are required for TOCTOU-safe serving.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import type * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as Mime from "effect/http/Mime";
import * as Option from "effect/Option";
import { hostPreviewMimeTypeFromExtension } from "@t3tools/shared/filePreview";

export interface StaticFileIdentity {
  readonly dev: string;
  readonly ino: string;
}

export interface StaticDeniedRoots {
  readonly stateDir: string;
  readonly secretsDir: string;
  readonly homeDir: string;
}

const SANDBOXED_SINGLE_FILE_EXTENSIONS = new Set([".html", ".htm", ".svg", ".xhtml"]);
const INLINE_SAFE_MIME_FALLBACKS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
};

function isWithinDirectory(candidate: string, directory: string): boolean {
  const normalizedDir = directory.endsWith(NodePath.sep)
    ? directory.slice(0, -NodePath.sep.length) || NodePath.sep
    : directory;
  if (normalizedDir === NodePath.sep) return candidate.startsWith(NodePath.sep);
  return candidate === normalizedDir || candidate.startsWith(`${normalizedDir}${NodePath.sep}`);
}

async function resolveRealOrNormalized(targetPath: string): Promise<string> {
  const resolved = NodePath.resolve(targetPath);
  try {
    return await NodeFSP.realpath(resolved);
  } catch {
    return resolved;
  }
}

export async function isDeniedPublicTunnelPath(
  candidatePath: string,
  roots: StaticDeniedRoots,
): Promise<boolean> {
  const resolvedCandidate = NodePath.resolve(candidatePath);
  const realCandidate = await resolveRealOrNormalized(resolvedCandidate);
  const resolvedHome = NodePath.resolve(roots.homeDir);
  const realHome = await resolveRealOrNormalized(resolvedHome);

  const deniedTreesRaw = [
    roots.stateDir,
    roots.secretsDir,
    NodePath.join(resolvedHome, ".p0code"),
    NodePath.join(resolvedHome, ".t3"),
    NodePath.join(resolvedHome, ".ssh"),
    NodePath.join(resolvedHome, ".aws"),
    NodePath.join(resolvedHome, ".config", "gcloud"),
    NodePath.join(resolvedHome, ".gnupg"),
  ];
  const deniedTrees = await Promise.all(
    deniedTreesRaw.flatMap((entry) => [
      Promise.resolve(NodePath.resolve(entry)),
      resolveRealOrNormalized(entry),
    ]),
  );

  for (const checkPath of [resolvedCandidate, realCandidate]) {
    const fsRoot = NodePath.parse(checkPath).root;
    if (checkPath === fsRoot) return true;
    if (checkPath === resolvedHome || checkPath === realHome) return true;
    if (deniedTrees.some((tree) => isWithinDirectory(checkPath, tree))) return true;
  }
  return false;
}

export async function validateStaticTarget(
  target:
    | { readonly kind: "file"; readonly path: string }
    | { readonly kind: "folder"; readonly path: string },
  roots: StaticDeniedRoots,
): Promise<
  | { readonly ok: true; readonly canonicalPath: string; readonly identity?: StaticFileIdentity }
  | { readonly ok: false; readonly reason: "denied" | "invalid"; readonly message: string }
> {
  if (await isDeniedPublicTunnelPath(target.path, roots)) {
    return {
      ok: false,
      reason: "denied",
      message: "Refusing to publish a protected or system directory.",
    };
  }
  let canonicalPath: string;
  try {
    canonicalPath = await NodeFSP.realpath(NodePath.resolve(target.path));
  } catch {
    return { ok: false, reason: "invalid", message: "Target path does not exist." };
  }
  if (await isDeniedPublicTunnelPath(canonicalPath, roots)) {
    return {
      ok: false,
      reason: "denied",
      message: "Refusing to publish a protected or system directory.",
    };
  }
  let stat: NodeFS.Stats;
  try {
    stat = await NodeFSP.lstat(canonicalPath);
  } catch {
    return { ok: false, reason: "invalid", message: "Target path cannot be inspected." };
  }
  if (target.kind === "file") {
    if (!stat.isFile()) {
      return { ok: false, reason: "invalid", message: "Target path must be a regular file." };
    }
    return {
      ok: true,
      canonicalPath,
      identity: { dev: String(stat.dev), ino: String(stat.ino) },
    };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: "invalid", message: "Target path must be a directory." };
  }
  return { ok: true, canonicalPath };
}

function resolveMimeType(filePath: string): {
  readonly contentType: string;
  readonly known: boolean;
} {
  const ext = NodePath.extname(filePath).toLowerCase();
  const fromInline = INLINE_SAFE_MIME_FALLBACKS[ext];
  if (fromInline !== undefined) {
    return { contentType: fromInline, known: true };
  }
  const fromEffectMime = Option.getOrUndefined(Mime.getType(filePath));
  if (fromEffectMime !== undefined) {
    return {
      contentType: fromEffectMime === "text/html" ? "text/html; charset=utf-8" : fromEffectMime,
      known: true,
    };
  }
  const fromPreview = ext ? hostPreviewMimeTypeFromExtension(ext) : null;
  if (fromPreview !== null) {
    return { contentType: fromPreview, known: true };
  }
  return { contentType: "application/octet-stream", known: false };
}

function safeAttachmentDisposition(fileName: string): string {
  const clean = fileName.replaceAll(/["\r\n\\/]/g, "_");
  return `attachment; filename="${clean}"`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function validateStaticSubpath(
  rawSubpath: string,
):
  | { readonly ok: true; readonly segments: ReadonlyArray<string> }
  | { readonly ok: false; readonly status: 400 | 403 } {
  if (rawSubpath.includes("\0") || rawSubpath.includes("\\") || /%00|%2f|%5c/i.test(rawSubpath)) {
    return { ok: false, status: 400 };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawSubpath);
  } catch {
    return { ok: false, status: 400 };
  }
  if (decoded.includes("\0") || decoded.includes("\\") || /%(?:00|2e|2f|5c)/i.test(decoded)) {
    return { ok: false, status: 400 };
  }
  const rawSegments = decoded.split("/");
  const segments: string[] = [];
  for (const segment of rawSegments) {
    if (segment === "") continue;
    if (segment === "." || segment === ".." || segment.startsWith(".")) {
      return { ok: false, status: 403 };
    }
    segments.push(segment);
  }
  return { ok: true, segments };
}

const BASE_STATIC_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "cache-control": "no-cache",
} as const;

function sendStaticError(
  response: NodeHttp.ServerResponse,
  status: number,
  message: string,
  extraHeaders?: Record<string, string>,
): { readonly status: number; readonly bytesOut: number } {
  const body = Buffer.from(message, "utf8");
  response.writeHead(status, {
    ...BASE_STATIC_HEADERS,
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(body.length),
    ...extraHeaders,
  });
  if (response.req?.method === "HEAD") {
    response.end();
    return { status, bytesOut: 0 };
  }
  response.end(body);
  return { status, bytesOut: body.length };
}

function parseRangeHeader(
  rangeHeader: string | undefined,
  size: number,
):
  | { readonly kind: "none" }
  | { readonly kind: "invalid" }
  | { readonly kind: "single"; readonly start: number; readonly end: number } {
  if (!rangeHeader) return { kind: "none" };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) return { kind: "invalid" };
  const startRaw = match[1];
  const endRaw = match[2];
  if (!startRaw && !endRaw) return { kind: "invalid" };
  if (size === 0) return { kind: "invalid" };
  if (!startRaw && endRaw) {
    const suffixLength = Number(endRaw);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { kind: "invalid" };
    const start = Math.max(0, size - suffixLength);
    return { kind: "single", start, end: size - 1 };
  }
  const start = Number(startRaw);
  const end = endRaw ? Math.min(size - 1, Number(endRaw)) : size - 1;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    start > end ||
    start >= size
  ) {
    return { kind: "invalid" };
  }
  return { kind: "single", start, end };
}

async function serveOpenFile(options: {
  readonly request: NodeHttp.IncomingMessage;
  readonly response: NodeHttp.ServerResponse;
  readonly fileHandle: NodeFSP.FileHandle;
  readonly filePath: string;
  readonly stat: NodeFS.Stats;
  readonly sandboxHtmlSvg: boolean;
}): Promise<{ readonly status: number; readonly bytesOut: number }> {
  const { request, response, fileHandle, filePath, stat } = options;
  const size = stat.size;
  const mtimeMs = Math.floor(stat.mtimeMs);
  const etag = `W/"${size.toString(16)}-${mtimeMs.toString(16)}"`;
  // @effect-diagnostics-next-line globalDate:off -- HTTP Last-Modified requires RFC 1123 UTC date string from fs mtimeMs.
  const lastModified = new Date(mtimeMs).toUTCString();
  const { contentType, known } = resolveMimeType(filePath);
  const ext = NodePath.extname(filePath).toLowerCase();
  const headers: Record<string, string> = {
    ...BASE_STATIC_HEADERS,
    "content-type": contentType,
    etag,
    "last-modified": lastModified,
    "accept-ranges": "bytes",
    ...(known
      ? {}
      : { "content-disposition": safeAttachmentDisposition(NodePath.basename(filePath)) }),
    ...(options.sandboxHtmlSvg &&
    (SANDBOXED_SINGLE_FILE_EXTENSIONS.has(ext) ||
      contentType.startsWith("text/html") ||
      contentType === "image/svg+xml")
      ? { "content-security-policy": "sandbox" }
      : {}),
  };

  const ifNoneMatch = request.headers["if-none-match"];
  if (
    typeof ifNoneMatch === "string" &&
    ifNoneMatch
      .split(",")
      .map((s) => s.trim())
      .includes(etag)
  ) {
    await fileHandle.close();
    response.writeHead(304, headers);
    response.end();
    return { status: 304, bytesOut: 0 };
  }
  const ifModifiedSince = request.headers["if-modified-since"];
  if (typeof ifModifiedSince === "string" && !ifNoneMatch) {
    const parsedSince = Date.parse(ifModifiedSince);
    if (!Number.isNaN(parsedSince) && mtimeMs <= parsedSince + 999) {
      await fileHandle.close();
      response.writeHead(304, headers);
      response.end();
      return { status: 304, bytesOut: 0 };
    }
  }

  const range = parseRangeHeader(request.headers.range, size);
  if (range.kind === "invalid") {
    await fileHandle.close();
    return sendStaticError(response, 416, "Range Not Satisfiable", {
      "content-range": `bytes */${size}`,
    });
  }

  const status = range.kind === "single" ? 206 : 200;
  const start = range.kind === "single" ? range.start : 0;
  const end = range.kind === "single" ? range.end : Math.max(0, size - 1);
  const length = size === 0 ? 0 : end - start + 1;
  if (range.kind === "single") {
    headers["content-range"] = `bytes ${start}-${end}/${size}`;
  }
  headers["content-length"] = String(length);
  response.writeHead(status, headers);

  if (request.method === "HEAD" || length === 0) {
    await fileHandle.close();
    response.end();
    return { status, bytesOut: 0 };
  }

  return new Promise((resolve) => {
    let bytesOut = 0;
    const stream = fileHandle.createReadStream({ start, end });
    const cleanup = () => {
      stream.destroy();
      void fileHandle.close().catch(() => {});
    };
    stream.on("data", (chunk: string | Buffer) => {
      bytesOut += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    });
    stream.once("end", () => {
      void fileHandle.close().catch(() => {});
      resolve({ status, bytesOut });
    });
    stream.once("error", () => {
      cleanup();
      if (!response.headersSent) response.writeHead(500);
      response.end();
      resolve({ status: 500, bytesOut });
    });
    response.once("close", cleanup);
    stream.pipe(response);
  });
}

async function openRegularFileWithinRoot(
  candidatePath: string,
  expectedRoot: string,
  expectedDev: number | bigint,
): Promise<{ readonly handle: NodeFSP.FileHandle; readonly stat: NodeFS.Stats } | null> {
  let canonical: string;
  try {
    canonical = await NodeFSP.realpath(candidatePath);
  } catch {
    return null;
  }
  if (canonical !== expectedRoot && !canonical.startsWith(`${expectedRoot}${NodePath.sep}`)) {
    return null;
  }
  const relative = NodePath.relative(expectedRoot, canonical);
  if (relative.split(NodePath.sep).some((segment) => segment.startsWith("."))) {
    return null;
  }
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(canonical, NodeFS.constants.O_RDONLY);
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== expectedDev) {
      await handle.close();
      return null;
    }
    return { handle, stat };
  } catch {
    await handle.close().catch(() => {});
    return null;
  }
}

export async function serveStaticTunnelRequest(options: {
  readonly request: NodeHttp.IncomingMessage;
  readonly response: NodeHttp.ServerResponse;
  readonly target:
    | { readonly kind: "file"; readonly path: string; readonly runAsPage?: boolean }
    | {
        readonly kind: "folder";
        readonly path: string;
        readonly listing: boolean;
        readonly spa: boolean;
      };
  readonly rawSubpath: string;
  readonly pinnedIdentity?: StaticFileIdentity;
}): Promise<{ readonly status: number; readonly bytesOut: number }> {
  const { request, response, target, rawSubpath } = options;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return sendStaticError(response, 405, "Method Not Allowed", { allow: "GET, HEAD" });
  }

  const parsedSubpath = validateStaticSubpath(rawSubpath);
  if (!parsedSubpath.ok) {
    return sendStaticError(
      response,
      parsedSubpath.status,
      parsedSubpath.status === 400 ? "Bad Request" : "Forbidden",
    );
  }

  if (target.kind === "file") {
    if (parsedSubpath.segments.length > 0) {
      return sendStaticError(response, 404, "Not Found");
    }
    let resolvedFile: string;
    try {
      resolvedFile = await NodeFSP.realpath(target.path);
    } catch {
      return sendStaticError(response, 410, "Gone");
    }
    if (resolvedFile !== target.path) {
      return sendStaticError(response, 410, "Gone");
    }
    let handle: NodeFSP.FileHandle;
    try {
      handle = await NodeFSP.open(resolvedFile, NodeFS.constants.O_RDONLY);
    } catch {
      return sendStaticError(response, 410, "Gone");
    }
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        (options.pinnedIdentity !== undefined &&
          (String(stat.dev) !== options.pinnedIdentity.dev ||
            String(stat.ino) !== options.pinnedIdentity.ino))
      ) {
        await handle.close();
        return sendStaticError(response, 410, "Gone");
      }
      return await serveOpenFile({
        request,
        response,
        fileHandle: handle,
        filePath: resolvedFile,
        stat,
        sandboxHtmlSvg: target.runAsPage !== true,
      });
    } catch {
      await handle.close().catch(() => {});
      return sendStaticError(response, 410, "Gone");
    }
  }

  // Folder mode: re-verify root realpath per request to refuse swapped roots while allowing rebuilds.
  let resolvedRoot: string;
  let rootStat: NodeFS.Stats;
  try {
    resolvedRoot = await NodeFSP.realpath(target.path);
    rootStat = await NodeFSP.stat(resolvedRoot);
  } catch {
    return sendStaticError(response, 410, "Gone");
  }
  if (resolvedRoot !== target.path || !rootStat.isDirectory()) {
    return sendStaticError(response, 410, "Gone");
  }

  const joined =
    parsedSubpath.segments.length === 0
      ? resolvedRoot
      : NodePath.join(resolvedRoot, ...parsedSubpath.segments);

  let canonicalTarget: string | null = null;
  try {
    canonicalTarget = await NodeFSP.realpath(joined);
  } catch {
    canonicalTarget = null;
  }

  if (canonicalTarget === null) {
    if (target.spa) {
      const fallback = await openRegularFileWithinRoot(
        NodePath.join(resolvedRoot, "index.html"),
        resolvedRoot,
        rootStat.dev,
      );
      if (fallback) {
        return await serveOpenFile({
          request,
          response,
          fileHandle: fallback.handle,
          filePath: NodePath.join(resolvedRoot, "index.html"),
          stat: fallback.stat,
          sandboxHtmlSvg: false,
        });
      }
    }
    return sendStaticError(response, 404, "Not Found");
  }

  if (
    canonicalTarget !== resolvedRoot &&
    !canonicalTarget.startsWith(`${resolvedRoot}${NodePath.sep}`)
  ) {
    return sendStaticError(response, 403, "Forbidden");
  }
  const relativeTarget = NodePath.relative(resolvedRoot, canonicalTarget);
  if (
    relativeTarget !== "" &&
    relativeTarget.split(NodePath.sep).some((segment) => segment.startsWith("."))
  ) {
    return sendStaticError(response, 403, "Forbidden");
  }

  let targetStat: NodeFS.Stats;
  try {
    targetStat = await NodeFSP.stat(canonicalTarget);
  } catch {
    return sendStaticError(response, 404, "Not Found");
  }

  if (targetStat.isDirectory()) {
    const indexPath = NodePath.join(canonicalTarget, "index.html");
    const indexFile = await openRegularFileWithinRoot(indexPath, resolvedRoot, rootStat.dev);
    if (indexFile) {
      return await serveOpenFile({
        request,
        response,
        fileHandle: indexFile.handle,
        filePath: indexPath,
        stat: indexFile.stat,
        sandboxHtmlSvg: false,
      });
    }
    if (target.listing) {
      const entries = await NodeFSP.readdir(canonicalTarget, { withFileTypes: true }).catch(
        () => [],
      );
      const visible = entries
        .filter((entry) => !entry.name.startsWith("."))
        .toSorted((left, right) => left.name.localeCompare(right.name));
      const baseTitle =
        parsedSubpath.segments.length === 0 ? "/" : `/${parsedSubpath.segments.join("/")}/`;
      const items = visible
        .map((entry) => {
          const suffix = entry.isDirectory() ? "/" : "";
          const name = `${entry.name}${suffix}`;
          const href = encodeURIComponent(entry.name) + suffix;
          return `<li><a href="${escapeHtml(href)}">${escapeHtml(name)}</a></li>`;
        })
        .join("");
      const html = Buffer.from(
        `<!doctype html><html><head><meta charset="utf-8"><title>Index of ${escapeHtml(baseTitle)}</title></head><body><h1>Index of ${escapeHtml(baseTitle)}</h1><ul>${items}</ul></body></html>`,
        "utf8",
      );
      response.writeHead(200, {
        ...BASE_STATIC_HEADERS,
        "content-type": "text/html; charset=utf-8",
        "content-length": String(html.length),
      });
      if (request.method === "HEAD") {
        response.end();
        return { status: 200, bytesOut: 0 };
      }
      response.end(html);
      return { status: 200, bytesOut: html.length };
    }
    if (target.spa && parsedSubpath.segments.length > 0) {
      const fallback = await openRegularFileWithinRoot(
        NodePath.join(resolvedRoot, "index.html"),
        resolvedRoot,
        rootStat.dev,
      );
      if (fallback) {
        return await serveOpenFile({
          request,
          response,
          fileHandle: fallback.handle,
          filePath: NodePath.join(resolvedRoot, "index.html"),
          stat: fallback.stat,
          sandboxHtmlSvg: false,
        });
      }
    }
    return sendStaticError(response, 404, "Not Found");
  }

  if (!targetStat.isFile()) {
    return sendStaticError(response, 404, "Not Found");
  }

  const opened = await openRegularFileWithinRoot(canonicalTarget, resolvedRoot, rootStat.dev);
  if (!opened) {
    return sendStaticError(response, 403, "Forbidden");
  }
  return await serveOpenFile({
    request,
    response,
    fileHandle: opened.handle,
    filePath: canonicalTarget,
    stat: opened.stat,
    sandboxHtmlSvg: false,
  });
}
