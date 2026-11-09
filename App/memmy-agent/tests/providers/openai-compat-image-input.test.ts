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
    "lets the Provider reject unknown DeepSeek image capability in %s",
    async (method) => {
      const provider = new OpenAICompatProvider({
        apiKey: "deepseek-key",
        defaultModel: "deepseek-chat",
        spec: findByName("deepseek"),
      });
      const create = vi.fn(async (_body: Record<string, any>) => {
        throw Object.assign(new Error("image_url is not supported"), { status: 400 });
      });
      provider.client = { chat: { completions: { create } }, responses: { create } };

      const response = await provider[method]({ messages: imageMessages() });

      expect(response).toMatchObject({
        finishReason: "error",
        errorStatusCode: 400,
      });
      expect(create).toHaveBeenCalled();
      expect(JSON.stringify(create.mock.calls[0][0])).toMatch(/image_url|input_image/u);
    },
  );

  it("sends DeepSeek text requests through Responses by default", async () => {
    const create = vi.fn(async () => ({
      status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
    }));
    const provider = new OpenAICompatProvider({
      apiKey: "deepseek-key",
      defaultModel: "deepseek-chat",
      spec: findByName("deepseek"),
    });
    provider.client = { chat: { completions: { create: vi.fn() } }, responses: { create } };

    const response = await provider.chat({ messages: [{ role: "user", content: "hello" }] });

    expect(response.content).toBe("ok");
    expect(create).toHaveBeenCalledOnce();
  });

  it.each([
    "deepseek-flash",
    "deepseek-v4.1-flash",
    "deepseek-v4.1-flash-1017",
    "deepseek-v4-flash-vision-exp",
  ])("sends image blocks to DeepSeek vision model %s", async (model) => {
    const create = vi.fn(async () => ({
      status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
    }));
    const provider = new OpenAICompatProvider({
      apiKey: "deepseek-key",
      defaultModel: model,
      spec: findByName("deepseek"),
    });
    provider.client = { chat: { completions: { create: vi.fn() } }, responses: { create } };

    const response = await provider.chat({ messages: imageMessages() });

    expect(response.content).toBe("ok");
    const [body] = create.mock.calls[0] as unknown as [Record<string, any>];
    expect(body.input[0].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "input_image", image_url: "data:image/png;base64,abc" }),
    ]));
  });

  it("still sends image blocks for other OpenAI-compatible providers", async () => {
    const create = vi.fn(async () => ({
      status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
    }));
    const provider = new OpenAICompatProvider({
      apiKey: "custom-key",
      apiBase: "https://custom.example.test/v1",
      defaultModel: "vision-model",
    });
    provider.client = { chat: { completions: { create: vi.fn() } }, responses: { create } };

    const response = await provider.chat({ messages: imageMessages() });

    expect(response.content).toBe("ok");
    const [body] = create.mock.calls[0] as unknown as [Record<string, any>];
    expect(body.input[0].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "input_image", image_url: "data:image/png;base64,abc" }),
    ]));
  });
});
