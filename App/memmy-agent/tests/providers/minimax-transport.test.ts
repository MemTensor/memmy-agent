import { afterEach, describe, expect, it, vi } from "vitest";
import { Config } from "../../src/config/schema.js";
import { makeProvider } from "../../src/providers/factory.js";
import { AnthropicProvider } from "../../src/providers/anthropic-provider.js";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";
import { findByName } from "../../src/providers/registry.js";
import { getModelTokenDefaults } from "../../src/providers/model-token-defaults.js";

const flash = "MiniMax-M3.1-Flash";
const efforts = [undefined, "none", "minimal", "minimum", "low", "medium", "high", "xhigh", "max", "adaptive"];
const expectedEffort = (effort: string | undefined) =>
  ["none", "minimal", "minimum"].includes(effort ?? "") ? "low" : !effort || effort === "adaptive" ? "max" : effort;

afterEach(() => vi.unstubAllGlobals());

function captureRequest(anthropic: boolean) {
  const requests: Array<{ url: string; body: any }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, body: await request.json() });
    return new Response(JSON.stringify(anthropic
      ? { id: "message", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }
      : { id: "completion", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    { headers: { "content-type": "application/json" } });
  }));
  return requests;
}

describe("MiniMax serialized requests", () => {
  it("sends the configured default through the provider factory without a per-request model override", async () => {
    const requests = captureRequest(false);
    const provider = makeProvider(new Config({
      agents: { defaults: { provider: "minimax", model: flash } },
      providers: { minimax: { apiKey: "test-key", endpoints: { chat: { apiBase: "https://api.minimax.io/v1", protocol: "openai-chat-completions" } } } }
    }));
    await provider.chat({ messages: [{ role: "user", content: "hello" }], maxTokens: 256 });
    expect(requests[0].body).toMatchObject({ model: flash, thinking: { type: "adaptive" }, reasoning_effort: "max" });
  });

  it.each([undefined, "medium", "none"])("preserves M3 Anthropic thinking preference %s without effort", async (reasoningEffort) => {
    const requests = captureRequest(true);
    const provider = new AnthropicProvider({ apiKey: "test-key", apiBase: "https://api.minimax.cn/anthropic", defaultModel: "MiniMax-M3" });
    await provider.chat({ messages: [{ role: "user", content: "hello" }], reasoningEffort, maxTokens: 256 });
    expect(requests[0].body.model).toBe("MiniMax-M3");
    expect(requests[0].body).not.toHaveProperty("output_config");
    if (!reasoningEffort) expect(requests[0].body).not.toHaveProperty("thinking");
    else expect(requests[0].body.thinking).toEqual({ type: reasoningEffort === "none" ? "disabled" : "adaptive" });
  });

  it("uses exact Flash token limits", () => {
    expect(getModelTokenDefaults(flash)).toEqual({ contextWindowTokens: 1_000_000, maxTokens: 524_288 });
  });

  for (const host of ["api.minimax.io", "api.minimax.cn", "api.minimaxi.com"]) {
    it.each(efforts)(`serializes Flash chat effort %s at ${host}`, async (reasoningEffort) => {
      const requests = captureRequest(false);
      const provider = new OpenAICompatProvider({ apiKey: "test-key", apiBase: `https://${host}/v1`, defaultModel: flash, spec: findByName("minimax") });
      const messages = [
        { role: "assistant", content: "previous", reasoning_content: "retained reasoning", tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "result" },
        { role: "user", content: [{ type: "text", text: "describe" }, { type: "image_url", image_url: { url: "https://example.test/image.png" } }, { type: "video_url", video_url: { url: "mm_file://video" } }] }
      ];
      const result = await provider.chat({ messages, reasoningEffort, maxTokens: 256 });
      expect(result.content).toBe("ok");
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe(`https://${host}/v1/chat/completions`);
      expect(requests[0].body).toMatchObject({ model: flash, thinking: { type: "adaptive" }, reasoning_effort: expectedEffort(reasoningEffort), messages });
      expect(requests[0].body).not.toHaveProperty("extra_body");
      expect(requests[0].body).not.toHaveProperty("reasoning_split");
      expect(requests[0].body).not.toHaveProperty("service_tier");
    });

    it.each(efforts)(`serializes Flash messages effort %s at ${host}`, async (reasoningEffort) => {
      const requests = captureRequest(true);
      const provider = new AnthropicProvider({ apiKey: "test-key", apiBase: `https://${host}/anthropic`, defaultModel: flash, spec: findByName("minimax_anthropic") });
      const result = await provider.chat({ messages: [{ role: "user", content: "hello" }], reasoningEffort, maxTokens: 256 });
      expect(result.content).toBe("ok");
      expect(requests[0].url).toBe(`https://${host}/anthropic/v1/messages`);
      expect(requests[0].body).toMatchObject({ model: flash, thinking: { type: "adaptive" }, output_config: { effort: expectedEffort(reasoningEffort) }, max_tokens: 256 });
      expect(requests[0].body.thinking).not.toHaveProperty("budget_tokens");
      expect(requests[0].body).not.toHaveProperty("service_tier");
    });
  }

  it.each([false, true])("streams Flash with adaptive thinking (Anthropic: %s)", async (anthropic) => {
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      body = await new Request(input, init).json();
      const events: Array<Record<string, unknown>> = anthropic
        ? [
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
          { type: "message_delta", delta: { stop_reason: "end_turn" } },
          { type: "message_stop" }
        ]
        : [{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }];
      const sse = events.map((event) => `${anthropic ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("");
      return new Response(sse + (anthropic ? "" : "data: [DONE]\n\n"), { headers: { "content-type": "text/event-stream" } });
    }));
    const provider = anthropic
      ? new AnthropicProvider({ apiKey: "test-key", apiBase: "https://api.minimax.io/anthropic", defaultModel: flash })
      : new OpenAICompatProvider({ apiKey: "test-key", apiBase: "https://api.minimax.io/v1", defaultModel: flash, spec: findByName("minimax") });
    const result = await provider.chatStream({ messages: [{ role: "user", content: "hello" }], maxTokens: 256 });
    expect(result.content).toBe("ok");
    expect(body).toMatchObject({ model: flash, stream: true, thinking: { type: "adaptive" } });
    expect(body).toMatchObject(anthropic ? { output_config: { effort: "max" } } : { reasoning_effort: "max" });
  });

  it("preserves Anthropic thinking signatures, tool history, images and video blocks", async () => {
    const requests = captureRequest(true);
    const provider = new AnthropicProvider({ apiKey: "test-key", apiBase: "https://api.minimax.io/anthropic", defaultModel: flash, spec: findByName("minimax_anthropic") });
    const thinking = { type: "thinking", thinking: "previous reasoning", signature: "retained-signature" };
    const video = { type: "video", source: { type: "url", url: "mm_file://video" } };
    await provider.chat({ messages: [
      { role: "assistant", content: "looking up", thinking_blocks: [thinking], tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "result" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/image.png" } }, video] }
    ], maxTokens: 256 });
    const messages = requests[0].body.messages;
    expect(messages[0].content).toContainEqual(thinking);
    expect(messages[0].content).toContainEqual({ type: "tool_use", id: "call_1", name: "lookup", input: {} });
    expect(messages[1].content).toContainEqual({ type: "tool_result", tool_use_id: "call_1", content: "result" });
    expect(messages[1].content).toContainEqual({ type: "image", source: { type: "url", url: "https://example.test/image.png" } });
    expect(messages[1].content).toContainEqual(video);
  });

  it.each(["MiniMax-M3", "MiniMax-M2.7", "my-custom-model"])("preserves saved model %s and custom endpoint", async (model) => {
    const requests = captureRequest(false);
    const provider = new OpenAICompatProvider({ apiKey: "test-key", apiBase: "https://custom.example/v1", defaultModel: model, spec: findByName("minimax"), extraBody: { custom_option: true } });
    await provider.chat({ messages: [{ role: "user", content: "hello" }], reasoningEffort: "none" });
    expect(requests[0].url).toBe("https://custom.example/v1/chat/completions");
    expect(requests[0].body).toMatchObject({ model, custom_option: true });
    if (model === "MiniMax-M3") {
      expect(requests[0].body.thinking).toEqual({ type: "disabled" });
      expect(requests[0].body).not.toHaveProperty("reasoning_effort");
    }
  });
});
