/** Http memmy agent admin client module. */
import {
  ChannelConnectionsResponseSchema,
  ChannelDefinitionsResponseSchema,
  ChannelStatusSchema
} from "@memmy/local-api-contracts";
import { z } from "zod";
import type { MemmyAgentAdminClient } from "./index.js";

export const DEFAULT_MEMMY_AGENT_ADMIN_BASE_URL = "http://127.0.0.1:18980";

const BootstrapSchema = z.object({
  token: z.string().min(1)
});

const ChannelRuntimeActionResponseSchema = z.object({
  status: ChannelStatusSchema,
  running: z.boolean()
});

const WeixinLoginResponseSchema = z.object({
  status: ChannelStatusSchema,
  qrCodeDataUrl: z.string().min(1).optional(),
  pollToken: z.string().min(1).optional()
});

export interface CreateHttpMemmyAgentAdminClientOptions {
  /** Memmy-agent WebUI HTTP base URL. */
  baseUrl?: string;
  /** Bootstrap secret. */
  bootstrapSecret?: string | null;
  /** Fetch fn. */
  fetchFn?: typeof fetch;
}

export function createHttpMemmyAgentAdminClient(
  options: CreateHttpMemmyAgentAdminClientOptions = {}
): MemmyAgentAdminClient {
  return new HttpMemmyAgentAdminClient(options);
}

class HttpMemmyAgentAdminClient implements MemmyAgentAdminClient {
  private readonly baseUrl: string;
  private readonly bootstrapSecret: string | null;
  private readonly fetchFn: typeof fetch;
  private token: string | null = null;

  constructor(options: CreateHttpMemmyAgentAdminClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_MEMMY_AGENT_ADMIN_BASE_URL);
    this.bootstrapSecret = options.bootstrapSecret?.trim() || null;
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis);
  }

  async getChannelDefinitions() {
    return this.request("/api/channels/definitions", ChannelDefinitionsResponseSchema);
  }

  async getChannelConnections() {
    return this.request("/api/channels/status", ChannelConnectionsResponseSchema);
  }

  async configureChannel(runtimeChannel: string) {
    return this.request(`/api/channels/${encodeURIComponent(runtimeChannel)}/configure`, ChannelRuntimeActionResponseSchema, { method: "POST" });
  }

  async stopChannel(runtimeChannel: string) {
    return this.request(`/api/channels/${encodeURIComponent(runtimeChannel)}/stop`, ChannelRuntimeActionResponseSchema, { method: "POST" });
  }

  async startWeixinLogin() {
    return this.request("/api/channels/weixin/login/start", WeixinLoginResponseSchema, { method: "POST" });
  }

  async pollWeixinLogin(pollToken: string) {
    return this.request(`/api/channels/weixin/login/${encodeURIComponent(pollToken)}`, WeixinLoginResponseSchema);
  }

  private async request<T>(path: string, schema: { parse(value: unknown): T }, init: RequestInit = {}, retried = false): Promise<T> {
    const token = await this.bootstrapToken();
    const response = await this.fetchFn(new URL(path, this.baseUrl), {
      ...init,
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...init.headers
      }
    });

    if (response.status === 401 && !retried) {
      this.token = null;
      return this.request(path, schema, init, true);
    }
    if (!response.ok) {
      throw new Error(await responseErrorMessage(response, `memmy-agent admin request failed with HTTP ${response.status}`));
    }

    return schema.parse(await response.json());
  }

  private async bootstrapToken(): Promise<string> {
    if (this.token) return this.token;

    const response = await this.fetchFn(new URL("/webui/bootstrap", this.baseUrl), {
      headers: this.bootstrapSecret ? { "x-memmy-agent-auth": this.bootstrapSecret } : undefined
    });
    if (!response.ok) {
      throw new Error(`memmy-agent bootstrap failed with HTTP ${response.status}`);
    }
    const parsed = BootstrapSchema.parse(await response.json());
    this.token = parsed.token;
    return parsed.token;
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/g, "") || DEFAULT_MEMMY_AGENT_ADMIN_BASE_URL;
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.text().catch(() => "")).trim();
  return body || fallback;
}
