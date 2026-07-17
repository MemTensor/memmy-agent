/** Auth code form tests. */
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { AuthCodeForm } from "../auth-code-form.js";

describe("AuthCodeForm", () => {
  it("展示账号验证码校验错误", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AuthCodeForm
          identifier="1"
          code="1"
          error="请输入有效手机号或邮箱"
          onIdentifierChange={vi.fn()}
          onCodeChange={vi.fn()}
          onSendCode={vi.fn()}
          onSubmit={vi.fn()}
        />
      </I18nProvider>
    );

    expect(html).toContain("请输入有效手机号或邮箱");
    expect(html).toContain('role="alert"');
  });

  it("展示服务协议和数据协议入口", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AuthCodeForm
          identifier="13800138000"
          code="123456"
          onIdentifierChange={vi.fn()}
          onCodeChange={vi.fn()}
          onSendCode={vi.fn()}
          onSubmit={vi.fn()}
        />
      </I18nProvider>
    );

    expect(html).toContain("《服务协议》");
    expect(html).toContain("《数据协议》");
  });

  it("按账号通道展示手机号或邮箱占位文案", () => {
    const phoneHtml = renderToString(
      <I18nProvider language="en-US">
        <AuthCodeForm
          identifier=""
          identifierType="phone"
          code=""
          onIdentifierChange={vi.fn()}
          onCodeChange={vi.fn()}
          onSendCode={vi.fn()}
          onSubmit={vi.fn()}
        />
      </I18nProvider>
    );
    const emailHtml = renderToString(
      <I18nProvider language="zh-CN">
        <AuthCodeForm
          identifier=""
          identifierType="email"
          code=""
          onIdentifierChange={vi.fn()}
          onCodeChange={vi.fn()}
          onSendCode={vi.fn()}
          onSubmit={vi.fn()}
        />
      </I18nProvider>
    );

    expect(phoneHtml).toContain("Enter your phone number");
    expect(emailHtml).toContain("请输入邮箱");
  });

  it("验证码发送成功提示不再常驻在表单内", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AuthCodeForm
          identifier="13800138000"
          code=""
          feedback={{ text: "验证码已发送，请查收短信", tone: "success" }}
          onIdentifierChange={vi.fn()}
          onCodeChange={vi.fn()}
          onSendCode={vi.fn()}
          onSubmit={vi.fn()}
        />
      </I18nProvider>
    );

    expect(html).not.toContain("验证码已发送，请查收短信");
  });

  it("验证码失败提示使用红色单行告警", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AuthCodeForm
          identifier="13800138000"
          code="123456"
          feedback={{ text: "验证码已过期", tone: "error" }}
          onIdentifierChange={vi.fn()}
          onCodeChange={vi.fn()}
          onSendCode={vi.fn()}
          onSubmit={vi.fn()}
        />
      </I18nProvider>
    );

    expect(html).toContain("验证码已过期");
    expect(html).toContain('role="alert"');
    expect(html).toContain("truncate");
    expect(html).toContain("text-status-error");
  });
});
