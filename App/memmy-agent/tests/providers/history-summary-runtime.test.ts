import { afterEach, describe, expect, it, vi } from "vitest";
import { FallbackProvider } from "../../src/providers/fallback-provider.js";
import { historySummaryRuntime } from "../../src/providers/history-summary-runtime.js";
import type { ResolvedModelSelection } from "../../src/providers/model-catalog.js";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";
import { LLMResponse } from "../../src/providers/base.js";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function usageOptions() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "history-runtime-billing-"));
  directories.push(dir);
  const runtimeConfigPath = path.join(dir, "runtime.json");
  fs.writeFileSync(runtimeConfigPath, JSON.stringify({ baseUrl: "http://127.0.0.1:62934", localToken: "fixture-only" }));
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => new Response(JSON.stringify(init?.method === "POST"
    ? { ok: true }
    : { dailyLimitM: 10, totalLimitM: 500, dailyUsed: 0, lifetimeUsed: 0, paused: false, trigger: null,
      nextLocalMidnightAt: "2026-10-14T00:00:00.000Z" }), { status: 200 }));
  return { runtimeConfigPath, fetchImpl, dir };
}

function selection(provider: OpenAICompatProvider, overrides: Record<string, unknown> = {}): ResolvedModelSelection {
  return {
    presetId: "summary", provider: "memmy_account", source: "account", capability: "memory_summary",
    snapshot: { provider, model: "memory_summary" },
    providerConfig: { apiBase: "https://cloud.example/api/agentExternal/v1" },
    ...overrides,
  } as unknown as ResolvedModelSelection;
}

describe("History summary runtime", () => {
  it("bypasses BYOK accounting and budget for official account summaries", async () => {
    const options = usageOptions();
    const provider = new OpenAICompatProvider({ apiBase: "https://cloud.example/api/agentExternal/v1" });
    const chat = vi.spyOn(provider, "chat").mockResolvedValue(new LLMResponse({ content: "official", usage: { prompt_tokens: 10 } }));
    const runtime = historySummaryRuntime(selection(provider), options)();
    await runtime.provider.chatWithRetry({ messages: [{ role: "user", content: "fixture text" }] });
    expect(runtime.provider).toBe(provider);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(options.fetchImpl).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(options.dir, "history-summary-usage"))).toBe(false);
  });

  it("wraps each actual BYOK retry with summary accounting and a fresh budget check", async () => {
    vi.useFakeTimers();
    const options = usageOptions();
    const provider = new OpenAICompatProvider({ apiBase: "https://custom.example/v1", defaultModel: "small-summary" });
    const chat = vi.spyOn(provider, "chat")
      .mockResolvedValueOnce(new LLMResponse({ content: "overloaded", finishReason: "error", errorStatusCode: 503, usage: { prompt_tokens: 7 } }))
      .mockResolvedValueOnce(new LLMResponse({ content: "success", usage: { prompt_tokens: 10, completion_tokens: 3 } }));
    const runtime = historySummaryRuntime(selection(provider, { provider: "openai", source: "byok",
      providerConfig: { apiBase: "https://custom.example/v1" }, snapshot: { provider, model: "small-summary" } }), options)();
    const pending = runtime.provider.chatWithRetry({ messages: [{ role: "user", content: "fixture text" }] });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ content: "success" });
    expect(chat).toHaveBeenCalledTimes(2);
    const events = options.fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body)));
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.totalTokens)).toEqual([7, 13]);
    expect(events[0]).toMatchObject({ kind: "memory_summary", source: "memory", model: "small-summary", capability: "memory_summary" });
    expect(events[1].id).not.toBe(events[0].id);
    expect(options.fetchImpl.mock.calls.filter(([, init]) => init?.method !== "POST")).toHaveLength(2);
  });

  it("returns a non-retryable failure when the budget service is unavailable", async () => {
    const options = usageOptions();
    options.fetchImpl.mockRejectedValue(new Error("local service down"));
    const provider = new OpenAICompatProvider({ apiBase: "https://custom.example/v1" });
    const chat = vi.spyOn(provider, "chat");
    const runtime = historySummaryRuntime(selection(provider, { provider: "openai", source: "byok",
      providerConfig: { apiBase: "https://custom.example/v1" } }), options)();
    await expect(runtime.provider.chatWithRetry({ messages: [{ role: "user", content: "fixture text" }] }))
      .resolves.toMatchObject({ finishReason: "error", errorShouldRetry: false, content: "history_summary_budget_unavailable" });
    expect(chat).not.toHaveBeenCalled();
    expect(options.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("disables both official thinking controls while preserving unrelated configuration", () => {
    const provider = new OpenAICompatProvider({ apiBase: "https://cloud.example/api/agentExternal/v1",
      defaultModel: "memory_summary", spec: { name: "memmy_account" },
      extraBody: { enable_thinking: true, thinking: { type: "enabled" }, accountFlag: true } });
    const original = provider.extraBody;
    const runtime = historySummaryRuntime(selection(provider))();
    expect(runtime.model).toBe("memory_summary");
    const args = provider.buildKwargs({ messages: [{ role: "user", content: "Text evidence" }],
      model: runtime.model, tools: null, maxTokens: 1800, temperature: 0.3, reasoningEffort: "none" });
    expect(args.extra_body).toEqual({ enable_thinking: false, thinking: { type: "disabled" }, accountFlag: true });
    expect(original.enable_thinking).toBe(true);
    expect(args.messages[0].content).toBe("Text evidence");
    expect(args.tools).toBeUndefined();
  });

  it("recognizes a configured official gateway under an alternate provider name", () => {
    vi.stubEnv("MEMMY_CLOUD_SERVICE", "https://cloud.example");
    const provider = new OpenAICompatProvider({ apiBase: "https://cloud.example/api/agentExternal/v1" });
    historySummaryRuntime(selection(provider, { provider: "openai" }));
    expect(provider.extraBody).toEqual({ enable_thinking: false, thinking: { type: "disabled" } });
  });

  it.each([
    "https://third-party.example/api/agentExternal/v1",
    "https://cloud.example/v1?next=/api/agentExternal/v1",
    "not-a-url",
  ])("does not inject official fields into a different BYOK endpoint: %s", (apiBase) => {
    vi.stubEnv("MEMMY_CLOUD_SERVICE", "https://cloud.example");
    const provider = new OpenAICompatProvider({ apiBase: "https://third-party.example/v1",
      extraBody: { vendorFlag: true } });
    const original = provider.extraBody;
    historySummaryRuntime(selection(provider, { provider: "openai", source: "byok", providerConfig: { apiBase } }));
    expect(provider.extraBody).toBe(original);
    expect(provider.extraBody).toEqual({ vendorFlag: true });
  });

  it("retains non-official BYOK provider configuration", () => {
    const provider = new OpenAICompatProvider({ apiBase: "https://custom.example/v1",
      defaultModel: "small-summary", extraBody: { vendorFlag: true } });
    const original = provider.extraBody;
    const runtime = historySummaryRuntime(selection(provider, { provider: "openai", source: "byok",
      providerConfig: { apiBase: "https://custom.example/v1" }, snapshot: { provider, model: "small-summary" } }))();
    expect(runtime.model).toBe("small-summary");
    expect(provider.extraBody).toBe(original);
    expect(provider.extraBody).toEqual({ vendorFlag: true });
  });

  it("refuses Agent choices and fallback wrappers", () => {
    const provider = new OpenAICompatProvider({ apiBase: "https://custom.example/v1" });
    expect(() => historySummaryRuntime(selection(provider, { capability: "agent" }))).toThrow("summary_model_selection_unavailable");
    const fallback = new FallbackProvider([provider, provider]);
    expect(() => historySummaryRuntime(selection(provider, { snapshot: { provider: fallback, model: "summary" } })))
      .toThrow("summary_model_selection_unavailable");
  });
});
