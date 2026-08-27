import { DEFAULT_MEMORY_URL, loadCliMemoryConfig } from "./config.js";

export interface CliRequestOptions {
  url?: string;
  token?: string;
  configPath?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export interface CliRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export async function sendRequest(request: CliRequest, options: CliRequestOptions = {}): Promise<unknown> {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = resolveBaseUrl(options);
  const url = new URL(withApiPrefix(request.path), baseUrl);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const token = resolveToken(options);
  const headers: Record<string, string> = {
    ...(options.headers ?? {})
  };
  if (request.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const response = await fetchImpl(url, {
    method: request.method,
    headers,
    body: request.body === undefined ? undefined : JSON.stringify(request.body)
  });

  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  const payload = contentType.includes("application/json") && text.trim()
    ? JSON.parse(text) as unknown
    : text;

  if (!response.ok) {
    const message = errorMessage(payload) ?? `HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

export function withApiPrefix(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (normalized.startsWith("/api/v1/") || normalized === "/api/v1") {
    return normalized;
  }
  return `/api/v1${normalized}`;
}

function resolveBaseUrl(options: CliRequestOptions): string {
  if (options.url) {
    return options.url;
  }
  const { config } = loadCliMemoryConfig(options.configPath);
  return config.endpoint ?? DEFAULT_MEMORY_URL;
}

function resolveToken(options: CliRequestOptions): string | undefined {
  if (options.token) {
    return options.token;
  }
  const { config } = loadCliMemoryConfig(options.configPath);
  return config.token;
}

function errorMessage(payload: unknown): string | undefined {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const error = record.error;
    if (error && typeof error === "object" && !Array.isArray(error)) {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
  }
  if (typeof payload === "string" && payload.trim()) {
    return payload;
  }
  return undefined;
}
