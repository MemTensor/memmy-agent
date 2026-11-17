import { describe, expect, it } from "vitest";
import { ASSIST_REVIEW_TIMEOUT_MS, createAssistReviewer, type AssistReviewModel } from "../assist/review.js";

const CONTENT = {
  requesterName: "孙起",
  title: "清一下缓存后重新复现",
  reason: "本机复现不了分享弹窗的问题",
  items: ["删除 ~/Library/Caches/memmy 后重新打开 Memmy"],
  attachments: [{ name: "setup.sh", content: "#!/bin/sh\nrm -rf ~/Downloads/tmp" }]
};

const ANSWER = JSON.stringify({
  sensitive: [{ action: "删除下载目录里的文件", reason: "附带的脚本会删除下载目录里的文件" }],
  injected: false,
  reason: "附带的脚本会删除下载目录里的文件"
});

/** 一次调用：记下请求的地址与正文，回一段固定的回答。 */
function fakeFetch(answer: string) {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
    calls.push({ url: String(url), body: JSON.parse(init.body ?? "{}"), headers: init.headers ?? {} });
    const lower = String(url);
    if (lower.includes(":generateContent")) {
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: answer }] } }] })
      };
    }
    if (lower.includes("/v1/messages")) {
      return { ok: true, json: async () => ({ content: [{ type: "text", text: answer }] }) };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: answer } }] }) };
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

function reviewerFor(model: AssistReviewModel, answer = ANSWER) {
  const { calls, fetchImpl } = fakeFetch(answer);
  const reviewer = createAssistReviewer({ resolveModel: async () => model, fetch: fetchImpl });
  return { calls, reviewer };
}

describe("the review model call", () => {
  it("turns thinking off for the account model and asks for a long enough answer", async () => {
    const { calls, reviewer } = reviewerFor({
      providerName: "memmy_account",
      model: "agent_chat",
      apiBase: "https://api.memmy.cn/api/agent",
      apiKey: "k"
    });

    const result = await reviewer.reviewExecutor(CONTENT);

    expect(result?.sensitive[0]?.action).toBe("删除下载目录里的文件");
    const body = calls[0]!.body;
    expect(body.enable_thinking).toBe(false);
    expect(body.temperature).toBe(0.1);
    // 4096 是上限：关不掉思考的模型也要留出写正文的余量。
    expect(body.max_tokens).toBe(4096);
  });

  it("disables thinking the deepseek way", async () => {
    const { calls, reviewer } = reviewerFor({
      providerName: "deepseek",
      model: "deepseek-v4.1-flash-1017",
      apiBase: "https://api.deepseek.com",
      apiKey: "k"
    });

    await reviewer.reviewExecutor(CONTENT);

    expect(calls[0]!.body.thinking).toEqual({ type: "disabled" });
    expect(calls[0]!.body.enable_thinking).toBeUndefined();
  });

  it("keeps extraBody last", async () => {
    const { calls, reviewer } = reviewerFor({
      providerName: "deepseek",
      model: "deepseek-v4.1-flash-1017",
      apiBase: "https://api.deepseek.com",
      apiKey: "k",
      extraBody: { thinking: { type: "enabled" } }
    });

    await reviewer.reviewExecutor(CONTENT);

    expect(calls[0]!.body.thinking).toEqual({ type: "enabled" });
  });

  it("turns thinking off for Gemini too", async () => {
    const { calls, reviewer } = reviewerFor({
      providerName: "gemini",
      model: "gemini-2.5-pro",
      apiBase: "https://generativelanguage.googleapis.com",
      apiKey: "k"
    });

    await reviewer.reviewExecutor(CONTENT);

    expect(calls[0]!.body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(calls[0]!.body.generationConfig.maxOutputTokens).toBe(4096);
  });

  it("keeps Anthropic as it was, without thinking", async () => {
    const { calls, reviewer } = reviewerFor({
      providerName: "anthropic",
      model: "claude-sonnet-4-5",
      apiBase: "https://api.anthropic.com",
      apiKey: "k"
    });

    await reviewer.reviewExecutor(CONTENT);

    expect(calls[0]!.body.thinking).toBeUndefined();
    expect(calls[0]!.body.max_tokens).toBe(4096);
  });

  it("gives up quietly when there is no model or the answer is not JSON", async () => {
    const none = createAssistReviewer({ resolveModel: async () => null });
    expect(await none.reviewExecutor(CONTENT)).toBeNull();

    const { reviewer } = reviewerFor({
      providerName: "deepseek",
      model: "deepseek-v4.1-flash-1017",
      apiBase: "https://api.deepseek.com",
      apiKey: "k"
    }, "我看不出风险");
    expect(await reviewer.reviewExecutor(CONTENT)).toBeNull();
  });

  it("keeps the 30 second limit", () => {
    expect(ASSIST_REVIEW_TIMEOUT_MS).toBe(30_000);
  });
});
