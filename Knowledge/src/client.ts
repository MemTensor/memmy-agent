import {
  KnowledgeError,
  record,
  text,
  type KnowledgeEvidence,
  type KnowledgeSettings,
} from "./types.js";

export interface KnowledgeSession {
  accountId: string;
  credential: string;
}
export interface ManagedKnowledgeOptions {
  baseUrl: string;
  getSession: () => KnowledgeSession | null;
  fetcher?: typeof fetch;
}
export interface KnowledgeRecallResult {
  enabled: boolean;
  evidence: KnowledgeEvidence[];
}
export interface KnowledgeRecallClient {
  recall(query: string, signal?: AbortSignal): Promise<KnowledgeRecallResult>;
}
export const unavailableSettings = (
  authenticated = false,
): KnowledgeSettings => ({
  authenticated,
  serviceAvailable: false,
  enabled: false,
  bases: [],
  maxBases: 10,
});

/** Sends only a user's Memmy login credential to the developer-configured backend. */
export class ManagedKnowledgeClient implements KnowledgeRecallClient {
  constructor(private readonly options: ManagedKnowledgeOptions) {}
  async request(
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const session = this.options.getSession();
    if (!session) throw new KnowledgeError("请先登录 Memmy 后使用知识库", 401);
    const base = new URL(this.options.baseUrl);
    if (
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      (base.protocol !== "https:" &&
        !(
          base.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)
        ))
    )
      throw new KnowledgeError("知识库服务配置无效", 503);
    const timeout = AbortSignal.timeout(
      path === "/recall"
        ? 15_000
        : method === "POST" && path.endsWith("/files")
          ? 70_000
          : 20_000,
    );
    let response: Response;
    try {
      response = await (this.options.fetcher ?? fetch)(
        `${base.href.replace(/\/+$/, "")}/api/knowledge${path}`,
        {
          method,
          redirect: "error",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: {
            Authorization: `Bearer ${session.credential}`,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      );
    } catch {
      throw new KnowledgeError("知识库服务连接失败或请求超时", 503);
    }
    const current = this.options.getSession();
    if (
      !current ||
      current.accountId !== session.accountId ||
      current.credential !== session.credential
    )
      throw new KnowledgeError("登录状态已改变，请重试", 401);
    if (!response.ok) {
      let serverMessage = "";
      try {
        const errorPayload = record(await response.clone().json());
        serverMessage = text(errorPayload.message) || text(errorPayload.error);
      } catch {
        // Keep the stable fallback below when the server response is not JSON.
      }
      throw new KnowledgeError(
        response.status === 401 || response.status === 403
          ? "请重新登录 Memmy"
          : serverMessage || (response.status === 404
            ? "知识库不存在或服务尚未就绪"
            : "知识库操作未完成，请稍后重试"),
        response.status === 401 || response.status === 403
          ? 401
          : response.status === 404
            ? 404
            : 502,
      );
    }
    let payload: Record<string, unknown>;
    try {
      payload = record(await response.json());
    } catch {
      throw new KnowledgeError("知识库服务返回格式无效", 502);
    }
    if (payload.code !== 0 || !("data" in payload))
      throw new KnowledgeError("知识库操作未完成，请稍后重试", 502);
    if (!this.sameSession(session))
      throw new KnowledgeError("登录状态已改变，请重试", 401);
    return payload.data;
  }
  private sameSession(session: KnowledgeSession | null): boolean {
    const current = this.options.getSession();
    return Boolean(
      session &&
      current &&
      current.accountId === session.accountId &&
      current.credential === session.credential,
    );
  }
  async settings(signal?: AbortSignal): Promise<KnowledgeSettings> {
    if (!this.options.getSession()) return unavailableSettings();
    try {
      return parseSettings(
        await this.request("/settings", "GET", undefined, signal),
      );
    } catch (error) {
      if (error instanceof KnowledgeError && error.statusCode === 401)
        return unavailableSettings();
      return unavailableSettings(true);
    }
  }
  async recall(
    query: string,
    signal?: AbortSignal,
  ): Promise<KnowledgeRecallResult> {
    const session = this.options.getSession();
    const budget = AbortSignal.timeout(22_000);
    signal = signal ? AbortSignal.any([signal, budget]) : budget;
    const settings = await this.settings(signal);
    if (!this.sameSession(session) || signal.aborted)
      return { enabled: false, evidence: [] };
    if (!settings.enabled || !settings.serviceAvailable)
      return { enabled: false, evidence: [] };
    const result = record(
      await this.request("/recall", "POST", { query }, signal),
    );
    const current = await this.settings(signal);
    if (
      !this.sameSession(session) ||
      signal.aborted ||
      !current.enabled ||
      JSON.stringify(current.bases) !== JSON.stringify(settings.bases)
    )
      return { enabled: false, evidence: [] };
    return {
      enabled: result.enabled === true,
      evidence: parseEvidence(result.evidence),
    };
  }
}
export function parseSettings(input: unknown): KnowledgeSettings {
  const data = record(input);
  if (
    typeof data.enabled !== "boolean" ||
    typeof data.serviceAvailable !== "boolean" ||
    typeof data.maxBases !== "number" ||
    !Array.isArray(data.bases)
  )
    throw new KnowledgeError("知识库服务返回格式无效", 502);
  return {
    authenticated: data.authenticated === true,
    enabled: data.enabled,
    serviceAvailable: data.serviceAvailable,
    maxBases: Math.max(0, Math.floor(data.maxBases)),
    bases: data.bases.map((value) => {
      const base = record(value);
      return {
        id: text(base.id),
        name: text(base.name),
        selected: base.selected === true,
        ...(typeof base.shared === "boolean" ? { shared: base.shared } : {}),
        ...(typeof base.sharedByMe === "boolean" ? { sharedByMe: base.sharedByMe } : {}),
        ...(typeof base.ownerName === "string" && base.ownerName ? { ownerName: base.ownerName } : {}),
        ...(typeof base.memberCount === "number" && Number.isFinite(base.memberCount) ? { memberCount: Math.max(0, Math.floor(base.memberCount)) } : {}),
      };
    }),
  };
}
export function parseEvidence(input: unknown): KnowledgeEvidence[] {
  if (!Array.isArray(input))
    throw new KnowledgeError("知识库检索结果格式无效", 502);
  return input
    .slice(0, 8)
    .map((value) => {
      const item = record(value);
      return {
        id: text(item.id).slice(0, 200),
        title: text(item.title).slice(0, 250),
        content: text(item.content).slice(0, 3000),
      };
    })
    .filter((item) => item.content.trim());
}
