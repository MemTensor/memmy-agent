import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";
import { ChatExceptionCache, chatExceptions, protocolPreferenceKey, rejectsProtocol } from "../../src/providers/protocol-preference.js";
import { convertMessages, parseResponseOutput } from "../../src/providers/openai-responses/index.js";
import { LLMResponse, ToolCallRequest } from "../../src/providers/base.js";
import { Config } from "../../src/config/schema.js";
import { makeProvider } from "../../src/providers/factory.js";

const args = { messages: [{ role: "user", content: "hello" }], reasoningEffort: "high" };
const chat = { choices: [{ message: { content: "OK" }, finish_reason: "stop" }] };
const response = { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }] };
const rejected = (status = 400, message = "Responses API is not supported for this model") =>
  Object.assign(new Error(message), { status, error: { message } });
function provider(providerName = "custom", model = "unknown-model") {
  const p = makeProvider(new Config({
    agents: { defaults: { modelPreset: "selected" } },
    providers: { [providerName]: {
      apiKey: "key",
      endpoints: { chat: { apiBase: "https://llm.example/v1", protocol: "openai-chat-completions" } },
    } },
    modelPresets: { selected: {
      provider: providerName, endpoint: "chat", model, source: "byok", capabilities: ["agent"],
    } },
  })) as OpenAICompatProvider;
  p.client = { responses: { create: vi.fn().mockResolvedValue(response) }, chat: { completions: { create: vi.fn().mockResolvedValue(chat) } } };
  return p;
}
async function* stream(events: any[]) { yield* events; }
beforeEach(() => chatExceptions.clear());

describe("Responses first with verified Chat exceptions", () => {
  it.each(["openai", "custom"])("uses Responses for a saved %s preset with tools and reasoning", async providerName => {
    const p = provider(providerName, "gpt-6-sol");
    p.client.responses.create.mockImplementation(() => stream([
      { type: "response.completed", response },
    ]));
    p.client.chat.completions.create.mockRejectedValue(rejected(400,
      "Function tools with reasoning_effort are not supported for gpt-6-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'."));
    const result = await p.chatStream({ ...args,
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }],
    });
    expect(result.content).toBe("OK");
    expect(result.finishReason).toBe("stop");
    expect(p.client.responses.create).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-6-sol", stream: true, reasoning: { effort: "high" },
      tools: [expect.objectContaining({ type: "function", name: "lookup" })],
    }));
    expect(p.client.chat.completions.create).not.toHaveBeenCalled();
  });

  it("uses Responses for unknown models and stores no success entry", async () => {
    const p = provider(); const remember = vi.spyOn(chatExceptions, "remember");
    await p.chat(args); await p.chat(args);
    expect(p.client.responses.create).toHaveBeenCalledTimes(2);
    expect(p.client.chat.completions.create).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
  });

  it("learns only after explicit rejection and a complete Chat success", async () => {
    const p = provider(); p.client.responses.create.mockRejectedValue(rejected());
    expect((await p.chat(args)).content).toBe("OK");
    await p.chat({ ...args, messages: [{ role: "user", content: "different text" }] });
    expect(p.client.responses.create).toHaveBeenCalledOnce();
    expect(p.client.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(p.client.chat.completions.create.mock.calls[0][0].reasoning_effort).toBe("high");
  });

  it("preserves explicit reasoning none on the Chat fallback", async () => {
    const p = provider(); p.client.responses.create.mockRejectedValue(rejected());
    await p.chat({ ...args, reasoningEffort: "none" });
    expect(p.client.responses.create.mock.calls[0][0].reasoning.effort).toBe("none");
    expect(p.client.chat.completions.create.mock.calls[0][0].reasoning_effort).toBe("none");
  });

  it("keeps Chat-only parameters and does not learn a provider exception", async () => {
    const p = provider(); p.extraBody = { stop: ["END"] };
    await p.chat(args);
    expect(p.client.responses.create).not.toHaveBeenCalled();
    expect(p.client.chat.completions.create.mock.calls[0][0].stop).toEqual(["END"]);
    p.extraBody = {};
    await p.chat(args);
    expect(p.client.responses.create).toHaveBeenCalledOnce();
  });

  it.each([400, 401, 403, 404, 408, 429, 500, 503])("does not switch on an unrelated %i", async status => {
    const p = provider(); p.client.responses.create.mockRejectedValue(rejected(status, "Invalid parameter or model not found"));
    expect((await p.chat(args)).finishReason).toBe("error");
    expect(p.client.chat.completions.create).not.toHaveBeenCalled();
  });

  it("does not learn two failures or repeat a failed alternate protocol", async () => {
    const p = provider(); p.client.responses.create.mockRejectedValue(rejected());
    p.client.chat.completions.create.mockRejectedValue(rejected(503, "unavailable"));
    const result = await p.chatWithRetry(args);
    expect(result.errorShouldRetry).toBe(false);
    await p.chat(args);
    expect(p.client.responses.create).toHaveBeenCalledTimes(2);
    expect(p.client.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  it.each(["length", "error"])("does not cache a Chat %s result", async finish => {
    const p = provider(); p.client.responses.create.mockRejectedValue(rejected());
    p.client.chat.completions.create.mockResolvedValue({ choices: [{ message: { content: "partial" }, finish_reason: finish }] });
    await p.chat(args); await p.chat(args);
    expect(p.client.responses.create).toHaveBeenCalledTimes(2);
  });

  it("corrects a cached Chat route once without looping", async () => {
    const p = provider(); p.client.responses.create.mockRejectedValueOnce(rejected());
    await p.chat(args);
    p.client.chat.completions.create.mockRejectedValue(rejected(400, "/v1/chat/completions is not supported. Use /v1/responses."));
    await p.chat(args); await p.chat(args);
    expect(p.client.responses.create).toHaveBeenCalledTimes(3);
    expect(p.client.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  it("isolates model, credentials, address, tools and reasoning", async () => {
    const p = provider(); p.client.responses.create.mockRejectedValue(rejected()); await p.chat(args);
    await p.chat({ ...args, model: "other" });
    await p.chat({ ...args, reasoningEffort: "low" });
    await p.chat({ ...args, tools: [{ type: "function", function: { name: "lookup" } }] });
    p.apiKeyForClient = "other-key"; await p.chat(args);
    p.effectiveBase = "https://other.example/v1"; await p.chat(args);
    expect(p.client.responses.create).toHaveBeenCalledTimes(6);
  });

  it("honors explicit endpoints and leaves account negotiation to the backend", async () => {
    for (const mode of ["responses", "chatCompletions"] as const) {
      const p = provider(); p.apiType = mode; p.client.responses.create.mockRejectedValue(rejected());
      await p.chat(args);
      expect(p.client.chat.completions.create).toHaveBeenCalledTimes(mode === "chatCompletions" ? 1 : 0);
    }
    const account = provider(); account.spec = { name: "memmy_account" };
    await account.chat(args);
    expect(account.client.responses.create).not.toHaveBeenCalled();
  });

  it("does not reuse a streaming-only rejection for a synchronous request", async () => {
    const p = provider(); p.client.responses.create.mockRejectedValueOnce(rejected());
    p.client.chat.completions.create.mockImplementation(() => stream([{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }]));
    await p.chatStream(args);
    expect((await p.chat(args)).content).toBe("OK");
    expect(p.client.responses.create).toHaveBeenCalledTimes(2);
  });

  it("learns a clean Chat stream but not a late error", async () => {
    const p = provider(); p.client.responses.create.mockRejectedValue(rejected());
    p.client.chat.completions.create.mockImplementation(() => stream([{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }]));
    await p.chatStream(args); await p.chatStream(args);
    expect(p.client.responses.create).toHaveBeenCalledOnce();
    chatExceptions.clear();
    p.client.chat.completions.create.mockImplementation(async function* () {
      yield { choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] };
      throw rejected();
    });
    expect((await p.chatStream(args)).errorShouldRetry).toBe(false);
    await p.chatStream(args);
    expect(p.client.responses.create).toHaveBeenCalledTimes(3);
  });

  it("never switches or retries after Responses accepts a stream", async () => {
    const p = provider(); p.client.responses.create.mockImplementation(async function* () {
      yield { type: "response.output_text.delta", delta: "partial" }; throw rejected();
    });
    const result = await p.chatStreamWithRetry(args);
    expect(result.errorShouldRetry).toBe(false);
    expect(p.client.responses.create).toHaveBeenCalledOnce();
    expect(p.client.chat.completions.create).not.toHaveBeenCalled();
  });

  it("preserves raw reasoning, item IDs and tool results on the next request", async () => {
    const p = provider(); const items = [
      { type: "reasoning", id: "rs_1", encrypted_content: "opaque", summary: [] },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{}" },
    ];
    p.client.responses.create.mockResolvedValueOnce({ status: "completed", output: items });
    const first = await p.chat(args);
    const history = [...args.messages, { role: "assistant", content: "", tool_calls: first.toolCalls.map(call => call.toOpenAIToolCall()), memmy_protocol_state: first.protocolState },
      { role: "tool", tool_call_id: first.toolCalls[0].id, content: "result" }];
    const body = p.buildResponsesBody({ ...args, messages: history });
    expect(body.input.slice(1, 3)).toEqual(items);
    expect(body.input[3]).toEqual({ type: "function_call_output", call_id: "call_1", output: "result" });
    p.client.responses.create.mockRejectedValue(rejected());
    await p.chat({ ...args, messages: history });
    expect(p.client.chat.completions.create).not.toHaveBeenCalled();
    p.apiKeyForClient = "different-scope";
    expect(p.buildResponsesBody({ ...args, messages: history }).input.some((item: any) => item.type === "reasoning")).toBe(false);
  });

  it("keeps bridge state in sync and stream parsing", () => {
    const state = { version: 1, protocol: "responses", scope: "scope", items: [{ type: "reasoning", id: "rs", encrypted_content: "opaque" }] };
    expect(provider().parseResponse({ choices: [{ message: { content: "OK", memmy_protocol_state: state }, finish_reason: "stop" }] }).protocolState).toEqual(state);
    expect(OpenAICompatProvider.parseChunks([{ choices: [{ delta: { memmy_protocol_state: state }, finish_reason: "stop" }] }]).protocolState).toEqual(state);
    expect(convertMessages([{ role: "assistant", content: "", memmy_protocol_state: state }], "other")[1]).toEqual([]);
  });

  it("does not persist browser sign-in values in raw function items", () => {
    const result = new LLMResponse({ content: null,
      toolCalls: [new ToolCallRequest({ id: "call|fc", name: "browser_auth_request", arguments: { provided_values: { password: "secret" } } })],
      protocolState: { items: [{ type: "function_call", name: "browser_auth_request", call_id: "call", arguments: '{"provided_values":{"password":"secret"}}' }] },
    });
    expect(JSON.stringify(result.protocolState)).not.toContain("secret");
    expect(result.toolCalls[0].arguments.provided_values.password).toBe("secret");
  });
});

describe("bounded fixed-expiry exception cache", () => {
  it("expires hot entries and evicts least-recently-used entries", () => {
    let now = 0; const cache = new ChatExceptionCache(2, 10, () => now);
    cache.remember("a"); cache.remember("b"); now = 5; expect(cache.has("a")).toBe(true);
    cache.remember("a"); cache.remember("c"); expect(cache.has("b")).toBe(false);
    now = 10; expect(cache.has("a")).toBe(false); expect(cache.has("c")).toBe(true);
  });
  it("excludes prompt values but retains request capability differences", () => {
    const first = protocolPreferenceKey("scope", { ...args, tools: [] });
    expect(protocolPreferenceKey("scope", { ...args, messages: [{ role: "user", content: "changed" }], tools: [] })).toBe(first);
    expect(protocolPreferenceKey("scope", { ...args, tools: [{ type: "function" }] })).not.toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(["/v1/responses-disabled is not supported", "Unknown parameter tools for Responses API", "Do not use /v1/responses it is not supported", "Not found"])("rejects ambiguous evidence: %s", message => {
    expect(rejectsProtocol(rejected(404, message), true)).toBe(false);
  });
});
