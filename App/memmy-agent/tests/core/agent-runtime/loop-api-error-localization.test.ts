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
  return new LLMResponse({
    content: "Error calling LLM: provider detail",
    finishReason: "error",
    errorCategory: "quota_exhausted",
  });
}

function reserveStandaloneSession(agent: AgentLoop, chatId: string): void {
  agent.sessions.reserveWebuiSessionBinding(`websocket:${chatId}`, {
    projectId: null,
    cwd: fs.realpathSync(agent.workspace),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("AgentLoop WebUI API error localization", () => {
  it("uses a Chinese fallback for WebUI API errors in Chinese mode", async () => {
    const agent = loopWithResponse(apiErrorResponse());
    reserveStandaloneSession(agent, "chat-zh");

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
    reserveStandaloneSession(agent, "chat-en");

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
    reserveStandaloneSession(agent, "chat-quota-zh");

    const outbound = await agent.processMessage(
      new InboundMessage({
        channel: "websocket",
        chatId: "chat-quota-zh",
        senderId: "user",
        content: "用Gmail发邮件",
        metadata: { webui: true, webui_language: "zh-CN" },
      }),
    );

    expect(outbound?.content).toBe("当前模型额度已用完");
    expect(outbound?.metadata.modelErrorCategory).toBe("quota_exhausted");
    expect(outbound?.content).not.toBe("平台服务响应异常，请稍后重试。");
  });

  it("shows a quota-specific English message when the model token quota is exhausted", async () => {
    const agent = loopWithResponse(quotaErrorResponse());
    reserveStandaloneSession(agent, "chat-quota-en");

    const outbound = await agent.processMessage(
      new InboundMessage({
        channel: "websocket",
        chatId: "chat-quota-en",
        senderId: "user",
        content: "send an email via gmail",
        metadata: { webui: true, webui_language: "en-US" },
      }),
    );

    expect(outbound?.content).toBe("This model's quota has been used up.");
    expect(outbound?.metadata.modelErrorCategory).toBe("quota_exhausted");
  });

  it("keeps the raw provider error outside WebUI", async () => {
    const agent = loopWithResponse(apiErrorResponse());

    const outbound = await agent.processDirect("hello", { sessionKey: "cli:api-error" });

    expect(outbound?.content).toBe("Error: API returned empty choices.");
  });
});
