import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { InboundMessage } from "../../../src/core/runtime-messages/events.js";
import { Config } from "../../../src/config/schema.js";
import { LLMResponse } from "../../../src/providers/base.js";

const roots: string[] = [];

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-loop-api-error-"));
  roots.push(dir);
  return dir;
}

function loopWithResponse(response: LLMResponse): AgentLoop {
  const root = workspace();
  const provider = {
    generation: { maxTokens: 100 },
    getDefaultModel: () => "test-model",
    chatWithRetry: vi.fn(async () => response),
    chat: vi.fn(async () => response),
  };
  return new AgentLoop({
    provider,
    workspace: root,
    model: "test-model",
    contextWindowTokens: 4096,
    sessionDir: path.join(root, "sessions"),
    config: new Config({ memmyMemory: { enabled: false } }),
  });
}

function apiErrorResponse(): LLMResponse {
  return new LLMResponse({ content: "Error: API returned empty choices.", finishReason: "error" });
}

function quotaErrorResponse(): LLMResponse {
  return new LLMResponse({ content: "Error calling LLM: REQUEST_TOKEN_QUOTA_EXCEEDED_ERROR", finishReason: "error" });
}

function billingErrorResponse(): LLMResponse {
  return new LLMResponse({ content: "Error: 403 用户额度不足，剩余额度: $ -0.039544", finishReason: "error" });
}

function rateLimitErrorResponse(): LLMResponse {
  return new LLMResponse({ content: "Error: UPSTREAM_RATE_LIMITED", finishReason: "error" });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("AgentLoop WebUI API error localization", () => {
  it("uses a Chinese fallback for WebUI API errors in Chinese mode", async () => {
    const agent = loopWithResponse(apiErrorResponse());

    const outbound = await agent.processMessage(
      new InboundMessage({
        channel: "websocket",
        chatId: "chat-zh",
        senderId: "user",
        content: "你能做什么？",
        metadata: { webui: true, webui_language: "zh-CN" },
      }),
    );

    expect(outbound?.content).toBe("平台服务响应异常，请稍后重试。");
    expect(outbound?.content).not.toContain("API returned empty choices");
  });

  it("uses an English fallback for WebUI API errors in English mode", async () => {
    const agent = loopWithResponse(apiErrorResponse());

    const outbound = await agent.processMessage(
      new InboundMessage({
        channel: "websocket",
        chatId: "chat-en",
        senderId: "user",
        content: "What can you do?",
        metadata: { webui: true, webui_language: "en-US" },
      }),
    );

    expect(outbound?.content).toBe("The platform service returned an unexpected response. Please try again later.");
    expect(outbound?.content).not.toContain("API returned empty choices");
  });

  it("shows a quota-specific Chinese message when the model token quota is exhausted", async () => {
    const agent = loopWithResponse(quotaErrorResponse());

    const outbound = await agent.processMessage(
      new InboundMessage({
        channel: "websocket",
        chatId: "chat-quota-zh",
        senderId: "user",
        content: "用Gmail发邮件",
        metadata: { webui: true, webui_language: "zh-CN" },
      }),
    );

    expect(outbound?.content).toBe("用户 Token 额度已用完");
    expect(outbound?.content).not.toBe("平台服务响应异常，请稍后重试。");
  });

  it("shows a quota-specific English message when the model token quota is exhausted", async () => {
    const agent = loopWithResponse(quotaErrorResponse());

    const outbound = await agent.processMessage(
      new InboundMessage({
        channel: "websocket",
        chatId: "chat-quota-en",
        senderId: "user",
        content: "send an email via gmail",
        metadata: { webui: true, webui_language: "en-US" },
      }),
    );

    expect(outbound?.content).toBe("Your user token quota has been used up.");
  });

  it("does not misclassify upstream dollar-balance failures as user Token exhaustion", async () => {
    const agent = loopWithResponse(billingErrorResponse());

    const outbound = await agent.processMessage(
      new InboundMessage({
        channel: "websocket",
        chatId: "chat-billing-zh",
        senderId: "user",
        content: "你好",
        metadata: { webui: true, webui_language: "zh-CN" },
      }),
    );

    expect(outbound?.content).toBe("云端模型服务计费异常");
  });

  it("uses the upstream busy message for explicit upstream rate-limit errors", async () => {
    const agent = loopWithResponse(rateLimitErrorResponse());

    const outbound = await agent.processMessage(
      new InboundMessage({
        channel: "websocket",
        chatId: "chat-rate-zh",
        senderId: "user",
        content: "你好",
        metadata: { webui: true, webui_language: "zh-CN" },
      }),
    );

    expect(outbound?.content).toBe("云端模型服务繁忙，请稍后重试");
  });

  it("keeps the raw provider error outside WebUI", async () => {
    const agent = loopWithResponse(apiErrorResponse());

    const outbound = await agent.processDirect("hello", { sessionKey: "cli:api-error" });

    expect(outbound?.content).toBe("Error: API returned empty choices.");
  });
});
