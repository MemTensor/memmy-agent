import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface MemoryViewerAsset {
  body: Buffer;
  contentType: string;
  cacheControl: string;
}

export function memoryPanelHtml(_timeZone?: string): string {
  const asset = memoryViewerAsset("/viewer/");
  return asset?.body.toString("utf8") ?? viewerBuildMissingHtml();
}

export function memoryViewerAsset(pathname: string): MemoryViewerAsset | undefined {
  const relativePath = viewerRelativePath(pathname);
  if (!relativePath) return undefined;
  const root = builtViewerRoot();
  if (!root) {
    if (relativePath !== "index.html") return undefined;
    return { body: Buffer.from(viewerBuildMissingHtml()), contentType: "text/html; charset=utf-8", cacheControl: "no-store" };
  }
  const path = resolve(root, relativePath);
  if (!path.startsWith(`${root}${sep}`) && path !== root) return undefined;
  if (!existsSync(path)) {
    if (extname(relativePath)) return undefined;
    return assetFromPath(join(root, "index.html"));
  }
  return assetFromPath(path);
}

export function isMemoryViewerPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/viewer" || pathname === "/viewer/" ||
    VIEWER_ROOT_ROUTES.has(pathname) || VIEWER_PUBLIC_ASSETS.has(pathname) ||
    pathname.startsWith("/viewer/");
}

function builtViewerRoot(): string | undefined {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(moduleDir, "../../dist/viewer"), resolve(moduleDir, "../../viewer")];
  return candidates.find((candidate) => existsSync(join(candidate, "index.html")) && existsSync(join(candidate, "assets")));
}

function viewerRelativePath(pathname: string): string | undefined {
  if (pathname === "/" || pathname === "/viewer" || pathname === "/viewer/" || VIEWER_ROOT_ROUTES.has(pathname)) return "index.html";
  if (VIEWER_PUBLIC_ASSETS.has(pathname)) return pathname.slice(1);
  if (!pathname.startsWith("/viewer/")) return undefined;
  const relative = decodeURIComponent(pathname.slice("/viewer/".length));
  if (!relative || relative.includes("\0") || relative.split("/").includes("..")) return undefined;
  return relative;
}

const VIEWER_PUBLIC_ASSETS = new Set([
  "/memos-logo.svg",
  "/hermes-logo.svg",
  "/openclaw-logo.svg"
]);

const VIEWER_ROOT_ROUTES = new Set([
  "/overview",
  "/user-memories",
  "/memories",
  "/tasks",
  "/policies",
  "/world-models",
  "/skills",
  "/analytics",
  "/logs",
  "/settings"
]);

function assetFromPath(path: string): MemoryViewerAsset {
  const extension = extname(path).toLowerCase();
  return {
    body: readFileSync(path),
    contentType: CONTENT_TYPES[extension] ?? "application/octet-stream",
    cacheControl: extension === ".html" ? "no-store" : "public, max-age=31536000, immutable"
  };
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

function viewerBuildMissingHtml(): string {
  return "<!doctype html><html><head><meta charset=\"utf-8\"><title>Memmy Memory</title></head>" +
    "<body><main><h1>Memmy Memory Viewer</h1><p>Viewer assets are not built. Run npm run viewer:build in Memory.</p></main></body></html>";
}
