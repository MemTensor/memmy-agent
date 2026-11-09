import { describe, expect, it, vi } from "vitest";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";
import { LLMProvider } from "../../src/providers/base.js";
const started = { type: "usage.started", callId: "call_test", resumeToken: "private-resume" };
const delta = { choices: [{ delta: { content: "partial answer" } }] };
const settled = { type: "usage.settled", userId: "7", accountVersion: 4, callId: "call_test", usage: { promptTokens: 20, completionTokens: 10 } };
const spec = { name: "memmy_account" };

describe("credits transport", () => {
  it("does not retry a reserved balance or classify it as exhausted", async () => {
    const provider = new OpenAICompatProvider({ spec, apiBase: "http://127.0.0.1/v1", apiKey: "fake" });
    const create = vi.fn().mockRejectedValue({status:409, error:{code:"CREDIT_BALANCE_RESERVED", message:"积分暂被其他调用占用"}, message:"reserved"});
    (provider as any).client = {chat:{completions:{create}}};
    const result = await provider.chatStream({messages:[{role:"user",content:"test"}]});
    expect(result.errorCode).toBe("credit_balance_reserved");
    expect(result.errorCategory).not.toBe("quota_exhausted");
    expect(result.content).toContain("CREDIT_BALANCE_RESERVED");
    expect(LLMProvider.isTransientResponse(result)).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("keeps a successful final call successful even when the account reaches zero", () => {
    const result = OpenAICompatProvider.parseChunks([started, delta,
      {choices:[{delta:{},finish_reason:"stop"}]}, {...settled, balance:"0.00"}], spec);
    expect(result.finishReason).toBe("stop");
    expect(result.content).toBe("partial answer");
    expect(result.errorCategory).toBeNull();
  });
  it("stops a completed sync response that exhausts credits without executing its tools", () => {
    const provider = new OpenAICompatProvider({ spec, apiBase: "http://127.0.0.1/v1", apiKey: "fake" });
    const result = provider.parseResponse({
      code: "CREDIT_INSUFFICIENT", message: "积分不足",
      choices: [{ message: { content: "saved result", tool_calls: [
        { id: "tool_1", type: "function", function: { name: "execute", arguments: "{}" } },
      ] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    });
    expect(result.finishReason).toBe("error");
    expect(result.errorCategory).toBe("quota_exhausted");
    expect(result.partialContent).toBe("saved result");
    expect(result.toolCalls).toEqual([]);
    expect(result.usage.prompt_tokens).toBe(20);
    expect(LLMProvider.isTransientResponse(result)).toBe(false);
  });
  it("keeps an interrupted gateway result as an error with partial content", () => {
    const result = OpenAICompatProvider.parseChunks([started, delta,
      { error: { code: "CREDIT_CALL_INTERRUPTED", message: "模型连接中断，可保留现有内容后继续" }, retryable: false }, settled], spec);
    expect(result.finishReason).toBe("error");
    expect(result.errorCode).toBe("credit_call_interrupted");
    expect(result.partialContent).toBe("partial answer");
    expect(LLMProvider.isTransientResponse(result)).toBe(false);
  });
  it.each(["GENERATE_TITLE", "SESSION_DAG"] as const)("labels %s only for the account gateway", billingOperation => {
    const args = { messages: [{ role: "user", content: "title input" }], billingOperation };
    const account = new OpenAICompatProvider({ spec, apiBase: "http://127.0.0.1/v1", apiKey: "fake" });
    const byok = new OpenAICompatProvider({ spec: { name: "openai" }, apiBase: "http://127.0.0.1/v1", apiKey: "fake" });
    expect((account as any).buildKwargs(args).billingOperation).toBe(billingOperation);
    expect((byok as any).buildKwargs(args)).not.toHaveProperty("billingOperation");
    expect((account as any).buildKwargs({ messages: args.messages })).not.toHaveProperty("billingOperation");
  });
  it("retains partial content and confirmed token usage when credits run out", () => {
    const result = OpenAICompatProvider.parseChunks([started, delta,
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } },
      { code: "CREDIT_INSUFFICIENT", message: "insufficient", details: { resumeToken: "secret" } }, settled], spec);
    expect(result.errorCategory).toBe("quota_exhausted");
    expect(result.partialContent).toBe("partial answer");
    expect(result.usage.prompt_tokens).toBe(20);
    expect(result.creditSettlement).toEqual({ userId: "7", accountVersion: 4, callId: "call_test" });
    expect(JSON.stringify(result)).not.toContain("private-resume");
  });
  it("replays the same call after a transport failure without duplicating visible deltas", async () => {
    const create = vi.fn().mockImplementationOnce(async () => (async function* () { yield started; yield delta; throw new Error("socket reset"); })())
      .mockImplementationOnce(async () => (async function* () { yield started; throw new Error("socket reset again"); })())
      .mockImplementationOnce(async () => (async function* () { yield started; yield delta; yield settled; })())
      .mockImplementation(async () => (async function* () { yield started; yield delta; yield settled; })());
    const provider = new OpenAICompatProvider({ spec, apiBase: "http://127.0.0.1/v1", apiKey: "fake" });
    (provider as any).client = { chat: { completions: { create } } };
    const onContentDelta = vi.fn();
    const args = { messages: [{ role: "user", content: "test" }], onContentDelta };
    const failed = await provider.chatStream(args);
    expect(failed.partialContent).toBe("partial answer");
    expect((await provider.chatStream(args)).partialContent).toBe("partial answer");
    const replay = await provider.chatStream(args);
    expect(create.mock.calls[1][0]).toMatchObject({ callId: "call_test", resumeToken: "private-resume" });
    expect(replay.content).toBe("partial answer");expect(onContentDelta).toHaveBeenCalledTimes(1);
    await provider.chatStream({ ...args });
    expect(create.mock.calls[3][0]).not.toHaveProperty("callId");
    expect(onContentDelta).toHaveBeenCalledTimes(2);
  });
});
