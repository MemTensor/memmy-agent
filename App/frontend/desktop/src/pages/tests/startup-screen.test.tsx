/** Startup screen tests. */
import { renderToString } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { WINDOW_CONTROLS_OVERLAY_SAFE_TOP_STYLE } from "../../theme/window-controls-overlay.js";
import { StartupScreen } from "../startup-screen.js";

describe("StartupScreen", () => {
  it("quiet loading does not render the full startup copy", () => {
    const html = renderStartup(<StartupScreen quiet />);

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("正在刷新页面");
    expect(html).toContain("正在恢复当前页面和后台状态。");
    expect(WINDOW_CONTROLS_OVERLAY_SAFE_TOP_STYLE.top).toBe("calc(1rem + env(titlebar-area-height, 0px))");
    expect(html).toContain("top:calc(1rem + env(titlebar-area-height, 0px))");
    expect(html).not.toContain("Memmy 启动中");
    expect(html).not.toContain("Memmy 正在连接本地记忆服务");
  });

  it("quiet error still renders the retryable error page", () => {
    const html = renderStartup(<StartupScreen quiet message="boom" onRetry={() => undefined} />);

    expect(html).toContain("启动失败");
    expect(html).toContain("boom");
    expect(html).toContain("重试");
  });

  it("full loading uses welcome mascot and title without card chrome", () => {
    const html = renderStartup(<StartupScreen />);

    expect(html).toContain("Memmy");
    expect(html).toContain("Starting");
    expect(html).not.toContain("Memmy 启动中");
    expect(html).toContain('class="sr-only"');
    expect(html).not.toContain('class="text-sm text-text-ink/60 mt-2 leading-relaxed">正在准备本地运行环境和应用状态。');
    expect(html).not.toContain('class="text-sm font-semibold text-text-ink/55">Memmy</p>');
    expect(html).not.toContain("bg-background-paper");
    expect(html).toContain("memmy-wave");
  });
});

function renderStartup(node: ReactElement): string {
  return renderToString(<I18nProvider language="zh-CN">{node}</I18nProvider>);
}
