/** Model config tester tests. */
import type { ModelEndpointProtocol } from "@memmy/local-api-contracts";
import { describe, expect, it, vi } from "vitest";
import { createHttpModelConfigTester, DEFAULT_PROBE_TIMEOUT_MS, type ResolvedModelConfigTestInput } from "../model-config-tester.js";

const checkedAt = "2026-06-05T10:00:00.000Z";
const completion = { choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] };
const message = { type: "message", role: "assistant", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" };

describe("model config tester", () => {
  it("keeps a bounded network timeout", () => expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(60_000));

  it.each(["openai_compatible", "deepseek", "zhipu", "qwen", "kimi", "minimax", "baidu", "custom"] as const)(
    "tests the selected %s chat model once with a bounded request", async provider => {
      const fetch = vi.fn(async () => json(completion));
      const result = await createHttpModelConfigTester({ fetch, now: () => checkedAt }).test(input({ provider }));
      expect(result).toEqual({ ok: true, message: "连接成功", checkedAt });
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = (fetch.mock.calls as unknown as [string, RequestInit][])[0]!;
      expect(url).toBe("https://endpoint.example/plan/v3/chat/completions");
      expect(init).toMatchObject({ method: "POST", headers: { Authorization: "Bearer sk-secret", "Content-Type": "application/json" } });
      expect(JSON.parse(String(init.body))).toEqual({ model: "deepseek/deepseek-flash", messages: [{ role: "user", content: "Reply briefly with OK." }], stream: false, max_tokens: 64 });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

  it.each(["gpt-5", "vendor/gpt-5-mini", "o3", "o4-mini"])("uses the modern token limit for %s", async modelId => {
    const fetch = vi.fn(async () => json(completion));
    await createHttpModelConfigTester({ fetch }).test(input({ modelId, provider: "custom" }));
    const body = JSON.parse(String((fetch.mock.calls as unknown as [string, RequestInit][])[0]![1].body));
    expect(body.max_completion_tokens).toBe(64);
    expect(body.max_tokens).toBeUndefined();
  });

  it.each(["https://endpoint.example/plan/anthropic", "https://endpoint.example/plan/anthropic/v1/"])(
    "uses Anthropic messages with the selected base %s", async apiBase => {
      const fetch = vi.fn(async () => json(message));
      const result = await createHttpModelConfigTester({ fetch }).test(input({ protocol: "anthropic-messages", apiBase }));
      expect(result.ok).toBe(true);
      const [url, init] = (fetch.mock.calls as unknown as [string, RequestInit][])[0]!;
      expect(url).toBe("https://endpoint.example/plan/anthropic/v1/messages");
      expect(init).toMatchObject({ method: "POST", headers: { "x-api-key": "sk-secret", "anthropic-version": "2023-06-01" } });
      expect(JSON.parse(String(init.body))).toMatchObject({ model: "deepseek/deepseek-flash", max_tokens: 64, stream: false });
    });

  it.each([
    { data: [{ id: "deepseek/deepseek-flash" }] }, {}, { choices: [] },
    { choices: [{ message: { role: "user", content: "OK" } }] },
    { choices: [{ message: { role: "assistant", content: null }, finish_reason: "stop" }] }
  ])("does not accept a list or malformed response as a chat success: %j", async body => {
    const result = await createHttpModelConfigTester({ fetch: async () => json(body) }).test(input());
    expect(result.ok).toBe(false);
    expect(result.message).toContain("有效的聊天响应");
  });

  it("accepts a valid token-limited reasoning response without visible output", async () => {
    const result = await createHttpModelConfigTester({ fetch: async () => json({ choices: [{ message: { role: "assistant", content: null }, finish_reason: "length" }] }) }).test(input());
    expect(result.ok).toBe(true);
  });

  it.each([{ data: [] }, { type: "message", role: "assistant", content: [] }, { type: "error", error: { message: "invalid model" } }])(
    "rejects invalid Anthropic responses: %j", async body => {
      expect((await createHttpModelConfigTester({ fetch: async () => json(body) }).test(input({ protocol: "anthropic-messages" }))).ok).toBe(false);
    });

  it.each([401, 403, 404, 429, 500])("reports HTTP %s without retries, list fallback or secrets", async status => {
    const fetch = vi.fn(async () => json({ error: { message: "bad sk-secret extra-secret" } }, status));
    const result = await createHttpModelConfigTester({ fetch }).test(input({ extraHeaders: { "X-Token": "extra-secret" } }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain(`HTTP ${status}`);
    expect(result.message).not.toContain("sk-secret");
    expect(result.message).not.toContain("extra-secret");
    expect(result.message).not.toContain("通常以 /v1");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports plain text 404 without inventing an invalid key", async () => {
    const result = await createHttpModelConfigTester({ fetch: async () => new Response("404 page not found", { status: 404 }) }).test(input());
    expect(result.message).toContain("未找到聊天接口或模型");
    expect(result.message).not.toContain("API Key 无效");
  });

  it("rejects an HTTP 200 provider error", async () => {
    expect((await createHttpModelConfigTester({ fetch: async () => json({ error: { message: "invalid model" } }) }).test(input())).ok).toBe(false);
  });

  it("supports header-only credentials and case-insensitive overrides", async () => {
    const fetch = vi.fn(async () => json(message));
    await createHttpModelConfigTester({ fetch }).test(input({ apiKey: "", protocol: "anthropic-messages", extraHeaders: { Authorization: "Bearer custom-token", "Anthropic-Version": "custom-version" } }));
    const headers = (fetch.mock.calls as unknown as [string, RequestInit][])[0]![1].headers;
    expect(headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer custom-token", "Anthropic-Version": "custom-version" });
  });

  it("normalizes timeout errors and redacts thrown credential values", async () => {
    const timeout = await createHttpModelConfigTester({ fetch: async () => { throw new DOMException("timeout sk-secret", "TimeoutError"); } }).test(input());
    expect(timeout).toMatchObject({ ok: false, message: "连接超时，请检查 API 地址或网络" });
    const thrown = await createHttpModelConfigTester({ fetch: async () => { throw new Error("network sk-secret"); } }).test(input());
    expect(thrown.message).toBe("network [redacted]");
  });

  it.each([
    ["openai-embeddings", "embedding"], ["openai-images", "image"],
    ["openai-chat-completions", "asr"], ["openai-chat-completions", "image"],
    ["openai-responses", "chat"]
  ] as const)("preserves GET model listing for %s / %s", async (protocol, capability) => {
    const fetch = vi.fn(async () => json({ data: [{ id: "another-model" }] }));
    const result = await createHttpModelConfigTester({ fetch }).test(input({ protocol, capability }));
    expect(result).toMatchObject({ ok: true, modelListed: false });
    const [url, init] = (fetch.mock.calls as unknown as [string, RequestInit][])[0]!;
    expect(url).toBe("https://endpoint.example/plan/v3/models");
    expect(init.method).toBe("GET"); expect(init.body).toBeUndefined();
  });

  it("preserves the Gemini list protocol and model name matching", async () => {
    const fetch = vi.fn(async () => json({ models: [{ name: "models/gemini-test" }] }));
    const result = await createHttpModelConfigTester({ fetch }).test(input({ protocol: "gemini-generate-content", apiBase: "https://google.example/v1beta/", modelId: "gemini-test" }));
    expect(result).toMatchObject({ ok: true, modelListed: true });
    expect((fetch.mock.calls as unknown as [string, RequestInit][])[0]![0]).toBe("https://google.example/v1beta/models");
  });

  it("still rejects malformed lists for other capabilities", async () => {
    expect((await createHttpModelConfigTester({ fetch: async () => json(completion) }).test(input({ protocol: "openai-embeddings", capability: "embedding" }))).ok).toBe(false);
  });

  it.each(["dashscope-input-audio-chat", "dashscope-multimodal-generation", "memmy-account", "bedrock-converse"] as ModelEndpointProtocol[])(
    "keeps unsupported protocol %s free of requests", async protocol => {
      const fetch = vi.fn();
      expect((await createHttpModelConfigTester({ fetch }).test(input({ protocol }))).ok).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });
});

function input(overrides: Partial<ResolvedModelConfigTestInput> = {}): ResolvedModelConfigTestInput {
  return { provider: "openai_compatible", endpointId: "chat-a", protocol: "openai-chat-completions", apiBase: "https://endpoint.example/plan/v3", modelId: "deepseek/deepseek-flash", apiKey: "sk-secret", capability: "chat", ...overrides };
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
