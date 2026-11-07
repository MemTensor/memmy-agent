// @vitest-environment happy-dom
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ConnectionCatalogSection } from "../connection-catalog-section.js";
import { officialPluginCatalog } from "../official-plugin-catalog.js";
import { PluginDetailPreview } from "../plugin-detail-preview.js";
import { PluginMarketplaceSection } from "../plugin-marketplace-section.js";
import type { ToolsState } from "../../state/tools-slice.js";

describe("plugin and connection catalog localization", () => {
  it.each([
    ["zh-CN", "文献综述", "用工合规诊断", "检索论文、整理证据，生成带参考文献的综述初稿。"],
    ["en-US", "Literature Review", "Employment Compliance Diagnosis", "Find papers, organize evidence, and draft a referenced literature review."]
  ])("localizes the official presentation without changing installed records in %s", (language, literature, legal, description) => {
    const catalog = officialPluginCatalog({ language, installed: [] });
    expect(catalog.map((plugin) => plugin.id)).toEqual(["literature-review", "office", "legal-labor"]);
    expect(catalog[0]?.name).toBe(literature);
    expect(catalog[0]?.description).toBe(description);
    expect(catalog[2]?.name).toBe(legal);
    expect(catalog.every((plugin) => plugin.installed === undefined)).toBe(true);
  });

  it.each([
    ["zh-CN", "任务插件", "搜索任务插件", "安装用户插件", "用户插件的使用示例", "生成一篇关于 AI Memory 的文献综述"],
    ["en-US", "Task plugins", "Search task plugins", "Install 用户插件", "Examples of using 用户插件", "Generate a literature review on AI Memory"]
  ])("localizes labels and examples while preserving supplied plugin names in %s", (language, title, search, install, caption, example) => {
    const html = renderToString(<I18nProvider language={language}>
      <PluginMarketplaceSection plugins={[{ id: "custom", name: "用户插件", description: "Supplied by the host", category: "research", installable: true }]}
        officialModelReady={true} onInstall={vi.fn()} onUpdate={vi.fn()} onUninstall={vi.fn()} onEnable={vi.fn()}
        onAddToChat={vi.fn()} onConfigureModel={vi.fn()} onRefresh={vi.fn()} />
      <PluginDetailPreview category="research" name="用户插件" />
    </I18nProvider>);
    expect(html).toContain(title);
    expect(html).toContain(search);
    expect(html).toContain(install);
    expect(html).toContain(caption);
    expect(html).toContain(example);
  });

  it.each([
    ["zh-CN", "应用工具", "搜索应用工具", "全部类别", "没有匹配的结果。"],
    ["en-US", "App tools", "Search app tools", "All categories", "No matching results."]
  ])("localizes connection filters and category options in %s", (language, title, search, category, empty) => {
    const html = renderToString(<I18nProvider language={language}>
      <ConnectionCatalogSection kind="tools" items={[]} tools={{ status: "ready", loadError: null } as ToolsState}
        search="" onSearchChange={vi.fn()} filter="all" onFilterChange={vi.fn()} connectedCount={0}
        onOpenIntegration={vi.fn()} onRefresh={vi.fn()} onCategoryChange={vi.fn()} />
    </I18nProvider>);
    for (const text of [title, search, category, empty]) expect(html).toContain(text);
  });

  it.each(["zh-CN", "en-US"])("preserves literal replacement syntax and token text in supplied names for %s", (language) => {
    const name = "User $& $` $' \\path {name} {kind}";
    const html = renderToString(<I18nProvider language={language}>
      <PluginMarketplaceSection plugins={[{ id: "literal", name, description: "Supplied by the host", category: "research", installable: true }]}
        officialModelReady={true} onInstall={vi.fn()} onUpdate={vi.fn()} onUninstall={vi.fn()} onEnable={vi.fn()}
        onAddToChat={vi.fn()} onConfigureModel={vi.fn()} onRefresh={vi.fn()} />
    </I18nProvider>);
    const rendered = document.createElement("div");
    rendered.innerHTML = html;
    expect(rendered.querySelector(".plugin-marketplace-name")?.textContent).toBe(name);
    expect(rendered.querySelector(".plugin-marketplace-icon-button")?.getAttribute("aria-label"))
      .toBe(language === "zh-CN" ? `安装${name}` : `Install ${name}`);
  });
});
