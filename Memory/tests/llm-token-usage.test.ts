import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmConfig } from "../src/config/index.js";
import { createEmbedder } from "../src/model/embedder.js";
import { createLlmClient } from "../src/model/llm.js";

const roots: string[] = [];
const envBackup: Record<string, string | undefined> = {};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete envBackup[key];
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("memory LLM token usage recording", () => {
  it("forces OpenAI-compatible memory LLM requests to be non-streaming", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({
      choices: [{ message: { content: "{\"ok\":true}" } }]
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createLlmClient(llmConfig("summary-model"));

    await expect(client.completeJson<{ ok: boolean }>(
      [{ role: "user", content: "summarize" }],
      { operation: "episode.summarize" }
    )).resolves.toEqual({ ok: true });

    expect(modelRequestBody(fetchMock)).toMatchObject({
      model: "summary-model",
      stream: false,
      response_format: { type: "json_object" }
    });
  });

  it("forces Anthropic memory LLM requests to be non-streaming", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({
      content: [{ type: "text", text: "summary" }]
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createLlmClient(llmConfig("claude-test", {
      provider: "anthropic",
      endpoint: "https://api.anthropic.test/v1/messages"
    }));

    await expect(client.complete(
      [{ role: "user", content: "summarize" }],
      { operation: "episode.summarize" }
    )).resolves.toBe("summary");

    expect(modelRequestBody(fetchMock)).toMatchObject({
      model: "claude-test",
      stream: false
    });
  });

  it("uploads BYOK memory summary model token usage to the local backend", async () => {
    setEnv("MEMMY_RUNTIME_CONFIG_PATH", createRuntimeConfig());
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (isByokUpload(input)) return jsonResponse({ ok: true });
      return jsonResponse({
        choices: [{ message: { content: "summary" } }],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
          prompt_tokens_details: {
            cached_tokens: 3
          }
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createLlmClient(llmConfig("summary-model"), { modelRole: "memory_summary" });

    await expect(client.complete([{ role: "user", content: "summarize" }], { operation: "episode.summarize" })).resolves.toBe("summary");

    const [url, init] = requireUploadCall(fetchMock);
    expect(url.toString()).toBe("http://127.0.0.1:18100/api/app/byok-token-usage/events");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      "x-memmy-local-token": "runtime-token"
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      kind: "memory_summary",
      source: "memory",
      operationId: expect.stringMatching(/^episode\.summarize:byok_usage_/),
      inputTokens: 11,
      outputTokens: 7,
      cachedInputTokens: 3,
      cacheCreationInputTokens: 0,
      totalTokens: 18,
      metadata: {
        operation: "episode.summarize",
        provider: "openai_compatible",
        model: "summary-model"
      },
      rawUsage: {
        prompt_tokens: 11,
        completion_tokens: 7
      }
    });
  });

  it("uploads BYOK memory evolution model token usage separately", async () => {
    setEnv("MEMMY_RUNTIME_CONFIG_PATH", createRuntimeConfig());
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (isByokUpload(input)) return jsonResponse({ ok: true });
      return jsonResponse({
        choices: [{ message: { content: "{\"ok\":true}" } }],
        usage: {
          input_tokens: 21,
          output_tokens: 9,
          input_tokens_details: {
            cached_tokens: 5
          }
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createLlmClient(llmConfig("evolver-model"), { modelRole: "memory_evolution" });

    await expect(client.completeJson<{ ok: boolean }>(
      [{ role: "user", content: "evolve" }],
      { operation: "skill.crystallize" }
    )).resolves.toEqual({ ok: true });

    const body = uploadBody(fetchMock);
    expect(body).toMatchObject({
      kind: "memory_evolution",
      source: "memory",
      operationId: expect.stringMatching(/^skill\.crystallize:byok_usage_/),
      inputTokens: 21,
      outputTokens: 9,
      cachedInputTokens: 5,
      totalTokens: 30,
      metadata: {
        operation: "skill.crystallize",
        provider: "openai_compatible",
        model: "evolver-model"
      }
    });
  });

  it("uploads BYOK remote embedding token usage", async () => {
    setEnv("MEMMY_RUNTIME_CONFIG_PATH", createRuntimeConfig());
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (isByokUpload(input)) return jsonResponse({ ok: true });
      return jsonResponse({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
        usage: {
          prompt_tokens: 13,
          total_tokens: 13
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const embedder = createEmbedder({
      provider: "openai_compatible",
      endpoint: "https://api.example.test/v1",
      model: "embedding-model",
      apiKey: "sk-test",
      batchSize: 32,
      normalize: false,
      cache: false,
      timeoutMs: 60_000,
      maxRetries: 0
    });

    await expect(embedder.embed(["remember this"], "document")).resolves.toEqual([[0.1, 0.2, 0.3]]);

    expect(uploadBody(fetchMock)).toMatchObject({
      kind: "embedding",
      source: "memory",
      operationId: expect.stringMatching(/^embedding\.document:byok_usage_/),
      inputTokens: 13,
      outputTokens: 0,
      totalTokens: 13,
      metadata: {
        operation: "embedding.document",
        provider: "openai_compatible",
        model: "embedding-model",
        role: "document"
      }
    });
  });

  it("does not upload cloud account memory usage", async () => {
    setEnv("MEMMY_RUNTIME_CONFIG_PATH", createRuntimeConfig());
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({
      choices: [{ message: { content: "summary" } }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18
      }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createLlmClient(llmConfig("summary-model", {
      endpoint: "https://memtensor.cn/api/agentExternal/v1"
    }), { modelRole: "memory_summary" });

    await expect(client.complete([{ role: "user", content: "summarize" }], { operation: "episode.summarize" })).resolves.toBe("summary");

    expect(findUploadCall(fetchMock)).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function llmConfig(model: string, overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "openai_compatible",
    endpoint: "https://api.example.test/v1",
    model,
    apiKey: "sk-test",
    enableThinking: false,
    temperature: 0.2,
    maxTokens: 1200,
    timeoutMs: 60_000,
    maxRetries: 0,
    malformedRetries: 0,
    ...overrides
  };
}

function createRuntimeConfig(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-llm-usage-"));
  roots.push(root);
  const runtimeConfigPath = join(root, "runtime.json");
  writeFileSync(runtimeConfigPath, JSON.stringify({
    baseUrl: "http://127.0.0.1:18100",
    localToken: "runtime-token"
  }));
  return runtimeConfigPath;
}

function uploadBody(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): Record<string, unknown> {
  const [, init] = requireUploadCall(fetchMock);
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function modelRequestBody(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): Record<string, unknown> {
  for (const [input, init] of fetchMock.mock.calls as Array<[Parameters<typeof fetch>[0], RequestInit | undefined]>) {
    if (!isByokUpload(input)) {
      return JSON.parse(String(init?.body)) as Record<string, unknown>;
    }
  }
  throw new Error("expected model request call");
}

function requireUploadCall(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): [URL, RequestInit] {
  const call = findUploadCall(fetchMock);
  if (!call) throw new Error("expected BYOK usage upload call");
  return call;
}

function findUploadCall(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): [URL, RequestInit] | undefined {
  for (const [input, init] of fetchMock.mock.calls as Array<[Parameters<typeof fetch>[0], RequestInit | undefined]>) {
    if (isByokUpload(input)) {
      return [toUrl(input), init ?? {}];
    }
  }
  return undefined;
}

function isByokUpload(input: Parameters<typeof fetch>[0]): boolean {
  return toUrl(input).pathname === "/api/app/byok-token-usage/events";
}

function toUrl(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}

function setEnv(name: string, value: string): void {
  if (!(name in envBackup)) envBackup[name] = process.env[name];
  process.env[name] = value;
}
