import type { MemmyMemoryConnection, MemmyMemoryRequestEnvelope, JsonRecord } from "./types.js";

export class MemmyMemoryHttpError extends Error {
  status: number;
  body: any;

  constructor(status: number, message: string, body: any = null) {
    super(message);
    this.name = "MemmyMemoryHttpError";
    this.status = status;
    this.body = body;
  }
}

type FetchLike = typeof fetch;

export const DEFAULT_MEMOS_MEMORY_TIMEOUT_MS = 20_000;

export class MemmyMemoryClient {
  baseUrl: string;
  token: string | null;
  timeoutMs: number;
  private fetchImpl: FetchLike;

  constructor(connection: MemmyMemoryConnection, fetchImpl: FetchLike = fetch) {
    this.baseUrl = connection.baseUrl.replace(/\/+$/, "");
    this.token = connection.token ?? null;
    this.timeoutMs = connection.timeoutMs ?? DEFAULT_MEMOS_MEMORY_TIMEOUT_MS;
    this.fetchImpl = fetchImpl;
  }

  private url(path: string, query?: Record<string, any>): string {
    const url = new URL(path.startsWith("/") ? path : `/${path}`, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value == null || value === "") continue;
      url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
    return url.toString();
  }

  private async request<T>(method: string, path: string, opts: { query?: Record<string, any>; body?: any } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const requestId = opts.body && typeof opts.body === "object" ? opts.body.requestId : null;
    if (requestId) headers["x-request-id"] = String(requestId);

    const response = await this.fetchImpl(this.url(path, opts.query), {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    const parsed = text.trim() ? safeJsonParse(text) : null;
    if (!response.ok) {
      const fallback = text || `${method} ${path} failed with ${response.status}`;
      const message = parsed?.error?.message ?? parsed?.message ?? fallback;
      throw new MemmyMemoryHttpError(response.status, message, parsed ?? text);
    }
    return parsed as T;
  }

  get<T = any>(path: string, query?: Record<string, any>): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  post<T = any>(path: string, body: any = {}): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  health(): Promise<JsonRecord> {
    return this.get("/api/v1/health");
  }

  openSession(body: JsonRecord & MemmyMemoryRequestEnvelope): Promise<JsonRecord> {
    return this.post("/api/v1/sessions/open", body);
  }

  closeSession(sessionId: string, body: MemmyMemoryRequestEnvelope): Promise<JsonRecord> {
    return this.post(`/api/v1/sessions/${encodeURIComponent(sessionId)}/close`, body);
  }

  startTurn(turnId: string, body: JsonRecord & MemmyMemoryRequestEnvelope): Promise<JsonRecord> {
    return this.post("/api/v1/turns/start", {
      ...body,
      turnId,
      query: body.query,
    });
  }

  completeTurn(turnId: string, body: JsonRecord & MemmyMemoryRequestEnvelope): Promise<JsonRecord> {
    return this.post(`/api/v1/turns/${encodeURIComponent(turnId)}/complete`, body);
  }

  search(body: JsonRecord & MemmyMemoryRequestEnvelope): Promise<JsonRecord> {
    return this.post("/api/v1/memory/search", body);
  }

  getMemory(id: string): Promise<JsonRecord> {
    return this.get(`/api/v1/memory/${encodeURIComponent(id)}`);
  }

}

function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
