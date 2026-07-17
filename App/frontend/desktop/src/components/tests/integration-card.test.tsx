/** Integration card tests. */
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "../../integrations/connection-state.js";
import type { IntegrationMeta } from "../../integrations/integration-meta.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { IntegrationCard, integrationCardStatusClass } from "../integration-card.js";

const github: IntegrationMeta = {
  slug: "github",
  name: "GitHub",
  description: "Connect GitHub for developer workflows.",
  category: "Platform",
  logoUrl: "https://logos.composio.dev/api/github",
  permissionLabel: "Repos, records, tickets, and system data",
  authKind: "oauth",
  surface: "integration",
  identity: "integration:github",
  isChannel: false
};

describe("IntegrationCard", () => {
  it("渲染远程 logo、语义圆角和默认状态", () => {
    const html = renderCard(github);

    expect(html).toContain("https://logos.composio.dev/api/github");
    expect(html).toContain("rounded-card");
    expect(html).toContain("integration-card-status-default");
    expect(html).toContain("GitHub");
  });

  it("默认卡片渲染 logo、名称和空状态行，不渲染分类行", () => {
    const html = renderCard(github);

    expect(html).toContain("integration-card-logo");
    expect(html).toContain("integration-card-content");
    expect(html).toContain("integration-card-name");
    expect(html).toContain("integration-card-state-label");
    expect(html).toContain("text-text-ink/45");
    expect(html).not.toContain("min-h-[148px]");
    expect(html).not.toContain(">Platform<");
  });

  it("有连接操作态时不改变 logo 和名称 class，只更新状态行文字", () => {
    const defaultHtml = renderCard(github);
    const connected = renderCard(github, { id: "conn-github", toolkit: "github", status: "ACTIVE" });
    const pending = renderCard(github, { id: "conn-github", toolkit: "github", status: "INITIATED" });

    expect(defaultHtml).toContain("integration-card-logo");
    expect(defaultHtml).toContain("integration-card-name");
    expect(defaultHtml).toContain("integration-card-state-label");
    expect(connected).toContain("integration-card-logo");
    expect(connected).toContain("integration-card-content");
    expect(connected).toContain("integration-card-name");
    expect(connected).not.toContain("h-14 w-14");
    expect(connected).toContain("Connected");
    expect(connected).toContain("integration-card-state-label");
    expect(connected).toContain("integration-card-status-connected");
    expect(pending).toContain("Connecting");
    expect(pending).toContain("integration-card-state-label");
    expect(pending).toContain("integration-card-status-connecting");
  });

  it("授权过期时显示红色中文状态", () => {
    const html = renderCard(github, { id: "conn-github", toolkit: "github", status: "EXPIRED" }, "zh-CN");

    expect(html).toContain("授权已过期");
    expect(html).toContain("integration-card-state-label");
    expect(html).toContain("text-status-error");
    expect(html).toContain("integration-card-status-error");
  });

  it("状态 class 来自连接状态派生", () => {
    expect(integrationCardStatusClass("connected")).toBe("integration-card-status-connected");
    expect(integrationCardStatusClass("pending")).toBe("integration-card-status-connecting");
    expect(integrationCardStatusClass("error")).toBe("integration-card-status-error");
  });
});

function renderCard(meta: IntegrationMeta, connection?: IntegrationConnection, language: "zh-CN" | "en-US" = "en-US"): string {
  return renderToString(
    <I18nProvider language={language}>
      <IntegrationCard meta={meta} connection={connection} onClick={vi.fn()} />
    </I18nProvider>
  );
}
