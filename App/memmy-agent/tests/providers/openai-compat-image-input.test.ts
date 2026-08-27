import { describe, expect, it, vi } from "vitest";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";
import { findByName } from "../../src/providers/registry.js";

function imageMessages(): Record<string, any>[] {
  return [{
    role: "user",
    content: [
      { type: "text", text: "describe this" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
    ],
  }];
}

describe("OpenAI-compatible image input", () => {
  it.each(["chat", "chatStream"] as const)(
    "fails DeepSeek %s before creating an SDK client",
    async (method) => {
      const provider = new OpenAICompatProvider({
        apiKey: "deepseek-key",
        defaultModel: "deepseek-chat",
        spec: findByName("deepseek"),
      });
      const ensureClient = vi.spyOn(provider, "ensureClient");

      const response = await provider[method]({ messages: imageMessages() });

      expect(response).toMatchObject({
        finishReason: "error",
        errorStatusCode: 400,
        errorCategory: "image_input_unsupported",
        errorShouldRetry: false,
      });
      expect(ensureClient).not.toHaveBeenCalled();
    },
  );

  it("keeps DeepSeek text requests unchanged", async () => {
    const create = vi.fn(async () => ({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    }));
    const provider = new OpenAICompatProvider({
      apiKey: "deepseek-key",
      defaultModel: "deepseek-chat",
      spec: findByName("deepseek"),
    });
    provider.client = { chat: { completions: { create } }, responses: { create: vi.fn() } };

    const response = await provider.chat({ messages: [{ role: "user", content: "hello" }] });

    expect(response.content).toBe("ok");
    expect(create).toHaveBeenCalledOnce();
  });

  it("sends image blocks to the exact DeepSeek experimental vision model", async () => {
    const create = vi.fn(async () => ({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    }));
    const provider = new OpenAICompatProvider({
      apiKey: "deepseek-key",
      defaultModel: "deepseek-v4-flash-vision-exp",
      spec: findByName("deepseek"),
    });
    provider.client = { chat: { completions: { create } }, responses: { create: vi.fn() } };

    const response = await provider.chat({ messages: imageMessages() });

    expect(response.content).toBe("ok");
    const [body] = create.mock.calls[0] as unknown as [Record<string, any>];
    expect(body.messages[0].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "image_url" }),
    ]));
  });

  it("still sends image blocks for other OpenAI-compatible providers", async () => {
    const create = vi.fn(async () => ({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    }));
    const provider = new OpenAICompatProvider({
      apiKey: "custom-key",
      apiBase: "https://custom.example.test/v1",
      defaultModel: "vision-model",
    });
    provider.client = { chat: { completions: { create } }, responses: { create: vi.fn() } };

    const response = await provider.chat({ messages: imageMessages() });

    expect(response.content).toBe("ok");
    const [body] = create.mock.calls[0] as unknown as [Record<string, any>];
    expect(body.messages[0].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "image_url" }),
    ]));
  });
});
