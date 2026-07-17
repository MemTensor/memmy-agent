/** Token detail page tests. */
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../../app/providers.js";
import { TokenDetailPage } from "../token-detail-page.js";

describe("TokenDetailPage", () => {
  it("渲染原型 Token 赠送卡片和真实验证码登录表单", () => {
    const html = renderToString(
      <AppProviders>
        <TokenDetailPage />
      </AppProviders>
    );

    expect(html).toContain("welcome-login-card");
    expect(html).toContain("30,000,000");
    expect(html).toContain("可发起约 500 次完整 Agent 对话");
    expect(html).toContain("请输入手机号");
    expect(html).toContain("获取验证码");
    expect(html).toContain("登录 / 注册");
  });
});
