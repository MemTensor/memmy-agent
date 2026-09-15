import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { SocialLoginButtons } from "../social-login-buttons.js";

describe("SocialLoginButtons", () => {
  it("shows the official Google and GitHub choices", () => {
    const html = renderToString(
      <I18nProvider language="en-US">
        <SocialLoginButtons pendingProvider={null} onLogin={vi.fn()} />
      </I18nProvider>
    );

    expect(html).toContain("Continue with Google");
    expect(html).toContain("Continue with GitHub");
    expect(html).toContain("#4285F4");
    expect(html).toContain("flex flex-col gap-3");
    expect(html).not.toContain("grid-cols-2");
  });

  it("shows browser completion feedback while a provider is pending", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <SocialLoginButtons
          pendingProvider="github"
          feedback={{ text: "请在浏览器中完成登录…", tone: "success" }}
          onLogin={vi.fn()}
        />
      </I18nProvider>
    );

    expect(html).toContain("正在打开…");
    expect(html).toContain("请在浏览器中完成登录…");
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });
});
