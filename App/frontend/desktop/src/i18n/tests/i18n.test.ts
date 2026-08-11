/** I18n tests. */
import { describe, expect, it } from "vitest";
import { formatMessage, messageCatalogs, resolveLanguage } from "../messages.js";

describe("desktop i18n helpers", () => {
  it("falls back to zh-CN when language follows system or is unsupported", () => {
    expect(resolveLanguage("system")).toBe("zh-CN");
    expect(resolveLanguage("en-US")).toBe("en-US");
    expect(resolveLanguage("fr-FR")).toBe("zh-CN");
  });

  it("formats named placeholders without leaking braces", () => {
    expect(formatMessage("剩余 {count} Token", { count: 30000000 })).toBe("剩余 30000000 Token");
  });

  it("formats the welcome Agent trial quota from runtime values", () => {
    expect(formatMessage(messageCatalogs["zh-CN"]["welcome.gift"], { count: "2,000,000" }))
      .toBe("注册即送 2,000,000 Agent 任务体验 Token，开箱即用");
    expect(formatMessage(messageCatalogs["en-US"]["welcome.gift"], { count: "2,000,000" }))
      .toBe("Sign up to get 2,000,000 task tokens, ready to use");
  });

  it("localizes the Token gift details in Chinese and English", () => {
    expect(messageCatalogs["zh-CN"]["welcome.gift.detail.subtitle"])
      .toBe("额外赠送 2,200 万记忆处理 Token");
    expect(messageCatalogs["zh-CN"]["welcome.gift.detail.bullet.conversations"])
      .toBe("可发起约 30 次完整 Agent 对话");
    expect(messageCatalogs["zh-CN"]["welcome.gift.detail.bullet.memories"])
      .toBe("可自动整理 5000+ 条历史对话为记忆");
    expect(messageCatalogs["zh-CN"]["welcome.gift.detail.bullet.features"])
      .toBe("覆盖全功能");
    expect(messageCatalogs["en-US"]["welcome.gift.detail.subtitle"])
      .toBe("Includes an extra 22M tokens for memory processing");
    expect(messageCatalogs["en-US"]["welcome.gift.detail.bullet.conversations"])
      .toBe("Start about 30 complete Agent conversations");
    expect(messageCatalogs["en-US"]["welcome.gift.detail.bullet.memories"])
      .toBe("Automatically organize 5,000+ historical conversations into memories");
    expect(messageCatalogs["en-US"]["welcome.gift.detail.bullet.features"])
      .toBe("Full feature access");
  });

  it("uses native language names for language choices", () => {
    expect(messageCatalogs["en-US"]["settings.general.language.zh"]).toBe("中文");
  });

  it("uses task wording for the rename dialog in Chinese and English", () => {
    expect(messageCatalogs["zh-CN"]["appFrame.renameTaskPrompt"]).toBe("重命名任务");
    expect(messageCatalogs["en-US"]["appFrame.renameTaskPrompt"]).toBe("Rename task");
    expect(messageCatalogs["zh-CN"]["appFrame.task.rename"]).toBe("重命名任务");
    expect(messageCatalogs["en-US"]["appFrame.task.rename"]).toBe("Rename task");
  });

  it("keeps account verification errors localized per language", () => {
    expect(messageCatalogs["zh-CN"]["login.error.invalidCode"]).toBe("验证码错误");
    expect(messageCatalogs["zh-CN"]["login.error.invalidPhone"]).toBe("手机号格式错误");
    expect(messageCatalogs["zh-CN"]["login.error.invalidEmail"]).toBe("邮箱格式错误");
    expect(messageCatalogs["en-US"]["login.error.invalidCode"]).toBe("Incorrect verification code");
    expect(messageCatalogs["en-US"]["login.error.invalidPhone"]).toBe("Phone number format is incorrect");
    expect(messageCatalogs["en-US"]["login.error.invalidEmail"]).toBe("Email address format is incorrect");
    expect(messageCatalogs["zh-CN"]["home.agent.platformApiFallback"]).toBe("抱歉，刚刚没有拿到有效回复，请稍后再试一次。");
    expect(messageCatalogs["en-US"]["home.agent.platformApiFallback"]).toBe("Sorry, I couldn't get a valid response. Please try again in a moment.");
  });

  it("keeps the four governed error notices aligned in Chinese and English", () => {
    expect(messageCatalogs["zh-CN"]["agent.error.quotaExceeded"])
      .toBe("当前模型 Token 余额不足，请更换模型后重试");
    expect(messageCatalogs["en-US"]["agent.error.quotaExceeded"])
      .toBe("The current model has insufficient tokens. Switch models and try again.");
    expect(messageCatalogs["zh-CN"]["agent.error.modelFailed"])
      .toBe("模型请求失败，请稍后重试");
    expect(messageCatalogs["en-US"]["agent.error.modelFailed"])
      .toBe("The model request failed. Please try again later.");
    expect(messageCatalogs["zh-CN"]["memory.memories.processing.quotaExhaustedTitle"])
      .toBe("当前模型 Token 余额不足，记忆处理失败，请更换模型后重试");
    expect(messageCatalogs["en-US"]["memory.memories.processing.quotaExhaustedTitle"])
      .toBe("The current model has insufficient tokens. Memory processing failed. Switch models and try again.");
    expect(messageCatalogs["zh-CN"]["memory.memories.processing.autoRetryScheduledTitle"])
      .toBe("记忆处理失败，稍后将自动重试");
    expect(messageCatalogs["en-US"]["memory.memories.processing.autoRetryScheduledTitle"])
      .toBe("Memory processing failed. It will retry automatically later.");
  });
});
