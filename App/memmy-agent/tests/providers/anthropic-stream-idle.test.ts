import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic-provider.js";
import { LLMProvider, LLMResponse } from "../../src/providers/base.js";
import { FallbackProvider } from "../../src/providers/fallback-provider.js";

class FakeProvider extends LLMProvider {
  calls = 0;
  constructor(private readonly response: LLMResponse) {
    super();
  }
  getDefaultModel(): string {
    return "fake";
  }
  async chat(): Promise<LLMResponse> {
    this.calls += 1;
    return this.response;
  }
  override async chatStream(args: any): Promise<LLMResponse> {
    this.calls += 1;
    await args.onContentDelta?.("partial");
    return this.response;
  }
}

function stubAnthropicStream(provider: AnthropicProvider, events: Record<string, any>[]): void {
  async function* stream(): AsyncGenerator<Record<string, any>> {
    for (const event of events) yield event;
  }
  (provider as any).client = {
    messages: {
      create: vi.fn(async () => stream()),
    },
  };
}

describe("Anthropic stream idle fallback guard", () => {
  it("does not fallback after a stream has already emitted content", async () => {
    const primary = new FakeProvider(new LLMResponse({ content: "timeout", finishReason: "error", errorKind: "timeout" }));
    const fallback = new FakeProvider(new LLMResponse({ content: "ok" }));
    const provider = new FallbackProvider({
      primary,
      fallbackPresets: [{ model: "fallback" }],
      providerFactory: () => fallback,
    });
    const deltas: string[] = [];

    const result = await provider.chatStream({
      messages: [{ role: "user", content: "hi" }],
      onContentDelta: (delta: string) => deltas.push(delta),
    });

    expect(result.finishReason).toBe("error");
    expect(deltas).toEqual(["partial"]);
    expect(fallback.calls).toBe(0);
  });

  it("calls onContentDelta only for text deltas", async () => {
    const provider = new AnthropicProvider({ apiKey: "sk-test" });
    stubAnthropicStream(provider, [
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 3, output_tokens: 2 } },
    ]);
    const out: string[] = [];

    const result = await provider.chatStream({
      messages: [{ role: "user", content: "hello" }],
      onContentDelta: (delta: string) => {
        out.push(delta);
      },
    });

    expect(out).toEqual(["Hi"]);
    expect(result.content).toBe("Hi");
  });

  it("invokes onThinkingDelta for thinking deltas", async () => {
    const provider = new AnthropicProvider({ apiKey: "sk-test" });
    stubAnthropicStream(provider, [
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "a" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "b" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "X" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 3, output_tokens: 2 } },
    ]);
    const thinkingParts: string[] = [];
    const textParts: string[] = [];

    await provider.chatStream({
      messages: [{ role: "user", content: "hello" }],
      onContentDelta: (delta: string) => {
        textParts.push(delta);
      },
      onThinkingDelta: (delta: string) => {
        thinkingParts.push(delta);
      },
    });

    expect(thinkingParts).toEqual(["a", "b"]);
    expect(textParts).toEqual(["X"]);
  });

  it("invokes onToolCallDelta for input JSON deltas", async () => {
    const provider = new AnthropicProvider({ apiKey: "sk-test" });
    stubAnthropicStream(provider, [
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "write_file" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"notes.md","content":"' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "line\\n" } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 3, output_tokens: 2 } },
    ]);
    const deltas: Record<string, any>[] = [];

    const result = await provider.chatStream({
      messages: [{ role: "user", content: "write" }],
      onToolCallDelta: (delta: Record<string, any>) => {
        deltas.push(delta);
      },
    });

    expect(deltas).toEqual([
      { index: 1, call_id: "toolu_1", name: "write_file", arguments_delta: "" },
      { index: 1, call_id: "toolu_1", name: "write_file", arguments_delta: '{"path":"notes.md","content":"' },
      { index: 1, call_id: "toolu_1", name: "write_file", arguments_delta: "line\\n" },
    ]);
    expect(result.toolCalls[0]).toMatchObject({ id: "toolu_1", name: "write_file" });
  });

  it("finalizes stream responses even when no callbacks are supplied", async () => {
    const provider = new AnthropicProvider({ apiKey: "sk-test" });
    stubAnthropicStream(provider, [
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 3, output_tokens: 2 } },
    ]);

    const result = await provider.chatStream({
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.content).toBe("ok");
    expect(result.finishReason).toBe("stop");
  });
});
