import type {
  HealthResponse,
  MemoryAddRequest,
  MemoryGovernanceRequest,
  MemoryReloadConfigRequest,
  MemoryReloadConfigResponse,
  MemorySearchRequest,
  RequestEnvelope,
  SessionOpenRequest,
  TurnCompleteRequest,
  TurnStartRequest
} from "../types.js";
import {
  L3WorldModelBoundaryResponseSchema,
  L3WorldModelTraceHeadResponseSchema,
  SessionL3WorldModelContextResponseSchema,
  l3WorldModelGetTransport,
  type L3WorldModelBoundaryRequest,
  type L3WorldModelBoundaryResponse,
  type L3WorldModelRequestEnvelope,
  type L3WorldModelTraceHeadResponse,
  type SessionL3WorldModelContextResponse
} from "@memmy/local-api-contracts";
import { resolveTimeZone } from "../utils/time.js";

export type MemoryRestQueryValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | undefined;
export type MemoryRestQuery = Record<string, MemoryRestQueryValue>;

export interface MemoryRestClientOptions {
  endpoint: string;
  token?: string;
  headers?: Record<string, string>;
  timeZone?: string;
}

export class MemoryRestClient {
  private readonly endpoint: string;
  private readonly token?: string;
  private readonly headers: Record<string, string>;
  private readonly timeZone: string;

  constructor(options: MemoryRestClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.token = options.token;
    this.headers = options.headers ?? {};
    this.timeZone = resolveTimeZone(options.timeZone);
  }

  health(): Promise<HealthResponse> {
    return this.request("GET", "/api/v1/health") as Promise<HealthResponse>;
  }

  reloadConfig(request: MemoryReloadConfigRequest = {}): Promise<MemoryReloadConfigResponse> {
    return this.request("POST", "/api/v1/admin/reload-config", request) as Promise<MemoryReloadConfigResponse>;
  }

  openSession(request: SessionOpenRequest): Promise<unknown> {
    return this.request("POST", "/api/v1/sessions/open", request);
  }

  closeSession(sessionId: string, request: RequestEnvelope = {}): Promise<unknown> {
    return this.request("POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/close`, request);
  }

  async l3WorldModelTraceHead(
    sessionId: string,
    envelope: L3WorldModelRequestEnvelope
  ): Promise<L3WorldModelTraceHeadResponse> {
    const transport = l3WorldModelGetTransport(envelope);
    const payload = await this.request(
      "GET",
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/l3-world-model-trace-head${queryString(transport.query)}`,
      undefined,
      transport.headers
    );
    return L3WorldModelTraceHeadResponseSchema.parse(payload);
  }

  async l3WorldModelBoundary(
    sessionId: string,
    request: L3WorldModelBoundaryRequest
  ): Promise<L3WorldModelBoundaryResponse> {
    const payload = await this.request(
      "POST",
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/l3-world-model-boundary`,
      request
    );
    return L3WorldModelBoundaryResponseSchema.parse(payload);
  }

  async l3WorldModelContext(
    sessionId: string,
    envelope: L3WorldModelRequestEnvelope
  ): Promise<SessionL3WorldModelContextResponse> {
    const transport = l3WorldModelGetTransport(envelope);
    const payload = await this.request(
      "GET",
      `/api/v1/l3-world-model/sessions/${encodeURIComponent(sessionId)}/context${queryString(transport.query)}`,
      undefined,
      transport.headers
    );
    return SessionL3WorldModelContextResponseSchema.parse(payload);
  }

  startTurn(request: TurnStartRequest): Promise<unknown> {
    return this.request("POST", "/api/v1/turns/start", request);
  }

  completeTurn(turnId: string, request: TurnCompleteRequest & Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/api/v1/turns/${encodeURIComponent(turnId)}/complete`, request);
  }

  search(request: MemorySearchRequest): Promise<unknown> {
    return this.request("POST", "/api/v1/memory/search", request);
  }

  addMemory(request: MemoryAddRequest): Promise<unknown> {
    return this.request("POST", "/api/v1/memory/add", request);
  }

  getMemory(id: string): Promise<unknown> {
    return this.request("GET", `/api/v1/memory/${encodeURIComponent(id)}`);
  }

  deleteMemory(id: string, request?: MemoryGovernanceRequest): Promise<unknown> {
    return this.request("DELETE", `/api/v1/memory/${encodeURIComponent(id)}`, request);
  }

  panelOverview(query: MemoryRestQuery = {}): Promise<unknown> {
    return this.request("GET", `/api/v1/panel/overview${queryString(query)}`);
  }

  panelAnalysis(query: MemoryRestQuery = {}): Promise<unknown> {
    return this.request("GET", `/api/v1/panel/analysis${queryString(query)}`);
  }

  panelItems(query: MemoryRestQuery = {}): Promise<unknown> {
    return this.request("GET", `/api/v1/panel/items${queryString(query)}`);
  }

  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    requestHeaders: Record<string, string> = {}
  ): Promise<unknown> {
    const response = await fetch(`${this.endpoint}${path}`, {
      method,
      headers: {
        ...this.headers,
        ...requestHeaders,
        "x-memmy-time-zone": this.timeZone,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) as unknown : undefined;
    if (!response.ok) {
      throw new MemoryRestClientError(response.status, payload, text);
    }
    return payload;
  }

}

export class MemoryRestClientError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
    readonly rawBody: string
  ) {
    super(`memory service HTTP ${status}: ${rawBody}`);
  }
}

function queryString(query: MemoryRestQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
  }
  const rendered = params.toString();
  return rendered ? `?${rendered}` : "";
}
