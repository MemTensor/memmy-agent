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
    expect(html).not.toContain("30,000,000");
    expect(html).toContain("—");
    expect(html).toContain("额外赠送 2,200 万记忆处理 Token");
    expect(html).toContain("可发起约 30 次完整 Agent 对话");
    expect(html).toContain("可自动整理 5000+ 条历史对话为记忆");
    expect(html).toContain("覆盖全功能");
    expect(html).toContain("请输入手机号");
    expect(html).toContain("获取验证码");
    expect(html).toContain("登录 / 注册");
  });
});
