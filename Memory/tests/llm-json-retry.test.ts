import { afterEach, describe, expect, it, vi } from "vitest";
import { get_encoding } from "tiktoken";
import type { LlmConfig } from "../src/config/index.js";
import { createLlmClient } from "../src/model/llm.js";
import type { LlmMessage } from "../src/model/types.js";

const originalLogLevel = process.env.MEMMY_LOG_LEVEL;
const encoding = get_encoding("cl100k_base");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalLogLevel === undefined) {
    delete process.env.MEMMY_LOG_LEVEL;
  } else {
    process.env.MEMMY_LOG_LEVEL = originalLogLevel;
  }
});

describe("memory summary input budget", () => {
  it.each([
    ["capture.summarize", 512],
    ["capture.reflection.synth", 500],
    ["capture.alpha.reflection_score.v1", 700],
    ["span.big_turn.v1", 4096],
    ["reward.r_human.v1", 700],
    ["retrieval.query_extract.v1", 320],
    ["retrieval.filter.v1", 512],
    ["relation.classify.v1", 512],
    ["relation.arbitration.v1", 512]
  ])("budgets the summary role for %s", async (operation, maxTokens) => {
    const fetchMock = sequenceFetch([openAiResponse("ok")]);
    vi.stubGlobal("fetch", fetchMock);

    const messages: LlmMessage[] = [
      { role: "system", content: "Keep the system instructions." },
      { role: "user", content: "BEGIN " + "tool output ".repeat(6_000) + "END" }
    ];
    const original = structuredClone(messages);
    const client = createLlmClient(llmConfig(), { modelRole: "memory_summary" });
    await client.complete(messages, { operation, maxTokens });

    const body = requestBodies(fetchMock)[0]!;
    const sent = body.messages as LlmMessage[];
    expect(body.max_tokens).toBe(maxTokens);
    expect(sent[0]).toEqual(messages[0]);
    expect(sent[1]?.content).toMatch(/^BEGIN /);
    expect(sent[1]?.content).toContain("[... input truncated ...]");
    expect(sent[1]?.content).toMatch(/END$/);
    expect(inputTokenCount(body)).toBeLessThanOrEqual(Math.min(7_000, 8_192 - maxTokens - 512));
    expect(messages).toEqual(original);
  });

  it("keeps short input unchanged and sends the default output reservation", async () => {
    const fetchMock = sequenceFetch([openAiResponse("ok")]);
    vi.stubGlobal("fetch", fetchMock);
    const client = createLlmClient(llmConfig({ maxTokens: undefined }), { modelRole: "memory_summary" });
    const messages: LlmMessage[] = [{ role: "user", content: "Summarize this." }];

    await client.complete(messages, { operation: "capture.summarize" });

    expect(requestBodies(fetchMock)[0]).toMatchObject({ messages, max_tokens: 512 });
  });

  it("preserves system messages after long evidence and shares space among other messages", async () => {
    const fetchMock = sequenceFetch([openAiResponse("ok")]);
    vi.stubGlobal("fetch", fetchMock);
    const client = createLlmClient(llmConfig(), { modelRole: "memory_summary" });
    const messages: LlmMessage[] = [
      { role: "user", content: "user evidence ".repeat(6_000) },
      { role: "system", content: "Do not drop these instructions." },
      { role: "assistant", content: "assistant evidence ".repeat(6_000) },
      { role: "user", content: "Keep this short request." }
    ];

    await client.complete(messages, { operation: "capture.summarize" });

    const body = requestBodies(fetchMock)[0]!;
    const sent = body.messages as LlmMessage[];
    expect(sent.map((message) => message.role)).toEqual(messages.map((message) => message.role));
    expect(sent[1]).toEqual(messages[1]);
    expect(sent[3]).toEqual(messages[3]);
    expect(sent[0]?.content).toContain("[... input truncated ...]");
    expect(sent[2]?.content).toContain("[... input truncated ...]");
    expect(inputTokenCount(body) + Number(body.max_tokens) + 512).toBeLessThanOrEqual(8_192);
  });

  it("cuts Chinese and emoji only at valid Unicode boundaries", async () => {
    const fetchMock = sequenceFetch([openAiResponse("ok")]);
    vi.stubGlobal("fetch", fetchMock);
    const client = createLlmClient(llmConfig(), { modelRole: "memory_summary" });
    const source = "开头" + "中文🧠检索𠮷野家🧪".repeat(2_000) + "结尾";

    await client.complete([{ role: "user", content: source }], { operation: "span.big_turn.v1" });

    const body = requestBodies(fetchMock)[0]!;
    const content = (body.messages as LlmMessage[])[0]!.content;
    const [head, tail] = content.split("\n[... input truncated ...]\n");
    expect(content).not.toContain("\ufffd");
    expect(head?.startsWith("开头")).toBe(true);
    expect(tail?.endsWith("结尾")).toBe(true);
    expect(source.startsWith(head!)).toBe(true);
    expect(source.endsWith(tail!)).toBe(true);
    expect(inputTokenCount(body)).toBeLessThanOrEqual(3_584);
  });

  it("rejects oversized system instructions without dropping them or making a request", async () => {
    const fetchMock = sequenceFetch([]);
    vi.stubGlobal("fetch", fetchMock);
    const client = createLlmClient(llmConfig(), { modelRole: "memory_summary" });

    await expect(client.complete([
      { role: "system", content: "system instruction ".repeat(6_000) },
      { role: "user", content: "evidence" }
    ], { operation: "capture.summarize" })).rejects.toThrow("Summary system instructions exceed");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.status().lastError).toContain("Summary system instructions exceed");
  });

  it("caps an oversized summary output reservation", async () => {
    const fetchMock = sequenceFetch([openAiResponse("ok")]);
    vi.stubGlobal("fetch", fetchMock);
    const client = createLlmClient(llmConfig({ maxTokens: 8_192 }), { modelRole: "memory_summary" });

    await client.complete([{ role: "user", content: "evidence ".repeat(10_000) }], {
      operation: "span.big_turn.v1"
    });

    const body = requestBodies(fetchMock)[0]!;
    expect(body.max_tokens).toBe(4_096);
    expect(inputTokenCount(body) + Number(body.max_tokens) + 512).toBeLessThanOrEqual(8_192);
  });

  it("recomputes the input budget including JSON hints when output doubles", async () => {
    const fetchMock = sequenceFetch([
      openAiResponse('{"ok":', "length"),
      openAiResponse('{"ok":true}', "stop")
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const client = createLlmClient(llmConfig({ maxTokens: 512 }), { modelRole: "memory_summary" });

    await expect(client.completeJson([
      { role: "system", content: "Keep the system instructions." },
      { role: "user", content: "evidence ".repeat(10_000) }
    ], { operation: "retrieval.filter.v1" })).resolves.toEqual({ ok: true });

    const bodies = requestBodies(fetchMock);
    expect(bodies.map((body) => body.max_tokens)).toEqual([512, 1_024]);
    for (const body of bodies) {
      const messages = body.messages as LlmMessage[];
      expect(messages[0]?.content).toContain("Return exactly one valid JSON object.");
      expect(messages[0]?.content).toContain("Keep the system instructions.");
      expect(inputTokenCount(body) + Number(body.max_tokens) + 512).toBeLessThanOrEqual(8_192);
    }
    expect((bodies[1]!.messages as LlmMessage[])[0]?.content).toContain("previous output was truncated");
  });

  it("does not expand a summary JSON retry to an impossible 8192-token output", async () => {
    const fetchMock = sequenceFetch([openAiResponse('{"spans":[', "length")]);
    vi.stubGlobal("fetch", fetchMock);
    const client = createLlmClient(llmConfig(), { modelRole: "memory_summary" });

    await expect(client.completeJson([{ role: "user", content: "segment this turn" }], {
      operation: "span.big_turn.v1"
    })).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBodies(fetchMock)[0]?.max_tokens).toBe(4_096);
  });

  it("does not constrain evolution requests even when they handle a summary fallback", async () => {
    const fetchMock = sequenceFetch([
      openAiResponse('{"ok":', "length"),
      openAiResponse('{"ok":true}', "stop")
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const client = createLlmClient(llmConfig(), { modelRole: "memory_evolution" });
    const content = "evidence ".repeat(10_000);

    await client.completeJson([{ role: "user", content }], { operation: "capture.summarize" });

    const bodies = requestBodies(fetchMock);
    expect(bodies.map((body) => body.max_tokens)).toEqual([4_096, 8_192]);
    expect(bodies.every((body) => (body.messages as LlmMessage[])[1]?.content === content)).toBe(true);
  });
});

describe("memory LLM JSON length retry", () => {
  it("merges existing system messages into one leading system message", async () => {
    const fetchMock = sequenceFetch([openAiResponse('{"ok":true}', "stop")]);
    vi.stubGlobal("fetch", fetchMock);

    const client = createLlmClient(llmConfig());
    await client.completeJson<{ ok: boolean }>([
      { role: "user", content: "generate" },
      { role: "system", content: "Summarize the conversation." },
      { role: "system", content: "Answer in Chinese." }
    ], {
      operation: "capture.summarize"
    });

    expect(requestBodies(fetchMock)[0]?.messages).toEqual([
      {
        role: "system",
        content: [
          "Return exactly one valid JSON object. Do not include markdown fences or explanatory text.",
          "Summarize the conversation.",
          "Answer in Chinese."
        ].join("\n\n")
      },
      { role: "user", content: "generate" }
    ]);
  });

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

  it("returns a summary budget error when reasoning exists without final content", async () => {
    const fetchMock = sequenceFetch([
      openAiMessageResponse({
        content: null,
        reasoning_content: "The model spent its output budget reasoning."
      }, "length")
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const client = createLlmClient(llmConfig({ malformedRetries: 1 }));
    await expect(client.completeJson(
      [{ role: "user", content: "generate" }],
      { operation: "capture.summarize" }
    )).rejects.toThrow("Reasoning exhausted the summary output token budget");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the standard missing-content error when reasoning is also absent", async () => {
    const fetchMock = sequenceFetch([
      openAiMessageResponse({ content: null }, "length")
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const client = createLlmClient(llmConfig({ malformedRetries: 1 }));
    await expect(client.completeJson(
      [{ role: "user", content: "generate" }],
      { operation: "capture.summarize" }
    )).rejects.toThrow("openai_compatible response missing choices[0].message.content");

    expect(fetchMock).toHaveBeenCalledTimes(1);
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
      message: "[l3.abstraction.v2] Model output was truncated; retrying with maxTokens increased from 4096 to 8192"
    }));
    expect(records).toContainEqual(expect.objectContaining({
      level: "info",
      message: "[l3.abstraction.v2] Model JSON parsing recovered on attempt 2, maxTokens=8192"
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
      message: expect.stringContaining("[capture.summarize] Model JSON parsing failed")
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
  return openAiMessageResponse({ content }, finishReason);
}

function openAiMessageResponse(
  message: Record<string, unknown>,
  finishReason?: string
): Response {
  return new Response(JSON.stringify({
    choices: [{
      message,
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

function inputTokenCount(body: Record<string, unknown>): number {
  return (body.messages as LlmMessage[])
    .reduce((total, message) => total + encoding.encode(message.content, [], []).length, 0);
}
