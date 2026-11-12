import { describe, expect, it, vi } from "vitest";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";

describe("account task routing transport", () => {
  it.each([false, true])("keeps task headers request-local, streaming=%s", async streaming => {
    const create = vi.fn(async (..._args: any[]) => streaming
      ? (async function* () { yield { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }; })()
      : { model: "review-test-model", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    const provider = new OpenAICompatProvider({ apiKey: "test", apiBase: "https://example.test/v1",
      apiType: "chatCompletions", spec: { name: "memmy_account", envKey: "" } });
    (provider as any).client = { chat: { completions: { create } } };
    const signal = new AbortController().signal;
    const invoke = (args: any) => streaming ? provider.chatStream(args) : provider.chat(args);
    const messages = [{ role: "user", content: "write" }];
    expect((await invoke({ messages, model: "agent_chat", taskType: "literature-review", signal })).finishReason).not.toBe("error");
    expect(create.mock.calls[0][1]).toEqual({ signal, headers: { "X-Agent-Task": "literature-review" } });
    expect(create.mock.calls[0][0]).not.toHaveProperty("taskType");
    await invoke({ messages, model: "agent_chat" });
    expect(create.mock.calls[1]).toHaveLength(1);
    await invoke({ messages, model: "qwen3.8-flash", taskType: "literature-review" });
    expect(create.mock.calls[2]).toHaveLength(1);
    expect(provider.defaultHeaders).not.toHaveProperty("X-Agent-Task");
  });

  it("never sends task metadata to a BYOK provider", async () => {
    const create = vi.fn(async (..._args: any[]) => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    const provider = new OpenAICompatProvider({ apiKey: "test", apiBase: "https://example.test/v1",
      apiType: "chatCompletions", spec: { name: "openai", envKey: "" } });
    (provider as any).client = { chat: { completions: { create } } };
    await provider.chat({ messages: [{ role: "user", content: "write" }], model: "agent_chat", taskType: "literature-review" });
    expect(create.mock.calls[0]).toHaveLength(1);
  });
});
