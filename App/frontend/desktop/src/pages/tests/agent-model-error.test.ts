import { describe, expect, it } from "vitest";
import { formatAgentModelError, formatRetryWaitStatus, isAgentModelErrorContent, shouldSuppressRetryWaitStatus } from "../agent-model-error.js";

const t = (key: string, values?: Record<string, string | number>) => {
  if (key === "agent.error.connectionFailed") return "无法连接到模型服务";
  if (key === "agent.error.retrying") return `${values?.seconds}s 后重试（第 ${values?.attempt} 次）`;
  if (key === "agent.error.givingUp") return "模型请求多次重试后仍失败";
  if (key === "agent.error.modelFailed") return "模型请求失败";
  if (key === "agent.error.quotaExceeded") return "当前模型额度已用完";
  return key;
};

describe("agent-model-error", () => {
  it("detects provider error messages", () => {
    expect(isAgentModelErrorContent("Error: 503 upstream connect error")).toBe(true);
    expect(isAgentModelErrorContent("Error calling LLM: missing key")).toBe(true);
    expect(isAgentModelErrorContent("正常回答")).toBe(false);
  });

  it("formats connection failures into user-facing copy", () => {
    expect(formatAgentModelError("Error: 503 upstream connect error or disconnect/reset before headers", t).title).toBe("无法连接到模型服务");
  });

  it("maps auth failures to login-expired copy in account mode", () => {
    expect(formatAgentModelError("Error calling LLM: 401 Unauthorized", t, { accountMode: true }).title).toBe("agent.error.loginExpired");
    expect(formatAgentModelError("Error: invalid api key provided", t, { accountMode: true }).title).toBe("agent.error.loginExpired");
  });

  it("keeps API-key copy for auth failures outside account mode", () => {
    expect(formatAgentModelError("Error calling LLM: 401 Unauthorized", t).title).toBe("agent.error.authFailed");
    expect(formatAgentModelError("Error: invalid api key provided", t, { accountMode: false }).title).toBe("agent.error.authFailed");
  });

  it("formats only a structured quota category as quota exhausted", () => {
    expect(
      formatAgentModelError("raw provider detail", t, {
        modelError: { category: "quota_exhausted" }
      })
    ).toEqual({ title: "当前模型额度已用完", detail: null });
  });

  it("does not infer quota exhaustion from error text", () => {
    expect(formatAgentModelError("Error calling LLM: insufficient quota", t)).toEqual({
      title: "模型请求失败",
      detail: "insufficient quota"
    });
  });

  it("localizes retry wait status text", () => {
    expect(formatRetryWaitStatus("Model request failed, retrying attempt 2 in 2s...", t)).toBe("2s 后重试（第 2 次）");
    expect(formatRetryWaitStatus("Model request failed after 4 retries, giving up.", t)).toBe("模型请求多次重试后仍失败");
  });

  it("suppresses giving-up retry status when a model error message follows", () => {
    expect(shouldSuppressRetryWaitStatus(
      {
        id: "retry-1",
        chatId: "chat-1",
        anchorMessageId: "question",
        text: "Model request failed after 4 retries, giving up.",
        isRunning: false,
        createdAt: 1,
        updatedAt: 2
      },
      [
        { id: "question", role: "user", content: "你好" },
        { id: "error", role: "assistant", content: "Error: 503 upstream connect error" }
      ]
    )).toBe(true);
  });

  it("suppresses any retry wait status when a structured quota terminal follows", () => {
    expect(shouldSuppressRetryWaitStatus(
      {
        id: "retry-quota",
        chatId: "chat-1",
        anchorMessageId: "question",
        text: "Model request failed, retrying attempt 1 in 1s...",
        isRunning: true,
        createdAt: 1,
        updatedAt: 2
      },
      [
        { id: "question", role: "user", content: "你好" },
        {
          id: "error",
          role: "assistant",
          content: "raw provider detail",
          modelError: { category: "quota_exhausted" }
        }
      ]
    )).toBe(true);
  });
});
