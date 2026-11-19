import OpenAI from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";
import { chatExceptions } from "../../src/providers/protocol-preference.js";

const args = { messages: [{ role: "user", content: "Return JSON" }] };
const chat = { choices: [{ message: { content: "OK" }, finish_reason: "stop" }] };
const response = { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] };
function json(body: unknown, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
function provider(fetch: typeof globalThis.fetch, extraBody = {}) {
  const p = new OpenAICompatProvider({ apiKey: "test", apiBase: "https://llm.example/v1", defaultModel: "test-model", extraBody });
  p.client = new OpenAI({ apiKey: "test", baseURL: "https://llm.example/v1", maxRetries: 0, fetch });
  vi.spyOn(p as any, "sleepWithHeartbeat").mockResolvedValue(undefined);
  return p;
}
beforeEach(() => chatExceptions.clear());

describe("protocol boundaries with the real OpenAI SDK", () => {
  it.each([false, true])("honors backend no-retry headers (stream=%s)", async streaming => {
    const fetch = vi.fn().mockImplementation(async () => json({ error: { message: "upstream response could not be decoded" } }, 502, { "x-should-retry": "false" }));
    const p = provider(fetch); p.spec = { name: "memmy_account" };
    const result = await (streaming ? p.chatStreamWithRetry(args) : p.chatWithRetry(args));
    expect(result.errorShouldRetry).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["responses", "chatCompletions"] as const)("does not replay %s after a 200 body-read timeout", async apiType => {
    const fetch = vi.fn().mockImplementationOnce(async () => new Response(new ReadableStream({
      start(controller) {
        controller.error(new TypeError("terminated", { cause: Object.assign(new Error("Body Timeout Error"), { name: "BodyTimeoutError" }) }));
      },
    }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockImplementation(async () => json(apiType === "responses" ? response : chat));
    const p = provider(fetch); p.apiType = apiType;
    const result = await p.chatWithRetry(args);
    expect(result.finishReason).toBe("error");
    expect(result.errorShouldRetry).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { type: "json_object" },
    { type: "json_schema", json_schema: { name: "answer", strict: true, schema: { type: "object", properties: {} } } },
  ])("converts saved Chat output format $type to Responses", async format => {
    const fetch = vi.fn().mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body);
      return body.response_format ? json({ error: { message: "Unsupported parameter: response_format" } }, 400) : json(response);
    });
    const p = provider(fetch, { response_format: format, text: { verbosity: "low" }, n: 1 });
    expect((await p.chat(args)).finishReason).toBe("stop");
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(String(fetch.mock.calls[0][0])).toMatch(/\/responses$/);
    expect(body.text).toEqual({ verbosity: "low", format: format.type === "json_schema" ? { type: format.type, ...format.json_schema } : format });
    expect(body).not.toHaveProperty("response_format");
    expect(body).not.toHaveProperty("n");
  });

  it.each(Object.entries({
    stop: ["END"], n: 2, frequency_penalty: 0.5, presence_penalty: 0.5, logprobs: true,
    top_logprobs: 2, logit_bias: { "42": 1 }, seed: 42, modalities: ["text", "audio"],
    audio: { voice: "alloy", format: "wav" }, prediction: { type: "content", content: "hello" },
    functions: [{ name: "lookup", parameters: { type: "object" } }], function_call: { name: "lookup" },
  }))("retains Chat for %s without caching a rejection", async (parameter, value) => {
    const fetch = vi.fn().mockImplementation(async url => json(String(url).endsWith("/responses") ? response : chat));
    const p = provider(fetch, { [parameter]: value });
    await p.chat(args);
    expect(String(fetch.mock.calls[0][0])).toMatch(/\/chat\/completions$/);
    expect(JSON.parse(fetch.mock.calls[0][1].body)[parameter]).toEqual(p.extraBody[parameter]);
    p.extraBody = {};
    await p.chat(args);
    expect(String(fetch.mock.calls[1][0])).toMatch(/\/responses$/);
  });

  it("converts Chat token limits, reasoning and named tool choice", async () => {
    const fetch = vi.fn().mockImplementation(async () => json(response));
    const p = provider(fetch, { max_tokens: 10, max_completion_tokens: 20, reasoning_effort: "high" });
    await p.chat({ ...args, tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }], toolChoice: { type: "function", function: { name: "lookup" } } });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ max_output_tokens: 20, reasoning: { effort: "high" }, tool_choice: { type: "function", name: "lookup" } });
    for (const key of ["max_tokens", "max_completion_tokens", "reasoning_effort"]) expect(body).not.toHaveProperty(key);
  });

  it("preserves native Responses overrides and converts configured Chat tools", async () => {
    const fetch = vi.fn().mockImplementation(async () => json(response));
    const extra = {
      response_format: { type: "json_schema", json_schema: { name: "legacy", schema: {} } },
      text: { format: { type: "json_object" } }, max_tokens: 10, max_output_tokens: 30,
      reasoning_effort: "low", reasoning: { effort: "high", summary: "auto" },
      stream_options: { include_usage: true, include_obfuscation: false },
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }, { type: "web_search" }],
      tool_choice: { type: "function", function: { name: "lookup" } },
    };
    const p = provider(fetch, extra);
    const original = structuredClone(extra);
    await p.chat(args);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      text: { format: { type: "json_object" } }, max_output_tokens: 30,
      reasoning: { effort: "high", summary: "auto" }, stream_options: { include_obfuscation: false },
      tools: [{ type: "function", name: "lookup", strict: false }, { type: "web_search" }],
      tool_choice: { type: "function", name: "lookup" },
    });
    expect(JSON.parse(fetch.mock.calls[0][1].body).text.format).toEqual({ type: "json_object" });
    expect(extra).toEqual(original);
  });

  it("still retries a transient failure before successful response headers", async () => {
    const fetch = vi.fn().mockImplementationOnce(async () => json({ error: { message: "temporarily unavailable" } }, 503))
      .mockImplementation(async () => json(response));
    expect((await provider(fetch).chatWithRetry(args)).content).toBe("OK");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
