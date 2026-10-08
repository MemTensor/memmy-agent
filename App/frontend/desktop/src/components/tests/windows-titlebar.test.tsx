// @vitest-environment happy-dom
/** Windows titlebar tests. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { isWindowsDesktopPlatform } from "../../utils/window-fullscreen.js";
import { WindowsTitlebar } from "../windows-titlebar.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

describe("isWindowsDesktopPlatform", () => {
  it("turns on for the local dev query without the Windows body class", () => {
    document.body.className = "";
    window.history.replaceState(null, "", "/?preview=memory-skills&windowsChrome=1");
    expect(isWindowsDesktopPlatform()).toBe(true);

    window.history.replaceState(null, "", "/?preview=memory-skills");
    expect(isWindowsDesktopPlatform()).toBe(false);
  });
});

describe("WindowsTitlebar", () => {
  it("places the app icon, Nunito wordmark, and sidebar toggle on one row", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <WindowsTitlebar sidebarHidden={false} onToggleSidebar={() => undefined} />
      </I18nProvider>
    );

    expect(html).toContain("windows-titlebar");
    expect(html).toContain("welcome-brand-name windows-titlebar__wordmark");
    expect(html).toContain(">Memmy<");
    expect(html).toContain("memmy-app-icon");
    expect(html).toContain('data-window-drag-exclusion="windows-titlebar"');
    expect(html).toContain('data-icon="panel-left"');
    expect(html).not.toContain("帮助文档");
    expect(html).not.toContain('data-icon="panel-left-collapsed"');
  });

  it("shows the restore icon while the sidebar is hidden", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <I18nProvider language="zh-CN">
          <WindowsTitlebar sidebarHidden onToggleSidebar={() => undefined} />
        </I18nProvider>
      );
    });

    expect(container.querySelector('[data-icon="panel-left-collapsed"]')).not.toBeNull();
    expect(container.textContent).not.toContain("帮助文档");
  });

  it("is mounted only for the Windows shell and draws a full-width divider", () => {
    const styles = readFileSync(resolve(sourceRoot, "styles.css"), "utf8");
    const appFrame = readFileSync(resolve(sourceRoot, "pages/app-frame.tsx"), "utf8");
    const memoryPage = readFileSync(resolve(sourceRoot, "pages/memory-page.tsx"), "utf8");

    expect(styles).toMatch(/\.windows-titlebar\s*\{[^}]*border-bottom:\s*0\.8px solid var\(--windows-titlebar-divider\);/s);
    expect(styles).toMatch(/\.windows-titlebar\s*\{[^}]*background:\s*var\(--color-sidebar-bg\);/s);
    expect(styles).not.toContain(".windows-titlebar__docs");
    expect(styles).toMatch(/\.windows-titlebar__wordmark\s*\{[^}]*font-weight:\s*800;/s);
    expect(styles).toContain(".sidebar-shell__passthrough");
    expect(styles).toContain("display: contents;");
    expect(appFrame).toContain("isWindowsDesktopPlatform()");
    expect(appFrame).toContain("sidebar-shell--windows-titlebar");
    expect(appFrame).toContain("!windowsChrome && (");
    expect(memoryPage).toContain("isWindowsDesktopPlatform()");
    expect(memoryPage).toContain("sidebar-shell--windows-titlebar");
    expect(memoryPage).toContain("!windowsChrome && (");
  });
});
