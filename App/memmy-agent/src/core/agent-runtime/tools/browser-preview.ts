import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { contentType, lookup } from "mime-types";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import postcss from "postcss";
import ts from "typescript";
import { getMediaDir } from "../../../config/paths.js";
import { BUILTIN_SKILLS_DIR } from "../skills.js";
import { isBlockedDevicePath } from "./filesystem.js";
import { isPathInside } from "./path-utils.js";
import { validateUrl } from "./web.js";

const PREVIEW_MAX_FILES = 512;
const PREVIEW_MAX_BYTES = 256 * 1024 * 1024;
const PREVIEW_HOST = "127.0.0.1";
const PREVIEW_ORIGIN = `http://${PREVIEW_HOST}`;
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const JAVASCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const RESOURCE_LINK_RELS = new Set([
  "stylesheet",
  "icon",
  "preload",
  "modulepreload",
  "manifest",
]);

export type BrowserNavigateTarget =
  | { kind: "url"; url: string }
  | { kind: "path"; path: string };

export type BrowserPreviewLease = {
  url: string;
  close: () => Promise<void>;
};

type PreviewOptions = {
  workspace: string;
  restrictLocalFiles: boolean;
  readonlyRoots?: readonly string[];
};

type ValidatedFile = {
  path: string;
  size: number;
};

type StagedFile = {
  path: string;
  contentType: string;
};

type PendingFile = {
  sourcePath: string;
  stagedPath: string;
  publicPath: string;
};

type ReferenceContext = {
  sourceBaseDir: string;
  sourceRoot: string;
  publicBaseUrl: URL;
};

type ResolvedReference =
  | { kind: "external" }
  | { kind: "local"; sourcePath: string; publicPath: string };

type HtmlNode = DefaultTreeAdapterTypes.Node;
type HtmlElement = DefaultTreeAdapterTypes.Element;

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function hasExplicitScheme(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function htmlExtension(value: string): boolean {
  return HTML_EXTENSIONS.has(path.extname(value).toLowerCase());
}

export function classifyBrowserNavigateTarget(value: string): BrowserNavigateTarget {
  if (!value) {
    throw new Error("invalid browser URL: URL cannot be empty");
  }
  const windowsPath = isWindowsAbsolutePath(value);
  if (!windowsPath && /^https?:/i.test(value)) {
    const [valid, error] = validateUrl(value);
    if (!valid) throw new Error(`invalid browser URL: ${error}`);
    return { kind: "url", url: value };
  }
  if (!windowsPath && hasExplicitScheme(value)) {
    if (/^file:/i.test(value)) {
      throw new Error("invalid browser URL: file:// is disabled; pass the local .html or .htm path instead");
    }
    throw new Error("invalid browser URL: only HTTP/HTTPS URLs and local .html/.htm paths are supported");
  }
  const pathCandidate = windowsPath
    || path.isAbsolute(value)
    || value.startsWith("./")
    || value.startsWith("../")
    || htmlExtension(value);
  if (pathCandidate) {
    if (value.includes("?") || value.includes("#")) {
      throw new Error("invalid local HTML path: query and fragment are not supported");
    }
    if (value === "~" || value.startsWith("~/")) {
      throw new Error("invalid local HTML path: shell home expansion is not supported");
    }
    if (!htmlExtension(value)) {
      throw new Error("invalid local HTML path: expected a .html or .htm file");
    }
    return { kind: "path", path: value };
  }
  throw new Error("invalid browser URL: expected an HTTP/HTTPS URL or local .html/.htm path");
}

function safeRealpath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function allowedRoots(workspace: string, readonlyRoots: readonly string[] = []): string[] {
  return [...new Set([
    safeRealpath(workspace),
    safeRealpath(getMediaDir()),
    safeRealpath(BUILTIN_SKILLS_DIR),
    ...readonlyRoots.map(safeRealpath),
  ])];
}

async function validateLocalFile(
  requested: string,
  {
    restrictLocalFiles,
    roots,
    referrer,
    reference,
  }: {
    restrictLocalFiles: boolean;
    roots: string[];
    referrer: string | null;
    reference: string | null;
  },
): Promise<ValidatedFile> {
  if (isBlockedDevicePath(requested)) {
    throw new Error(`local preview blocked device path: ${requested}`);
  }
  let realPath: string;
  try {
    realPath = await fsPromises.realpath(requested);
  } catch {
    const origin = referrer && reference
      ? ` referenced by ${referrer} as ${JSON.stringify(reference)}`
      : "";
    throw new Error(`local preview file not found: ${requested}${origin}`);
  }
  if (isBlockedDevicePath(realPath)) {
    throw new Error(`local preview blocked device path: ${realPath}`);
  }
  const stat = await fsPromises.stat(realPath);
  if (!stat.isFile()) {
    throw new Error(`local preview requires a regular file: ${realPath}`);
  }
  await fsPromises.access(realPath, fs.constants.R_OK);
  if (restrictLocalFiles && !roots.some((root) => isPathInside(realPath, root))) {
    const origin = referrer && reference
      ? ` referenced by ${referrer} as ${JSON.stringify(reference)}`
      : "";
    throw new Error(`local preview path is outside the allowed file roots: ${realPath}${origin}`);
  }
  return { path: realPath, size: stat.size };
}

function encodePublicPath(relativePath: string): string {
  const segments = relativePath.split(path.sep).filter(Boolean).map(encodeURIComponent);
  return `/${segments.join("/")}`;
}

function normalizePublicPath(value: string): string {
  return new URL(value, PREVIEW_ORIGIN).pathname;
}

function stripQueryAndFragment(value: string): string {
  const query = value.indexOf("?");
  const fragment = value.indexOf("#");
  const cutoff = [query, fragment]
    .filter((index) => index >= 0)
    .reduce((minimum, index) => Math.min(minimum, index), value.length);
  return value.slice(0, cutoff);
}

function decodeReferencePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`local preview contains an invalid encoded path: ${value}`);
  }
}

function referenceScheme(value: string): string | null {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value);
  return match ? `${match[1].toLowerCase()}:` : null;
}

function resolveReference(rawValue: string, context: ReferenceContext): ResolvedReference | null {
  const value = rawValue.trim();
  if (!value || value.startsWith("#")) return null;
  if (value.startsWith("//")) return { kind: "external" };
  const scheme = referenceScheme(value);
  if (scheme === "file:") {
    throw new Error(`local preview does not allow file: references: ${JSON.stringify(value)}`);
  }
  if (scheme) return { kind: "external" };
  const publicUrl = new URL(value, context.publicBaseUrl);
  if (publicUrl.origin !== PREVIEW_ORIGIN) return { kind: "external" };
  const rawPath = stripQueryAndFragment(value);
  const decodedPath = decodeReferencePath(rawPath);
  const sourcePath = decodedPath.startsWith("/")
    ? path.resolve(context.sourceRoot, `.${decodedPath}`)
    : path.resolve(context.sourceBaseDir, decodedPath);
  return {
    kind: "local",
    sourcePath,
    publicPath: normalizePublicPath(publicUrl.pathname),
  };
}

function isHtmlElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}

function nodeAttributes(node: HtmlElement): Map<string, string> {
  return new Map(
    node.attrs.map((attr) => [
      String(attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name).toLowerCase(),
      String(attr.value ?? ""),
    ]),
  );
}

function nodeText(node: HtmlElement): string {
  return node.childNodes
    .filter((child): child is DefaultTreeAdapterTypes.TextNode => child.nodeName === "#text")
    .map((child) => child.value)
    .join("");
}

function walkNodes(node: HtmlNode, visit: (child: HtmlNode) => void): void {
  visit(node);
  if ("childNodes" in node) {
    for (const child of node.childNodes) walkNodes(child, visit);
  }
  if ("content" in node) walkNodes(node.content, visit);
}

function srcsetReferences(value: string): string[] {
  const references: string[] = [];
  let position = 0;
  while (position < value.length) {
    while (position < value.length && /[\s,]/.test(value[position])) position += 1;
    if (position >= value.length) break;
    const start = position;
    while (position < value.length && !/\s/.test(value[position])) position += 1;
    let candidate = value.slice(start, position);
    const endedWithComma = candidate.endsWith(",");
    while (candidate.endsWith(",")) candidate = candidate.slice(0, -1);
    if (candidate && !candidate.startsWith("data:")) references.push(candidate);
    if (endedWithComma) continue;
    let parentheses = 0;
    while (position < value.length) {
      const character = value[position];
      position += 1;
      if (character === "(") parentheses += 1;
      else if (character === ")" && parentheses > 0) parentheses -= 1;
      else if (character === "," && parentheses === 0) break;
    }
  }
  return references;
}

function quotedOrUrlValue(value: string): string | null {
  const trimmed = value.trim();
  const urlMatch = /^url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/i.exec(trimmed);
  if (urlMatch) return (urlMatch[1] ?? urlMatch[2] ?? urlMatch[3] ?? "").trim();
  const quoted = /^(?:"([^"]*)"|'([^']*)')/.exec(trimmed);
  return quoted ? (quoted[1] ?? quoted[2] ?? "") : null;
}

function cssReferences(content: string, from: string): string[] {
  const references: string[] = [];
  const root = postcss.parse(content, { from });
  root.walkAtRules("import", (rule) => {
    const value = quotedOrUrlValue(rule.params);
    if (value) references.push(value);
  });
  root.walkDecls((declaration) => {
    for (const match of declaration.value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
      const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (value) references.push(value);
    }
  });
  return references;
}

function isImportMetaUrl(node: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(node)
    && node.name.text === "url"
    && ts.isMetaProperty(node.expression)
    && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    && node.expression.name.text === "meta";
}

function javascriptReferences(content: string, filename: string): string[] {
  const references: string[] = [];
  const source = ts.createSourceFile(
    filename,
    content,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  const addModuleSpecifier = (node: ts.Expression | undefined) => {
    if (!node || !ts.isStringLiteralLike(node)) return;
    const value = node.text;
    if (
      value.startsWith("./")
      || value.startsWith("../")
      || value.startsWith("/")
      || value.startsWith("//")
      || hasExplicitScheme(value)
    ) {
      references.push(value);
    }
  };
  const addLiteral = (node: ts.Expression | undefined) => {
    if (node && ts.isStringLiteralLike(node)) references.push(node.text);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      addModuleSpecifier(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      addModuleSpecifier(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      addModuleSpecifier(node.arguments[0]);
    } else if (
      ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "URL"
      && node.arguments?.length === 2
      && isImportMetaUrl(node.arguments[1])
    ) {
      addLiteral(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

function firstBaseHref(document: HtmlNode): string | null {
  let base: string | null = null;
  walkNodes(document, (node) => {
    if (base != null || !isHtmlElement(node) || node.tagName.toLowerCase() !== "base") return;
    const href = nodeAttributes(node).get("href");
    if (href) base = href;
  });
  return base;
}

function htmlReferences(
  content: string,
  sourcePath: string,
  publicPath: string,
  sourceRoot: string,
): Array<{ value: string; context: ReferenceContext }> {
  const document = parse(content);
  const defaultContext: ReferenceContext = {
    sourceBaseDir: path.dirname(sourcePath),
    sourceRoot,
    publicBaseUrl: new URL(publicPath, PREVIEW_ORIGIN),
  };
  let context = defaultContext;
  const baseHref = firstBaseHref(document);
  if (baseHref) {
    const scheme = referenceScheme(baseHref);
    if (scheme === "file:") {
      throw new Error(`local preview does not allow file: base href: ${JSON.stringify(baseHref)}`);
    }
    const publicBaseUrl = new URL(baseHref, defaultContext.publicBaseUrl);
    if (publicBaseUrl.origin !== PREVIEW_ORIGIN) {
      context = { ...defaultContext, publicBaseUrl };
    } else {
      const rawBasePath = decodeReferencePath(stripQueryAndFragment(baseHref));
      const sourceBasePath = rawBasePath.startsWith("/")
        ? path.resolve(sourceRoot, `.${rawBasePath}`)
        : path.resolve(path.dirname(sourcePath), rawBasePath);
      context = {
        sourceRoot,
        publicBaseUrl,
        sourceBaseDir: rawBasePath.endsWith("/")
          ? sourceBasePath
          : path.dirname(sourceBasePath),
      };
    }
  }

  const references: Array<{ value: string; context: ReferenceContext }> = [];
  const add = (value: string | undefined) => {
    if (value) references.push({ value, context });
  };
  walkNodes(document, (node) => {
    if (!isHtmlElement(node)) return;
    const tag = node.tagName.toLowerCase();
    if (tag === "base") return;
    const attrs = nodeAttributes(node);
    if (tag === "script") add(attrs.get("src"));
    if (tag === "link") {
      const rels = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      if (rels.some((rel) => RESOURCE_LINK_RELS.has(rel))) add(attrs.get("href"));
    }
    if (tag === "img" || tag === "source") {
      add(attrs.get("src"));
      for (const value of srcsetReferences(attrs.get("srcset") ?? "")) add(value);
    }
    if (tag === "input") add(attrs.get("src"));
    if (tag === "video") {
      add(attrs.get("src"));
      add(attrs.get("poster"));
    }
    if (tag === "audio" || tag === "track" || tag === "iframe" || tag === "embed") {
      add(attrs.get("src"));
    }
    if (tag === "object") add(attrs.get("data"));
    if (tag === "image" || tag === "use") {
      add(attrs.get("href"));
      add(attrs.get("xlink:href"));
    }
    if (tag === "a" || tag === "area") {
      const href = attrs.get("href");
      if (href) {
        const pathname = new URL(href, context.publicBaseUrl).pathname;
        if (HTML_EXTENSIONS.has(path.posix.extname(pathname).toLowerCase())) add(href);
      }
    }
    const inlineStyle = attrs.get("style");
    if (inlineStyle) {
      for (const value of cssReferences(inlineStyle, sourcePath)) add(value);
    }
    if (tag === "style") {
      for (const value of cssReferences(nodeText(node), sourcePath)) add(value);
    }
  });
  return references;
}

function sourceRootForEntry(
  entryPath: string,
  workspace: string,
  restrictLocalFiles: boolean,
  roots: string[],
): string {
  const realWorkspace = safeRealpath(workspace);
  if (isPathInside(entryPath, realWorkspace)) return realWorkspace;
  if (restrictLocalFiles) {
    const containing = roots
      .filter((root) => isPathInside(entryPath, root))
      .sort((left, right) => right.length - left.length);
    if (containing[0]) return containing[0];
  }
  return path.dirname(entryPath);
}

function mimeTypeFor(sourcePath: string): string {
  const detected = lookup(sourcePath) || "application/octet-stream";
  return contentType(detected) || String(detected);
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, PREVIEW_HOST);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("local preview server did not expose a TCP port");
  }
  return address.port;
}

export async function createBrowserPreview(
  requestedEntry: string,
  options: PreviewOptions,
): Promise<BrowserPreviewLease> {
  const workspace = path.resolve(options.workspace);
  const roots = allowedRoots(workspace, options.readonlyRoots);
  const entryCandidate = path.isAbsolute(requestedEntry) || isWindowsAbsolutePath(requestedEntry)
    ? requestedEntry
    : path.resolve(workspace, requestedEntry);
  const entry = await validateLocalFile(entryCandidate, {
    restrictLocalFiles: options.restrictLocalFiles,
    roots,
    referrer: null,
    reference: null,
  });
  if (!HTML_EXTENSIONS.has(path.extname(entry.path).toLowerCase())) {
    throw new Error(`local preview entry must be a .html or .htm file: ${entry.path}`);
  }
  const sourceRoot = sourceRootForEntry(
    entry.path,
    workspace,
    options.restrictLocalFiles,
    roots,
  );
  const entryPublicPath = encodePublicPath(path.relative(sourceRoot, entry.path));
  const stagingDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "memmy-browser-preview-"));
  const manifest = new Map<string, StagedFile>();
  const sourceStages = new Map<string, StagedFile>();
  const parsedMappings = new Set<string>();
  const queue: PendingFile[] = [];
  let totalBytes = 0;
  let server: http.Server | null = null;

  const enqueue = async (
    sourcePath: string,
    publicPath: string,
    referrer: string | null,
    reference: string | null,
  ): Promise<void> => {
    const validated = await validateLocalFile(sourcePath, {
      restrictLocalFiles: options.restrictLocalFiles,
      roots,
      referrer,
      reference,
    });
    const canonicalPublicPath = normalizePublicPath(publicPath);
    const collision = manifest.get(canonicalPublicPath);
    const existingStage = sourceStages.get(validated.path);
    if (collision && collision !== existingStage) {
      throw new Error(`local preview URL collision at ${canonicalPublicPath}`);
    }
    if (!collision && manifest.size + 1 > PREVIEW_MAX_FILES) {
      throw new Error(`local preview exceeds the ${PREVIEW_MAX_FILES}-file limit`);
    }
    let staged = existingStage;
    if (!staged) {
      if (totalBytes + validated.size > PREVIEW_MAX_BYTES) {
        throw new Error(`local preview exceeds the ${PREVIEW_MAX_BYTES}-byte limit`);
      }
      const extension = path.extname(validated.path).toLowerCase();
      const stagedPath = path.join(
        stagingDir,
        `${String(sourceStages.size + 1).padStart(4, "0")}${extension}`,
      );
      await fsPromises.copyFile(validated.path, stagedPath);
      const stagedSize = (await fsPromises.stat(stagedPath)).size;
      if (totalBytes + stagedSize > PREVIEW_MAX_BYTES) {
        throw new Error(`local preview exceeds the ${PREVIEW_MAX_BYTES}-byte limit`);
      }
      staged = {
        path: stagedPath,
        contentType: mimeTypeFor(validated.path),
      };
      sourceStages.set(validated.path, staged);
      totalBytes += stagedSize;
    }
    manifest.set(canonicalPublicPath, staged);
    const mappingKey = `${validated.path}\0${canonicalPublicPath}`;
    if (!parsedMappings.has(mappingKey)) {
      parsedMappings.add(mappingKey);
      queue.push({
        sourcePath: validated.path,
        stagedPath: staged.path,
        publicPath: canonicalPublicPath,
      });
    }
  };

  try {
    await enqueue(entry.path, entryPublicPath, null, null);
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      const extension = path.extname(current.sourcePath).toLowerCase();
      if (
        !HTML_EXTENSIONS.has(extension)
        && extension !== ".css"
        && !JAVASCRIPT_EXTENSIONS.has(extension)
      ) {
        continue;
      }
      const content = await fsPromises.readFile(current.stagedPath, "utf8");
      const context: ReferenceContext = {
        sourceBaseDir: path.dirname(current.sourcePath),
        sourceRoot,
        publicBaseUrl: new URL(current.publicPath, PREVIEW_ORIGIN),
      };
      const references = HTML_EXTENSIONS.has(extension)
        ? htmlReferences(content, current.sourcePath, current.publicPath, sourceRoot)
        : (extension === ".css" ? cssReferences(content, current.sourcePath) : javascriptReferences(content, current.sourcePath))
          .map((value) => ({ value, context }));
      for (const item of references) {
        const resolved = resolveReference(item.value, item.context);
        if (!resolved || resolved.kind === "external") continue;
        await enqueue(
          resolved.sourcePath,
          resolved.publicPath,
          current.sourcePath,
          item.value,
        );
      }
    }

    server = http.createServer((request, response) => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" });
        response.end();
        return;
      }
      let pathname: string;
      try {
        pathname = new URL(request.url ?? "/", PREVIEW_ORIGIN).pathname;
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      const staged = manifest.get(pathname);
      if (!staged) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": staged.contentType,
        "X-Content-Type-Options": "nosniff",
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const stream = fs.createReadStream(staged.path);
      stream.once("error", () => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
      stream.pipe(response);
    });
    const port = await listen(server);
    let closed = false;
    return {
      url: `http://${PREVIEW_HOST}:${port}${entryPublicPath}`,
      close: async () => {
        if (closed) return;
        closed = true;
        await closeServer(server!);
        await fsPromises.rm(stagingDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (server) await closeServer(server).catch(() => undefined);
    await fsPromises.rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}
