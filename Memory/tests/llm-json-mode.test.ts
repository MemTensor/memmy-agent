import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmConfig } from "../src/config/index.js";
import { createLlmClient } from "../src/model/llm.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI-compatible JSON response formats", () => {
  it("falls back to text when an endpoint rejects json_object and remembers the capability", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "'response_format.type' must be 'json_schema' or 'text'"
      }), {
        status: 400,
        headers: { "content-type": "application/json" }
      }))
      .mockImplementation(async () => jsonResponse({
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }]
      }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createLlmClient(llmConfig());

    await expect(client.completeJson<{ ok: boolean }>(
      [{ role: "user", content: "summarize" }],
      { operation: "capture.summarize" }
    )).resolves.toEqual({ ok: true });
    await expect(client.completeJson<{ ok: boolean }>(
      [{ role: "user", content: "reflect" }],
      { operation: "capture.alpha.reflection.score.v1" }
    )).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestBody(fetchMock, 0)).toMatchObject({
      response_format: { type: "json_object" }
    });
    expect(requestBody(fetchMock, 1)).toMatchObject({
      response_format: { type: "text" }
    });
    expect(requestBody(fetchMock, 2)).toMatchObject({
      response_format: { type: "text" }
    });
  });

  it("does not retry unrelated invalid requests", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: { message: "model does not exist" }
    }), {
      status: 400,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createLlmClient(llmConfig());

    await expect(client.completeJson(
      [{ role: "user", content: "summarize" }],
      { operation: "capture.summarize" }
    )).rejects.toThrow("model does not exist");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function llmConfig(): LlmConfig {
  return {
    provider: "openai_compatible",
    endpoint: "http://127.0.0.1:1234/v1",
    model: "local-model",
    apiKey: "lm-studio",
    enableThinking: false,
    temperature: 0,
    maxTokens: 512,
    timeoutMs: 5_000,
    maxRetries: 0,
    malformedRetries: 0
  };
}

function requestBody(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, index: number): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[index] as [Parameters<typeof fetch>[0], RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
