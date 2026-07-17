/** Account channel tests. */
import { describe, expect, it } from "vitest";
import { resolveDesktopAccountChannel, resolveDesktopDisplayLanguage } from "../account-channel.js";

describe("resolveDesktopAccountChannel", () => {
  it("默认使用手机号通道，国际版可切换邮箱通道", () => {
    expect(resolveDesktopAccountChannel()).toBe("phone");
    expect(resolveDesktopAccountChannel("phone")).toBe("phone");
    expect(resolveDesktopAccountChannel("email")).toBe("email");
    expect(resolveDesktopAccountChannel(" EMAIL ")).toBe("email");
  });

  it("未显式选择语言时，中国版默认中文，国际版默认英文", () => {
    expect(resolveDesktopDisplayLanguage(undefined, "phone")).toBe("zh-CN");
    expect(resolveDesktopDisplayLanguage("system", "phone")).toBe("zh-CN");
    expect(resolveDesktopDisplayLanguage(undefined, "email")).toBe("en-US");
    expect(resolveDesktopDisplayLanguage("system", "email")).toBe("en-US");
  });

  it("保留用户显式选择的界面语言", () => {
    expect(resolveDesktopDisplayLanguage("zh-CN", "email")).toBe("zh-CN");
    expect(resolveDesktopDisplayLanguage("en-US", "phone")).toBe("en-US");
  });
});
