import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

function createTrayHarness(platform: "darwin" | "win32") {
  const source = readFileSync(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const start = source.indexOf("function syncMenuBarTray(enabled:");
  const end = source.indexOf("\nfunction handleComputerHistoryTrayIndicator", start);
  const handlers = new Map<string, () => void>();
  let menu: Array<{ label?: string; click?: () => void }> = [];
  const activateMainWindow = vi.fn();
  const setPetWindowMode = vi.fn();
  const registerListener = vi.fn((event: string, handler: () => void) => { handlers.set(event, handler); });
  const context = {
    process: { platform },
    menuBarTray: null,
    computerUseTrayRecovery: { trayRequested: (enabled: boolean) => enabled },
    computerUseSurfaceWindows: null,
    MENU_BAR_TRAY_GUID: "test-tray",
    Tray: class {
      setToolTip() {}
      setIgnoreDoubleClickEvents() {}
      setContextMenu(value: typeof menu) { menu = value; }
      on = registerListener;
    },
    Menu: { buildFromTemplate: (template: typeof menu) => template },
    isNativeTraySupported: () => true,
    resolveMenuBarTrayImage: () => ({}),
    syncComputerHistoryTrayIndicator: vi.fn(),
    destroyMenuBarTray: vi.fn(),
    activateMainWindow,
    setPetWindowMode,
    app: { quit: vi.fn() }
  };
  const compiled = ts.transpileModule(`${source.slice(start, end)}\nsyncMenuBarTray(true);`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;
  runInNewContext(compiled, context);
  return {
    handlers,
    get menu() { return menu; },
    activateMainWindow,
    setPetWindowMode,
    registerListener,
    refreshMenu: () => runInNewContext("syncMenuBarTrayContextMenu();", context)
  };
}

describe("pet tray actions", () => {
  it("opening the macOS menu leaves pet mode alone until a menu action is chosen", () => {
    const tray = createTrayHarness("darwin");
    tray.refreshMenu();
    tray.refreshMenu();
    expect(tray.registerListener).not.toHaveBeenCalled();
    tray.handlers.get("click")?.();
    expect(tray.activateMainWindow).not.toHaveBeenCalled();
    expect(tray.setPetWindowMode).not.toHaveBeenCalled();

    tray.menu.find(item => item.label === "桌宠模式")!.click!();
    expect(tray.setPetWindowMode).toHaveBeenCalledExactlyOnceWith(true, { petIntent: "user" });
    expect(tray.activateMainWindow).not.toHaveBeenCalled();

    tray.menu.find(item => item.label === "显示 Memmy")!.click!();
    expect(tray.activateMainWindow).toHaveBeenCalledTimes(1);
  });

  it("keeps Windows tray clicks restoring the main window", () => {
    const tray = createTrayHarness("win32");
    tray.refreshMenu();
    tray.refreshMenu();
    expect(tray.registerListener).toHaveBeenCalledExactlyOnceWith("click", expect.any(Function));
    tray.handlers.get("click")!();
    expect(tray.activateMainWindow).toHaveBeenCalledTimes(1);
    expect(tray.setPetWindowMode).not.toHaveBeenCalled();
  });
});
