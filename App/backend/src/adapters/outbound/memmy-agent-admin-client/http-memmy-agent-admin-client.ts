/** Http memmy agent admin client module. */
import {
  ChannelConnectionsResponseSchema,
  ChannelDefinitionsResponseSchema,
  ChannelStatusSchema
} from "@memmy/local-api-contracts";
import { z } from "zod";
import type { AssistRunSnapshot, AssistRunStartInput, AssistTranscriptItem, MemmyAgentAdminClient } from "./index.js";

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

const FeishuLoginResponseSchema = WeixinLoginResponseSchema.extend({
  appId: z.string().min(1).optional(),
  appSecret: z.string().min(1).optional(),
  domain: z.enum(["feishu", "lark"]).optional()
});

const McpReloadResponseSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  requires_restart: z.boolean()
});

const WorkspaceEnvironmentResponseSchema = z.object({
  snapshot: z.object({
    cwd: z.string()
  })
});

const AssistRunSnapshotSchema = z.object({
  chat_id: z.string().min(1),
  status: z.enum(["starting", "queued", "running", "done", "failed", "stopped"]),
  steps: z.array(z.object({
    text: z.string(),
    output: z.string().optional(),
    status: z.enum(["running", "done", "failed"])
  })).default([]),
  /** 完整执行过程：旧运行时没有这一项。 */
  transcript: z.array(z.union([
    z.object({ kind: z.literal("text"), text: z.string(), truncated: z.boolean().optional() }),
    z.object({
      kind: z.literal("tool"),
      name: z.string(),
      input: z.string().default(""),
      output: z.string().default(""),
      status: z.enum(["running", "done", "failed"]),
      truncated: z.boolean().optional()
    }),
    z.object({ kind: z.literal("omitted"), count: z.number().int().nonnegative() })
  ])).default([]),
  reply: z.string().default(""),
  error: z.string().nullable().default(null),
  /** 隐藏注入的系统提示词段落：只在开始这一轮时返回。 */
  prompt_context: z.string().optional()
});

function toAssistRunSnapshot(value: unknown): AssistRunSnapshot {
  const parsed = AssistRunSnapshotSchema.parse(value);
  return {
    chatId: parsed.chat_id,
    status: parsed.status,
    steps: parsed.steps.map((step) => ({ text: step.text, status: step.status, ...(step.output ? { output: step.output } : {}) })),
    transcript: parsed.transcript.map((item) => ({ ...item })) as AssistTranscriptItem[],
    reply: parsed.reply,
    error: parsed.error,
    ...(parsed.prompt_context ? { promptContext: parsed.prompt_context } : {})
  };
}

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

  async hasActiveTasks(signal?: AbortSignal): Promise<boolean> {
    const timeout = AbortSignal.timeout(10_000);
    const response = await this.request("/api/runtime/task-activity", z.object({ busy: z.boolean() }), {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    return response.busy;
  }

  async getChannelDefinitions() {
    return this.request("/api/channels/definitions", ChannelDefinitionsResponseSchema);
  }

  async getChannelConnections() {
    return this.request("/api/channels/status", ChannelConnectionsResponseSchema);
  }

  async getSessionWorkspace(sessionKey: string): Promise<string | null> {
    const normalizedSessionKey = normalizeGuiSessionKey(sessionKey);
    const environment = await this.request(
      `/api/sessions/${encodeURIComponent(normalizedSessionKey)}/environment`,
      WorkspaceEnvironmentResponseSchema
    );
    return environment.snapshot.cwd.trim() || null;
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

  async startFeishuLogin() {
    return this.request("/api/channels/feishu/login/start", FeishuLoginResponseSchema, { method: "POST" });
  }

  async pollFeishuLogin(pollToken: string) {
    return this.request(`/api/channels/feishu/login/${encodeURIComponent(pollToken)}`, FeishuLoginResponseSchema);
  }

  async reloadMcpConfig() {
    return this.request("/api/settings/mcp-presets/reload", McpReloadResponseSchema, {
      method: "POST",
      signal: AbortSignal.timeout(10_000)
    });
  }

  async startAssistRun(input: AssistRunStartInput): Promise<AssistRunSnapshot> {
    const response = await this.send("/api/webui/assist/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: input.projectId,
        ...(input.chatId ? { chat_id: input.chatId } : {}),
        title: input.title,
        content: input.content,
        assist: input.assist
      }),
      signal: AbortSignal.timeout(30_000)
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    // 派发时就被拒绝（项目不在了、上一轮还没结束）时，把运行时给的原因传上去。
    if (response.status === 409 && body && typeof body.chat_id === "string") return toAssistRunSnapshot(body);
    if (!response.ok) {
      const reason = body && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
      throw new Error(`memmy-agent assist run was not started: ${reason}`);
    }
    return toAssistRunSnapshot(body);
  }

  async deliverAssistResult(input: { chatId: string; content: string }): Promise<"sent" | "missing"> {
    const response = await this.send("/api/webui/assist/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: input.chatId, content: input.content, mode: "deliver" }),
      signal: AbortSignal.timeout(30_000)
    });
    if (response.status === 404) return "missing";
    if (!response.ok) throw new Error(await responseErrorMessage(response, `memmy-agent assist result delivery failed with HTTP ${response.status}`));
    return "sent";
  }

  async readAssistRun(chatId: string): Promise<AssistRunSnapshot | null> {
    const response = await this.send(`/api/webui/assist/runs/${encodeURIComponent(chatId)}`, {
      signal: AbortSignal.timeout(10_000)
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(await responseErrorMessage(response, `memmy-agent assist run read failed with HTTP ${response.status}`));
    return toAssistRunSnapshot(await response.json());
  }

  async stopAssistRun(chatId: string): Promise<AssistRunSnapshot | null> {
    const response = await this.send(`/api/webui/assist/runs/${encodeURIComponent(chatId)}/stop`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000)
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(await responseErrorMessage(response, `memmy-agent assist run stop failed with HTTP ${response.status}`));
    return toAssistRunSnapshot(await response.json());
  }

  /** 带令牌发一次请求，令牌过期时重新取一次；状态码交给调用方处理。 */
  private async send(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const token = await this.bootstrapToken(init.signal);
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
      return this.send(path, init, true);
    }
    return response;
  }

  private async request<T>(path: string, schema: { parse(value: unknown): T }, init: RequestInit = {}, retried = false): Promise<T> {
    const token = await this.bootstrapToken(init.signal);
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

  private async bootstrapToken(signal?: AbortSignal | null): Promise<string> {
    if (this.token) return this.token;

    const response = await this.fetchFn(new URL("/webui/bootstrap", this.baseUrl), {
      headers: this.bootstrapSecret ? { "x-memmy-agent-auth": this.bootstrapSecret } : undefined,
      signal
    });
    if (!response.ok) {
      throw new Error(`memmy-agent bootstrap failed with HTTP ${response.status}`);
    }
    const parsed = BootstrapSchema.parse(await response.json());
    this.token = parsed.token;
    return parsed.token;
  }
}

function normalizeGuiSessionKey(value: string): string {
  const sessionKey = value.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(sessionKey)
    ? `websocket:${sessionKey}`
    : sessionKey;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/g, "") || DEFAULT_MEMMY_AGENT_ADMIN_BASE_URL;
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.text().catch(() => "")).trim();
  return body || fallback;
}
