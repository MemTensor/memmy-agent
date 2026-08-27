import { describe, expect, it } from "vitest";
import { formatAgentModelError, formatRetryWaitStatus, isAgentModelErrorContent, shouldSuppressRetryWaitStatus } from "../agent-model-error.js";

const t = (key: string, values?: Record<string, string | number>) => {
  if (key === "agent.error.connectionFailed") return "无法连接到模型服务";
  if (key === "agent.error.retrying") return `${values?.seconds}s 后重试（第 ${values?.attempt} 次）`;
  if (key === "agent.error.givingUp") return "模型请求多次重试后仍失败";
  if (key === "agent.error.modelFailed") return "模型请求失败";
  if (key === "agent.error.quotaExceeded") return "当前模型 Token 余额不足，请更换模型后重试";
  if (key === "agent.error.imageInputUnsupported") return "当前模型不支持图片输入，请切换到支持多模态能力的模型后重试";
  if (key === "agent.error.imageAnalysisFailed") return "图片解析失败，请稍后重试";
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

  it("maps auth failures to login-expired copy only for the actual account source", () => {
    expect(formatAgentModelError("Error calling LLM: 401 Unauthorized", t, {
      modelError: { category: "model_failed", source: "account" }
    }).title).toBe("agent.error.loginExpired");
    expect(formatAgentModelError("Error: invalid api key provided", t, {
      modelError: { category: "model_failed", source: "account" }
    }).title).toBe("agent.error.loginExpired");
  });

  it("keeps API-key copy for BYOK auth failures even when the app is in account mode", () => {
    expect(formatAgentModelError("Error calling LLM: 401 Unauthorized", t).title).toBe("agent.error.authFailed");
    expect(formatAgentModelError("Error: invalid api key provided", t, {
      modelError: { category: "model_failed", source: "byok" }
    }).title).toBe("agent.error.authFailed");
  });

  it("formats a structured quota category without dropping its raw detail", () => {
    expect(
      formatAgentModelError("localized fallback", t, {
        modelError: { category: "quota_exhausted", detail: "Error: raw provider detail 40309" }
      })
    ).toEqual({
      title: "当前模型 Token 余额不足，请更换模型后重试",
      detail: "Error: raw provider detail 40309"
    });
  });

  it("identifies image2text as the source of an internal quota error", () => {
    expect(formatAgentModelError("localized fallback", t, {
      modelError: {
        category: "quota_exhausted",
        detail: "Error: account quota exhausted",
        failedProvider: "memmy_account",
        failedModel: "image2text"
      }
    })).toEqual({
      title: "当前模型 Token 余额不足，请更换模型后重试",
      detail: "memmy_account/image2text: Error: account quota exhausted"
    });
  });

  it("formats a structured generic model failure without dropping its raw detail", () => {
    expect(
      formatAgentModelError("localized fallback", t, {
        modelError: { category: "model_failed", detail: "Error: raw provider failure" }
      })
    ).toEqual({
      title: "模型请求失败",
      detail: "Error: raw provider failure"
    });
  });

  it("formats image input rejection as a dedicated model error", () => {
    expect(formatAgentModelError("localized fallback", t, {
      modelError: {
        category: "image_input_unsupported",
        source: "byok",
        detail: "Error: image_url is not supported"
      }
    })).toEqual({
      title: "当前模型不支持图片输入，请切换到支持多模态能力的模型后重试",
      detail: "Error: image_url is not supported"
    });
  });

  it("formats image analysis failure and identifies the internal failed model", () => {
    expect(formatAgentModelError("localized fallback", t, {
      modelError: {
        category: "image_analysis_failed",
        source: "account",
        model: "agent_chat",
        failedProvider: "memmy_account",
        failedModel: "image2text",
        detail: "Error: upstream unavailable"
      }
    })).toEqual({
      title: "图片解析失败，请稍后重试",
      detail: "memmy_account/image2text: Error: upstream unavailable"
    });
  });

  it("keeps specific auth classification for structured model failures", () => {
    expect(
      formatAgentModelError("localized fallback", t, {
        modelError: { category: "model_failed", detail: "Error calling LLM: 401 Unauthorized" }
      })
    ).toEqual({
      title: "agent.error.authFailed",
      detail: "Error calling LLM: 401 Unauthorized"
    });
  });

  it("classifies an exact legacy 40309 before the generic 403 auth branch", () => {
    expect(formatAgentModelError("Error calling LLM: code 40309\nraw provider detail", t)).toEqual({
      title: "当前模型 Token 余额不足，请更换模型后重试",
      detail: "Error calling LLM: code 40309\nraw provider detail"
    });
  });

  it("does not infer quota exhaustion from error text", () => {
    expect(formatAgentModelError("Error calling LLM: insufficient quota", t)).toEqual({
      title: "模型请求失败",
      detail: "Error calling LLM: insufficient quota"
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
