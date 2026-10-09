import { describe, expect, it } from "vitest";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { LLMProvider, LLMResponse } from "../../../src/providers/base.js";

function imageMessage() {
  return {
    role: "user",
    content: [
      { type: "text", text: "What is shown?" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,one" },
        meta: { path: "/media/one.png" },
      },
    ],
  };
}

function byokContext(model: string) {
  return {
    presetId: "custom",
    provider: "custom",
    endpointId: "chat",
    protocol: "openai-chat-completions" as const,
    model,
    source: "byok" as const,
    ownerAccountId: null,
    capability: "agent" as const,
    capabilities: ["agent" as const],
  };
}

function accountContext(model: string) {
  return { ...byokContext(model), presetId: "account-default", provider: "memmy_account", source: "account" as const, ownerAccountId: "account-1" };
}

class ByokProvider extends LLMProvider {
  calls: any[] = [];

  constructor(private readonly responses: LLMResponse[] = []) {
    super();
  }

  getDefaultModel(): string {
    return "Qwen3-27B";
  }

  supportsAccountImageTextFallback(): boolean {
    return false;
  }

  async chat(args: any): Promise<LLMResponse> {
    this.calls.push(args);
    return this.responses.shift() ?? new LLMResponse({ content: "described the image" });
  }
}

describe("BYOK custom model image input", () => {
  it("sends images to a BYOK model that is absent from the built-in capability catalog", async () => {
    const provider = new ByokProvider();

    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      initialMessages: [imageMessage()],
      provider,
      model: "Qwen3-27B",
      actualModelContext: byokContext("Qwen3-27B"),
    }));

    expect(result.finalContent).toBe("described the image");
    expect(provider.calls).toHaveLength(1);
    expect(JSON.stringify(provider.calls[0].messages)).toContain('"type":"image_url"');
  });

  it("surfaces the provider's own rejection when the BYOK model really cannot read images", async () => {
    const provider = new ByokProvider([
      new LLMResponse({
        content: "Invalid type for 'messages[0].content[1]': image_url is not supported",
        finishReason: "error",
        errorStatusCode: 400,
      }),
    ]);

    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      initialMessages: [imageMessage()],
      provider,
      model: "some-text-only-model",
      actualModelContext: byokContext("some-text-only-model"),
    }));

    expect(provider.calls).toHaveLength(1);
    expect(result.finalContent).toContain("image_url is not supported");
  });

  it("still blocks images client-side for a BYOK model the catalog knows is text-only", async () => {
    const provider = new ByokProvider();

    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      initialMessages: [imageMessage()],
      provider,
      model: "deepseek-v4-pro",
      actualModelContext: byokContext("deepseek-v4-pro"),
    }));

    expect(provider.calls).toHaveLength(0);
    expect(result.finalContent).toBe("Current model does not support image input.");
  });

  it("still blocks images for an unknown account-managed model", async () => {
    const provider = new ByokProvider();

    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      initialMessages: [imageMessage()],
      provider,
      model: "unlisted-account-model",
      actualModelContext: accountContext("unlisted-account-model"),
    }));

    expect(provider.calls).toHaveLength(0);
    expect(result.finalContent).toBe("Current model does not support image input.");
  });
});
