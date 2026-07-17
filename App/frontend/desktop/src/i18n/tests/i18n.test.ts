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
});
