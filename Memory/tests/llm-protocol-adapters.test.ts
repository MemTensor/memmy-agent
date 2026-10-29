import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { resolveAssignedModel, type RuntimeModelCatalog } from "../src/contracts/index.js";
import { loadMemmyConfig, type LlmConfig } from "../src/config/index.js";
import { createLlmClient } from "../src/model/llm.js";
import type { LlmMessage } from "../src/model/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("memory protocol adapters", () => {
  it("resolves openai-responses and bedrock-converse for memory roles", () => {
    const responses = resolveAssignedModel({
      catalog: catalog("openai-responses"),
      mode: "byok",
      capability: "memory_summary"
    });
    const bedrock = resolveAssignedModel({
      catalog: catalog("bedrock-converse"),
      mode: "byok",
      capability: "memory_evolution"
    });

    expect(responses.ok && responses.context.protocol).toBe("openai-responses");
    expect(bedrock.ok && bedrock.context.protocol).toBe("bedrock-converse");
  });

  it("posts memory summary turns to the Responses API", async () => {
    const fetchMock = stubFetch(responsesBody("{\"summary\":\"ok\"}"));
    vi.stubGlobal("fetch", fetchMock);
    const messages: LlmMessage[] = [
      { role: "system", content: "Return JSON." },
      { role: "user", content: "Summarize this." }
    ];

    const text = await createLlmClient(llmConfig({ provider: "openai_responses" }), {
      modelRole: "memory_summary"
    }).complete(messages, { operation: "capture.summarize", jsonMode: true, maxTokens: 512 });

    expect(text).toBe("{\"summary\":\"ok\"}");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/v1/responses",
      expect.objectContaining({ method: "POST" })
    );
    expect(requestBody(fetchMock)).toMatchObject({
      model: "memory-model",
      input: messages,
      max_output_tokens: 512,
      store: false,
      stream: false,
      text: { format: { type: "json_object" } }
    });
  });

  it("posts memory evolution turns to Bedrock Converse", async () => {
    const fetchMock = stubFetch(bedrockBody("evolved"));
    vi.stubGlobal("fetch", fetchMock);
    const messages: LlmMessage[] = [
      { role: "system", content: "Evolve the memory." },
      { role: "user", content: "New evidence." }
    ];

    const text = await createLlmClient(llmConfig({
      provider: "bedrock",
      endpoint: "https://bedrock-runtime.us-west-2.amazonaws.com",
      model: "anthropic.claude-sonnet-5"
    }), {
      modelRole: "memory_evolution"
    }).complete(messages, { operation: "skill.crystallize", maxTokens: 700 });

    expect(text).toBe("evolved");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-sonnet-5/converse",
      expect.objectContaining({ method: "POST" })
    );
    expect(requestBody(fetchMock)).toMatchObject({
      system: [{ text: "Evolve the memory." }],
      messages: [{ role: "user", content: [{ text: "New evidence." }] }],
      inferenceConfig: { maxTokens: 700 }
    });
  });

  it("runs a custom Anthropic Messages preset through the Anthropic memory runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-custom-anthropic-"));
    const file = join(root, "config.yaml");
    writeFileSync(file, YAML.stringify({
      app: { userMode: "byok" },
      providers: {
        custom: {
          endpoints: {
            chat: {
              apiBase: "https://api.anthropic.com/v1",
              protocol: "anthropic-messages",
              apiKey: "sk-anthropic"
            }
          }
        }
      },
      modelPresets: {
        "memory-model": {
          provider: "custom",
          endpoint: "chat",
          model: "claude-sonnet",
          source: "byok",
          capabilities: ["agent", "memory_summary", "memory_evolution"]
        }
      },
      modelAssignments: {
        byok: {
          agent: { candidates: ["memory-model"], default: "memory-model" }
        }
      },
      memmyMemory: {
        roleRouting: { summary: "follow", evolution: "follow" }
      }
    }), "utf8");

    try {
      const { config } = loadMemmyConfig(file);
      expect(config.evolution.provider).toBe("anthropic");
      expect(config.evolution.model).toBe("claude-sonnet");
      expect(config.evolution.endpoint).toBe("https://api.anthropic.com/v1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function catalog(protocol: "openai-responses" | "bedrock-converse"): RuntimeModelCatalog {
  return {
    providers: {
      custom: {
        apiKey: "secret",
        endpoints: {
          chat: {
            apiBase: protocol === "bedrock-converse"
              ? "https://bedrock-runtime.us-west-2.amazonaws.com"
              : "https://api.example.test/v1",
            protocol
          }
        }
      }
    },
    modelPresets: {
      "memory-model": {
        provider: "custom",
        endpoint: "chat",
        model: "memory-model",
        source: "byok",
        capabilities: ["agent", "memory_summary", "memory_evolution"]
      }
    },
    modelAssignments: {
      byok: protocol === "bedrock-converse"
        ? { memoryEvolution: "memory-model" }
        : { memorySummary: "memory-model" }
    }
  };
}

function llmConfig(overrides: Partial<LlmConfig>): LlmConfig {
  return {
    provider: "openai_responses",
    endpoint: "https://api.example.test/v1",
    model: "memory-model",
    apiKey: "sk-test",
    enableThinking: false,
    temperature: 0,
    maxTokens: 4096,
    timeoutMs: 60_000,
    maxRetries: 0,
    malformedRetries: 0,
    ...overrides
  };
}

function responsesBody(text: string): Response {
  return new Response(JSON.stringify({
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 }
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function bedrockBody(text: string): Response {
  return new Response(JSON.stringify({
    output: { message: { content: [{ text }] } },
    stopReason: "end_turn",
    usage: { inputTokens: 3, outputTokens: 2 }
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function stubFetch(response: Response): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async () => response);
}

function requestBody(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): Record<string, unknown> {
  return JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
}
