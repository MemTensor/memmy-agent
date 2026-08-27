import { createServer, type Server } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { PACKAGED_RENDERER_DEFAULT_PORT, PACKAGED_RENDERER_HOST } from "./window-mode.js";

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

export interface PackagedRendererStaticServer {
  baseUrl: string;
  close(): Promise<void>;
}

export interface StartPackagedRendererStaticServerOptions {
  rootDirectory: string;
  host?: string;
  port?: number;
}

/**
 * Serves the packaged renderer over loopback HTTP so gtag can run outside file://.
 */
export async function startPackagedRendererStaticServer(
  options: StartPackagedRendererStaticServerOptions
): Promise<PackagedRendererStaticServer> {
  const host = options.host ?? PACKAGED_RENDERER_HOST;
  const port = options.port ?? resolvePackagedRendererPort();
  const rootDirectory = resolve(options.rootDirectory);
  await assertPackagedRendererRootReadable(rootDirectory);

  const server = createServer((request, response) => {
    void handleRendererRequest(request, response, rootDirectory);
  });

  await listenOnLoopback(server, port);
  const resolvedPort = readListeningPort(server, port);
  return {
    baseUrl: `http://${host}:${resolvedPort}`,
    close: () => closeServer(server)
  };
}

function resolvePackagedRendererPort(): number {
  const raw = process.env.MEMMY_PACKAGED_RENDERER_PORT?.trim();
  if (!raw) {
    return PACKAGED_RENDERER_DEFAULT_PORT;
  }

  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`MEMMY_PACKAGED_RENDERER_PORT must be an integer between 1 and 65535: ${raw}`);
  }

  return port;
}

async function assertPackagedRendererRootReadable(rootDirectory: string): Promise<void> {
  // Electron asar supports file reads but not directory stat/access on archive folders.
  await access(join(rootDirectory, "index.html"));
}

async function handleRendererRequest(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  rootDirectory: string
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    response.end("Method not allowed");
    return;
  }

  try {
    const requestUrl = new URL(request.url ?? "/", `http://${PACKAGED_RENDERER_HOST}`);
    const filePath = resolveRendererFilePath(rootDirectory, requestUrl.pathname);
    if (!filePath) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("Forbidden");
      return;
    }

    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "content-type": resolveContentType(filePath),
      "content-length": fileStats.size,
      "cache-control": "no-store"
    });

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    createReadStream(filePath).pipe(response);
  } catch (error) {
    if (isNotFoundError(error)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("Internal server error");
  }
}

function resolveRendererFilePath(rootDirectory: string, pathname: string): string | null {
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  const relativePath = normalizedPath.replace(/^\/+/, "");
  const candidate = resolve(rootDirectory, relativePath);

  if (candidate !== rootDirectory && !candidate.startsWith(`${rootDirectory}${sep}`)) {
    return null;
  }

  if (!existsSync(candidate)) {
    return null;
  }

  return candidate;
}

function resolveContentType(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function listenOnLoopback(server: Server, port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
}

function readListeningPort(server: Server, requestedPort: number): number {
  const address = server.address();
  if (typeof address === "object" && address) {
    return address.port;
  }

  return requestedPort;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolvePromise();
    });
  });
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
