/** Memory page tests. */
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { MemoryPageView, readMemorySubPage, writeMemorySubPage, type MemorySubPageId } from "../memory-page.js";

describe("MemoryPageView", () => {
  it("默认落在概览并渲染全部子导航", () => {
    const html = renderMemoryPage("overview");

    expect(html).toContain("memory-page-back-button");
    expect(html).toContain("memory-page-return-row");
    expect(html).toContain('data-icon="panel-left"');
    expect(html).toContain('data-icon="arrow-left"');
    expect(html).not.toContain('data-icon="arrow-right"');
    expect(html).toContain("返回");
    expect(html).toContain('data-tour-anchor="product-tour-memory-nav"');
    expect(html).toContain('data-icon="layers"');
    expect(html).toContain('data-icon="brain-circuit"');
    expect(html).toContain("M12 5a3 3 0 1 0-5.997.125");
    expect(html).toContain('data-icon="link-2"');
    expect(html).toContain("概览");
    expect(html).toContain("记忆");
    expect(html).toContain("任务");
    expect(html).toContain("技能");
    expect(html).toContain("分析");
    expect(html).toContain("跨Agent接入");
    expect(html).not.toContain("导入导出");
    expect(html).toContain("记忆总数");
    expect(html).toContain("memory-page-sidebar");
    expect(html).toContain("memory-page-section-header");
    expect(html).toContain("app-frame-nav-button");
    expect(html).toContain("app-frame-nav-button--active");
    expect(html).not.toContain("border-r-2 border-action-sky");
    expect(html).not.toContain("app-frame-sidebar");
    expect(html).toContain("app-frame-content-topbar");
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-label="调整记忆侧边栏宽度"');
    expect(html).toContain("sidebar-resize-handle");
    expect(html).toContain("min-w-0 flex-1 flex flex-col overflow-hidden");
    expect(html).toContain("app-frame-page-content min-h-0 flex-1 overflow-y-auto py-6");
    expect(html).not.toContain("memmy-read.png");
    expect(html).not.toContain(">O</span>");
  });

  it("按 activePage 渲染对应子页内容", () => {
    const html = renderMemoryPage("tasks");

    expect(html).toContain("任务");
    expect(html).not.toContain("记忆总数");
  });

  it("保留 sources 作为记忆管理内嵌子页", () => {
    const html = renderMemoryPage("sources");

    expect(html).toContain("跨Agent接入");
    expect(html).toContain("同步新增");
  });

  it("保存合法的记忆子页用于刷新恢复", () => {
    const storage = new MapStorage();

    writeMemorySubPage(storage, "memories");
    expect(readMemorySubPage(storage)).toBe("memories");

    storage.setItem("memmy.memorySubPage", "unknown");
    expect(readMemorySubPage(storage)).toBeNull();
  });
});

function renderMemoryPage(activePage: MemorySubPageId): string {
  return renderToString(
    <I18nProvider language="zh-CN">
      <MemoryPageView activePage={activePage} onActivePageChange={vi.fn()} />
    </I18nProvider>
  );
}

class MapStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
