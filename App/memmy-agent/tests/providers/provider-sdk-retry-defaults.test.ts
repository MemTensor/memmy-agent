import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic-provider.js";
import { AzureOpenAIProvider } from "../../src/providers/azure-openai-provider.js";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";
import { findByName } from "../../src/providers/registry.js";

describe("provider SDK retry defaults", () => {
  it("disables OpenAI-compatible SDK retries so memmy retry policy remains authoritative", async () => {
    const provider = new OpenAICompatProvider({ apiKey: "sk-test", defaultModel: "gpt-4o" });
    const client = await provider.ensureClient();

    expect(client.maxRetries).toBe(0);
  });

  it("constructs OpenAI-compatible SDK clients with explicit base URL and headers", async () => {
    const provider = new OpenAICompatProvider({
      apiKey: "sk-test",
      apiBase: "https://gateway.example/v1",
      defaultModel: "gateway/model",
      extraHeaders: { "X-Test": "1" },
      spec: findByName("custom"),
    });
    const client = await provider.ensureClient();

    expect(client.baseURL).toBe("https://gateway.example/v1");
    expect(client.defaultHeaders["X-Test"]).toBe("1");
    expect(client.apiKey).toBe("sk-test");
  });

  it("does not leak OPENAI_API_KEY into custom/local compatible providers", async () => {
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-real-openai";
    try {
      const provider = new OpenAICompatProvider({
        apiBase: "http://localhost:11434/v1",
        defaultModel: "llama3.2",
        spec: findByName("ollama"),
      });
      const client = await provider.ensureClient();

      expect(provider.apiKeyForClient).toBe("no-key");
      expect(client.apiKey).toBe("no-key");
    } finally {
      if (original == null) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
    }
  });

  it("disables Anthropic SDK retries so memmy retry policy remains authoritative", () => {
    const provider = new AnthropicProvider({ apiKey: "sk-test", defaultModel: "claude-sonnet-4-5" });

    expect((provider as any).client.maxRetries).toBe(0);
  });

  it("disables Azure SDK retries so memmy retry policy remains authoritative", () => {
    const provider = new AzureOpenAIProvider("key", "https://res.openai.azure.com", "deploy");

    expect(provider.client.maxRetries).toBe(0);
    expect(provider.client.defaultHeaders["x-session-affinity"]).toHaveLength(32);
  });
});
