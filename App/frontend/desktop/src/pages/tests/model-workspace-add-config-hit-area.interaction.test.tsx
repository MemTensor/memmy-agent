// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ModelWorkspaceSection } from "../model-workspace-section.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

describe("model workspace add configuration hit area", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/settings#model-config");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("keeps the add button below the native drag region and opens its editor", () => {
    act(() => {
      root.render(
        <div className="settings-page">
          <div className="app-frame-page-content max-w-2xl mx-auto py-8">
            <I18nProvider language="zh-CN">
              <ModelWorkspaceSection mode="account" />
            </I18nProvider>
          </div>
        </div>
      );
    });

    const dragRegionRule = styles.match(/\.window-drag-region\s*\{[^}]*\}/)?.[0] ?? "";
    const settingsSafeAreaRule = styles.match(
      /\.settings-page\s*>\s*\.app-frame-page-content\s*\{[^}]*\}/
    )?.[0] ?? "";
    expect(dragRegionRule).toContain("height: var(--codex-toolbar-height);");
    expect(dragRegionRule).toContain("-webkit-app-region: drag;");
    expect(settingsSafeAreaRule).toContain(
      "padding-top: calc(var(--codex-toolbar-height) + 10px);"
    );
    const style = document.createElement("style");
    style.textContent = `
      :root { --codex-toolbar-height: 46px; }
      .py-8 { padding-block: 2rem; }
      ${settingsSafeAreaRule}
    `;
    document.head.append(style);
    const settingsContent = container.querySelector<HTMLElement>(
      ".settings-page > .app-frame-page-content"
    );
    expect(window.getComputedStyle(settingsContent!).paddingTop).toBe("calc(46px + 10px)");

    const addButton = container.querySelector<HTMLButtonElement>('button[aria-label="添加配置"]');
    expect(addButton).not.toBeNull();
    expect(addButton?.disabled).toBe(false);
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    act(() => addButton!.click());

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("添加配置");
  });
});
