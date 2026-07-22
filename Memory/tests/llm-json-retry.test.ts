import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmConfig } from "../src/config/index.js";
import { createLlmClient } from "../src/model/llm.js";

const originalLogLevel = process.env.MEMMY_LOG_LEVEL;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalLogLevel === undefined) {
    delete process.env.MEMMY_LOG_LEVEL;
  } else {
    process.env.MEMMY_LOG_LEVEL = originalLogLevel;
  }
});

describe("memory LLM JSON length retry", () => {
  it("doubles max tokens once when the provider reports a length stop", async () => {
    const fetchMock = sequenceFetch([
      openAiResponse('{"ok":true}', "length"),
      openAiResponse('{"ok":true,"complete":true}', "stop")
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const client = createLlmClient(llmConfig());
    await expect(client.completeJson<{ ok: boolean; complete?: boolean }>(
      [{ role: "user", content: "generate" }],
      { operation: "skill.crystallize" }
    )).resolves.toEqual({ ok: true, complete: true });

    expect(requestBodies(fetchMock).map((body) => body.max_tokens)).toEqual([4096, 8192]);
    expect(requestBodies(fetchMock)[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("previous output was truncated")
      })
    ]));
  });

  it("doubles max tokens for visibly truncated JSON when finish reason is absent", async () => {
    const fetchMock = sequenceFetch([
      openAiResponse('{"ok":true,"items":[1,2'),
      openAiResponse('{"ok":true,"items":[1,2,3]}', "stop")
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const client = createLlmClient(llmConfig());
    await expect(client.completeJson<{ ok: boolean; items: number[] }>(
      [{ role: "user", content: "generate" }],
      { operation: "l3.abstraction.v2" }
    )).resolves.toEqual({ ok: true, items: [1, 2, 3] });

    expect(requestBodies(fetchMock).map((body) => body.max_tokens)).toEqual([4096, 8192]);
  });

  it("keeps the same max tokens for a normal malformed JSON retry", async () => {
    const fetchMock = sequenceFetch([
      openAiResponse('{"ok":}', "stop"),
      openAiResponse('{"ok":true}', "stop")
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const client = createLlmClient(llmConfig({ malformedRetries: 1 }));
    await expect(client.completeJson<{ ok: boolean }>(
      [{ role: "user", content: "generate" }],
      { operation: "capture.summarize" }
    )).resolves.toEqual({ ok: true });

    expect(requestBodies(fetchMock).map((body) => body.max_tokens)).toEqual([4096, 4096]);
  });

  it("logs truncation recovery with timestamps and token budgets", async () => {
    process.env.MEMMY_LOG_LEVEL = "info";
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.stubGlobal("fetch", sequenceFetch([
      openAiResponse('{"ok":true,"items":[1,2', "length"),
      openAiResponse('{"ok":true,"items":[1,2,3]}', "stop")
    ]));

    const client = createLlmClient(llmConfig(), { modelRole: "memory_evolution" });
    await client.completeJson(
      [{ role: "user", content: "generate" }],
      { operation: "l3.abstraction.v2" }
    );

    const records = [...stdout, ...stderr]
      .flatMap((value) => value.trim().split("\n"))
      .filter(Boolean)
      .map((value) => JSON.parse(value) as Record<string, unknown>);
    expect(records).toContainEqual(expect.objectContaining({
      level: "warn",
      message: "[l3.abstraction.v2] 模型输出被截断，将 maxTokens 从 4096 提升到 8192 后重试"
    }));
    expect(records).toContainEqual(expect.objectContaining({
      level: "info",
      message: "[l3.abstraction.v2] 模型 JSON 在第 2 次尝试后解析成功，maxTokens=8192"
    }));
    expect(records.every((record) => /^\d{4}-\d{2}-\d{2}T/.test(String(record.timestamp)))).toBe(true);
    expect(records.every((record) => Object.keys(record).join(",") === "timestamp,level,message")).toBe(true);
  });

  it("logs terminal JSON failures and exposes the latest parse error in model status", async () => {
    process.env.MEMMY_LOG_LEVEL = "error";
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.stubGlobal("fetch", sequenceFetch([openAiResponse('{"ok":}', "stop")]));

    const client = createLlmClient(llmConfig(), { modelRole: "memory_summary" });
    await expect(client.completeJson(
      [{ role: "user", content: "generate" }],
      { operation: "capture.summarize" }
    )).rejects.toThrow();

    const records = stderr
      .flatMap((value) => value.trim().split("\n"))
      .filter(Boolean)
      .map((value) => JSON.parse(value) as Record<string, unknown>);
    expect(records).toContainEqual(expect.objectContaining({
      level: "error",
      message: expect.stringContaining("[capture.summarize] 模型 JSON 解析失败")
    }));
    expect(client.status().lastError).toBeTruthy();
  });
});

function llmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "openai_compatible",
    endpoint: "https://api.example.test/v1",
    model: "memory-evolution-test",
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

function openAiResponse(content: string, finishReason?: string): Response {
  return new Response(JSON.stringify({
    choices: [{
      message: { content },
      ...(finishReason ? { finish_reason: finishReason } : {})
    }]
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function sequenceFetch(responses: Response[]): ReturnType<typeof vi.fn<typeof fetch>> {
  let index = 0;
  return vi.fn<typeof fetch>(async () => {
    const response = responses[index];
    index += 1;
    if (!response) throw new Error("unexpected model request");
    return response;
  });
}

function requestBodies(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): Array<Record<string, unknown>> {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}
