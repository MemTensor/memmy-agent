/**
 * REST client for the MemOS viewer.
 *
 * Wraps `fetch` with:
 *   - sensible defaults (JSON content-type, API-key propagation),
 *   - uniform error handling (surface `{error:{code,message}}` shape),
 *   - tiny helper surface: `get`, `post`, `del`.
 */

import {
  adaptViewerResponse,
  localViewerResponse,
  prepareViewerRequest,
} from "./memmy-adapter";

const DEFAULT_HEADERS: Record<string, string> = {
  "content-type": "application/json",
  accept: "application/json",
  "x-memmy-viewer": "1",
};

/**
 * Optional path prefix for legacy single-port installs and reverse
 * proxies. New installs mount the SPA at root, but old bookmarks and
 * deployments such as `/memos/` still need API calls to retain the
 * leading prefix.
 */
export const AGENT_PREFIX: string = detectAgentPrefix();

function detectAgentPrefix(): string {
  if (typeof location === "undefined") return "";
  const seg = location.pathname.split("/").filter(Boolean)[0];
  return seg === "openclaw" || seg === "hermes" || seg === "memos" ? `/${seg}` : "";
}

/**
 * Prefix viewer API paths when the SPA itself is served from an agent
 * prefix. Absolute external URLs are left untouched.
 */
export function withAgentPrefix(path: string): string {
  if (!AGENT_PREFIX) return path;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${AGENT_PREFIX}${normalized}`;
}

function apiKeyHeader(): Record<string, string> {
  const key = localStorage.getItem("memos.apiKey");
  return key ? { "x-api-key": key } : {};
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public payload?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  opts: { signal?: AbortSignal } = {},
): Promise<T> {
  const local = localViewerResponse(method, path);
  if (local.handled) return local.payload as T;
  const prepared = prepareViewerRequest(method, path, body);
  const res = await fetch(withAgentPrefix(prepared.path), {
    method: prepared.method,
    headers: { ...DEFAULT_HEADERS, ...apiKeyHeader() },
    body: prepared.body !== undefined ? JSON.stringify(prepared.body) : undefined,
    signal: opts.signal,
  });
  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!res.ok) {
    const err =
      payload && typeof payload === "object" && "error" in (payload as any)
        ? (payload as any).error
        : { code: "http_error", message: res.statusText };
    throw new ApiError(err.code, err.message, res.status, payload);
  }
  return adaptViewerResponse(method, path, body, payload) as T;
}

async function blobRequest(
  path: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Blob> {
  const res = await fetch(withAgentPrefix(path), {
    method: "GET",
    headers: { ...apiKeyHeader(), "x-memmy-viewer": "1" },
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new ApiError("http_error", res.statusText, res.status);
  }
  return res.blob();
}

async function postRaw<T = unknown>(
  path: string,
  body: FormData | Blob,
  opts: { signal?: AbortSignal } = {},
): Promise<T> {
  if (path === "/api/v1/import" && body instanceof FormData) {
    const bundle = body.get("bundle");
    if (!(bundle instanceof Blob)) {
      throw new ApiError("invalid_argument", "Import bundle is missing", 400);
    }
    const parsed = JSON.parse(await bundle.text()) as unknown;
    return request<T>("POST", path, { bundle: parsed });
  }
  // NOTE: we deliberately don't set `content-type` — the browser sets
  // the correct boundary for FormData, and a manual content-type would
  // break multipart parsing on the server side.
  const res = await fetch(withAgentPrefix(path), {
    method: "POST",
    headers: { ...apiKeyHeader(), "x-memmy-viewer": "1" },
    body,
    signal: opts.signal,
  });
  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!res.ok) {
    const err =
      payload && typeof payload === "object" && "error" in (payload as Record<string, unknown>)
        ? (payload as { error: { code: string; message: string } }).error
        : { code: "http_error", message: res.statusText };
    throw new ApiError(err.code, err.message, res.status, payload);
  }
  return payload as T;
}

export const api = {
  get: <T = unknown>(path: string, opts?: { signal?: AbortSignal }) =>
    request<T>("GET", path, undefined, opts),
  post: <T = unknown>(path: string, body?: unknown, opts?: { signal?: AbortSignal }) =>
    request<T>("POST", path, body, opts),
  patch: <T = unknown>(path: string, body?: unknown, opts?: { signal?: AbortSignal }) =>
    request<T>("PATCH", path, body, opts),
  del: <T = unknown>(path: string, opts?: { signal?: AbortSignal }) =>
    request<T>("DELETE", path, undefined, opts),
  blob: (path: string, opts?: { signal?: AbortSignal }) => blobRequest(path, opts),
  postRaw: <T = unknown>(
    path: string,
    body: FormData | Blob,
    opts?: { signal?: AbortSignal },
  ) => postRaw<T>(path, body, opts),
};
