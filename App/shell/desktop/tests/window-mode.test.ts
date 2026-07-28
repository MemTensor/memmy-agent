/** Window mode tests. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  appendRendererMode,
  fullWindowOptions,
  parsePetWindowLayout,
  parsePetWindowPointer,
  resolveBootWindowMode,
  resolveFullWindowButtonPosition,
  resolveFullWindowChromeOptions,
  resolveFullWindowSize,
  petWindowAlwaysOnTopLevel,
  petWindowOptions,
  resolvePetWindowBounds,
  resolvePetWindowDragAnchor,
  resolveRendererUrl
} from "../src/main/window-mode.js";

const mainSourcePath = fileURLToPath(new URL("../src/main/main.ts", import.meta.url));
const rootPackagePath = fileURLToPath(new URL("../../../../package.json", import.meta.url));

describe("desktop pet window mode", () => {
  it("keeps the full desktop window geometry platform-neutral", () => {
    expect(fullWindowOptions).toMatchObject({
      width: 1200,
      height: 780,
      backgroundColor: "#f1f8f7"
    });
    expect(resolveFullWindowButtonPosition()).toEqual({ x: 14, y: 14 });
  });

  it("uses the Windows title-bar overlay without changing macOS traffic lights", () => {
    expect(resolveFullWindowChromeOptions("win32")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#00000000",
        symbolColor: "#111d1c",
        height: 46
      }
    });
    expect(resolveFullWindowChromeOptions("darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 14 }
    });

    const source = readFileSync(mainSourcePath, "utf8");
    expect(source).toContain("...resolveFullWindowChromeOptions(process.platform)");
  });

  it("clamps the full desktop window size to the primary display work area", () => {
    expect(resolveFullWindowSize({ width: 1512, height: 945 })).toEqual({ width: 1200, height: 780 });
    expect(resolveFullWindowSize({ width: 1366, height: 728 })).toEqual({ width: 1200, height: 664 });
    expect(resolveFullWindowSize({ width: 1024, height: 700 })).toEqual({ width: 980, height: 640 });
  });

  it("uses a transparent frameless always-on-top window for pet mode", () => {
    expect(petWindowOptions).toMatchObject({
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      visibleOnAllWorkspaces: true,
      skipTaskbar: true,
      resizable: false,
      backgroundColor: "#00000000"
    });
    expect(petWindowAlwaysOnTopLevel).toBe("floating");
  });

  it("keeps the pet window below system input overlays while still above normal windows", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).toContain("targetWindow.setAlwaysOnTop(true, petWindowAlwaysOnTopLevel);");
    expect(source).not.toContain('targetWindow.setAlwaysOnTop(true, "screen-saver");');
  });

  it("marks the renderer URL with the requested launch mode", () => {
    expect(appendRendererMode("http://127.0.0.1:5173", "pet")).toBe("http://127.0.0.1:5173/?memmyMode=pet");
    expect(appendRendererMode("http://127.0.0.1:5173", "pet", { petIntent: "user" })).toBe("http://127.0.0.1:5173/?memmyMode=pet&memmyPetIntent=user");
    expect(appendRendererMode("http://127.0.0.1:5173/?foo=bar", "full")).toBe("http://127.0.0.1:5173/?foo=bar&memmyMode=full");
    expect(appendRendererMode("http://127.0.0.1:5173", "full", { route: "/settings", hash: "pet-avatar" })).toBe("http://127.0.0.1:5173/?memmyMode=full&memmyRoute=%2Fsettings#pet-avatar");
    expect(appendRendererMode("http://127.0.0.1:5173", "full", { route: "/welcome" })).toBe("http://127.0.0.1:5173/?memmyMode=full&memmyRoute=%2Fwelcome");
    expect(appendRendererMode("http://127.0.0.1:5173", "full", { route: "/main", agentChatId: "chat-1" })).toBe("http://127.0.0.1:5173/?memmyMode=full&memmyRoute=%2Fmain&memmyAgentChat=chat-1");
  });

  it("resolves the boot window mode from the persisted default and last-used mode", () => {
    expect(resolveBootWindowMode({ defaultLaunchMode: "pet", lastLaunchMode: "full" })).toBe("pet");
    expect(resolveBootWindowMode({ defaultLaunchMode: "full", lastLaunchMode: "pet" })).toBe("full");
    expect(resolveBootWindowMode({ defaultLaunchMode: "last", lastLaunchMode: "pet" })).toBe("pet");
    expect(resolveBootWindowMode({ defaultLaunchMode: "last", lastLaunchMode: "full" })).toBe("full");
  });

  it("resolves packaged renderer URLs over loopback HTTP for gtag-compatible loading", () => {
    const url = resolveRendererUrl({
      explicitUrl: undefined,
      isPackaged: true,
      mainDir: "/Applications/Memmy.app/Contents/Resources/app.asar/dist/main",
      mode: "pet"
    });

    expect(url).toContain("http://127.0.0.1:19100/index.html");
    expect(url).not.toContain("file://");
    expect(url).toContain("memmyMode=pet");
  });

  it("开发态默认加载 frontend desktop 的 Vite 端口", () => {
    const url = resolveRendererUrl({
      explicitUrl: undefined,
      isPackaged: false,
      mainDir: "/Users/zongy/Documents/MemTensor/memmy-agent/App/shell/desktop/dist/main",
      mode: "full"
    });
    const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8")) as { scripts?: Record<string, string> };

    expect(url).toBe("http://127.0.0.1:19000/?memmyMode=full");
    expect(rootPackage.scripts?.["dev:desktop"]).toContain("wait-on http://127.0.0.1:19000");
  });

  it("boots into the persisted launch mode instead of always creating the full window", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).toContain("createInitialWindow();");
    expect(source).toContain("resolveBootWindowMode({");
    expect(source).toContain('if (resolveInitialWindowMode() === "pet") {');
    expect(source).not.toContain("    isBootReady = true;\n    createMainWindow();");
  });

  it("records the last used launch mode whenever the pet window mode is toggled", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).toContain('recordLaunchMode(enabled ? "pet" : "full");');
    expect(source).toContain("localBackend?.recordLaunchMode(");
  });

  it("suspends the pet window before restoring the full window and async closing the IPC sender", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).toContain("suspendPetWindowBeforeFullMode();\n  showMainWindow(target);\n  queuePetWindowClose();");
    expect(source).toContain("function suspendPetWindowBeforeFullMode()");
    expect(source).toContain("petWindow.setVisibleOnAllWorkspaces(false);");
    expect(source).toContain("petWindow.setAlwaysOnTop(false);");
    expect(source).toContain("petWindow.hide();");
    expect(source).toContain("targetMainWindow.setVisibleOnAllWorkspaces(false);");
    expect(source).not.toContain("showMainWindow();\n  closePetWindow();");
  });

  it("关闭桌宠时隐藏到后台并强制常驻托盘，不恢复完整主窗口", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).toContain('ipcMain.handle("memmy:hide-pet-window", () => {');
    expect(source).toContain("hidePetWindowToBackground();");
    expect(source).toContain("function hidePetWindowToBackground()");
    expect(source).toContain('recordLaunchMode("full");');
    expect(source).toContain("syncMenuBarTray(true);");
    // Definition for hide body.
    const hideBody = source.slice(source.indexOf("function hidePetWindowToBackground()"));
    expect(hideBody.slice(0, hideBody.indexOf("}")).includes("showMainWindow(")).toBe(false);
    expect(source).toContain('ipcMain.removeHandler("memmy:hide-pet-window");');
  });

  it("用户直接关闭桌宠时退回后台完整模式且不被 macOS activate 自动拉起", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).toContain("const programmaticPetWindowCloses = new WeakSet<BrowserWindow>();");
    expect(source).toContain("const wasProgrammaticClose = programmaticPetWindowCloses.delete(targetPetWindow);");
    expect(source).toContain("if (!wasProgrammaticClose && !isQuitting) {\n      handleDirectPetWindowClose();\n    }");
    expect(source).toContain("function handleDirectPetWindowClose()");
    expect(source).toContain('recordLaunchMode("full");\n  syncMenuBarTray(true);\n  markPetWindowCloseActivateSuppression();');
    expect(source).toContain("programmaticPetWindowCloses.add(targetPetWindow);");
    expect(source).toContain("if (consumePetWindowCloseActivateSuppression()) {\n      return;\n    }\n\n    activateMainWindow();");
  });

  it("retries the single-instance lock so macOS quit-and-reopen survives slow old-instance exit", () => {
    const source = readFileSync(mainSourcePath, "utf8");
    const secondInstanceIndex = source.indexOf('app.on("second-instance"');
    const secondInstanceBlock = source.slice(secondInstanceIndex, source.indexOf("app.whenReady()", secondInstanceIndex));
    const whenReadyIndex = source.indexOf("app.whenReady()", secondInstanceIndex);
    const whenReadyBlock = source.slice(whenReadyIndex, source.indexOf('app.on("activate"', whenReadyIndex));
    const beforeQuitIndex = source.indexOf('app.on("before-quit"');
    const beforeQuitBlock = source.slice(beforeQuitIndex, source.indexOf("function armQuitCleanupForceExitTimer(): void", beforeQuitIndex));

    // The replacement instance started by macOS "Quit & Reopen" retries the lock until the old
    // instance finishes cleanup, instead of quitting immediately or relaunching heuristically.
    expect(source).toContain("let hasSingleInstanceLock = app.requestSingleInstanceLock();");
    expect(source).toContain("const SINGLE_INSTANCE_LOCK_RETRY_INTERVAL_MS = 500;");
    expect(source).toContain("const SINGLE_INSTANCE_LOCK_WAIT_DEADLINE_MS = 10000;");
    expect(source).toContain("const SECOND_INSTANCE_ACTIVATE_DEBOUNCE_MS = 3000;");
    expect(source).toContain("async function waitForSingleInstanceLock(): Promise<boolean>");
    expect(source).toContain("hasSingleInstanceLock = app.requestSingleInstanceLock();");
    expect(source).toContain("await delay(SINGLE_INSTANCE_LOCK_RETRY_INTERVAL_MS);");
    expect(whenReadyBlock).toContain("if (!(await waitForSingleInstanceLock()))");
    expect(whenReadyBlock).toContain("app.quit();");
    expect(whenReadyBlock).toContain("await boot();");

    // While quitting, the old instance stays out of the way and lets the replacement take over;
    // a healthy primary debounces the activations caused by the replacement's lock retries.
    expect(secondInstanceBlock).toContain("if (isQuitting || isQuitCleanupInProgress)");
    expect(secondInstanceBlock).toContain("SECOND_INSTANCE_ACTIVATE_DEBOUNCE_MS");
    expect(secondInstanceBlock).toContain("activateMainWindow();");
    expect(beforeQuitBlock).toContain("if (!hasSingleInstanceLock)");

    // macOS can deliver the "Quit & Reopen" quit request to the freshly reopened instance when the
    // old instance exits slowly; that stale quit is ignored once so the reopened window survives.
    expect(source).toContain("const MACOS_STALE_REOPEN_QUIT_GRACE_MS = 20000;");
    expect(source).toContain("function shouldIgnoreStaleReopenQuit(): boolean");
    expect(source).toContain("didWaitForSingleInstanceLock = true;");
    expect(beforeQuitBlock).toContain("if (shouldIgnoreStaleReopenQuit())");
    expect(beforeQuitBlock).toContain("hasIgnoredStaleReopenQuit = true;");
    expect(beforeQuitBlock).toContain("event.preventDefault();");

    // When the reopen instead reaches the dying instance as an activate event (no replacement
    // process is spawned), the dying instance honors it by relaunching after cleanup.
    const activateIndex = source.indexOf('app.on("activate"');
    const activateBlock = source.slice(activateIndex, source.indexOf('app.on("window-all-closed"', activateIndex));
    expect(activateBlock).toContain("if (isQuitting || isQuitCleanupInProgress)");
    expect(activateBlock).toContain("shouldRelaunchAfterQuitCleanup = true;");
    expect(source).toContain("function relaunchAfterQuitCleanupIfRequested(): void");
    expect(source).toContain("relaunchAfterQuitCleanupIfRequested();\n      app.quit();");
    expect(source).toContain("relaunchAfterQuitCleanupIfRequested();\n    app.exit(0);");

    // The reopen intent comes only from concrete signals (activate during quit): no marker files.
    expect(source).not.toContain("macos-microphone-relaunch");
  });

  it("restores an existing full window without reloading the renderer", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).not.toContain("shouldReload = true");
    expect(source).toContain("let shouldNotifyRouteTarget = false;");
    expect(source).toContain("shouldNotifyRouteTarget = Boolean(target);");
    expect(source).toContain("deliverMainWindowRouteTarget(targetMainWindow, target);");
    expect(source).toContain("targetWindow.webContents.send(MAIN_WINDOW_ROUTE_TARGET_CHANNEL, target);");
    expect(source).not.toContain('if (target) {\n    void targetMainWindow.loadURL(resolveRendererUrl("full", target));\n  }');
  });

  it("leaves full-screen before hiding the main window when entering pet mode", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).toContain("function enterPetWindowMode(target: RendererRouteTarget | null = null)");
    expect(source).toContain('setMacOsActivationPolicy("accessory");');
    expect(source).toContain("if (sourceMainWindow && isWindowFullScreenLike(sourceMainWindow))");
    expect(source).toContain("waitForWindowToLeaveFullScreen(sourceMainWindow");
    expect(source).toContain("leaveWindowFullScreen(sourceMainWindow);");
    expect(source).toContain('targetWindow.once("leave-full-screen", complete);');
    expect(source).toContain("targetWindow.setFullScreen(false);");
    expect(source).toContain("showPetWindowAndHideMainWindow(sourceMainWindow, target);");
    expect(source).not.toContain("mainWindow?.hide();");
  });

  it("hides the opaque main window before switching activation policy and creating the pet window (non-fullscreen)", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    // Window mode tests.
    // Handles expect.
    expect(source).toContain('sourceMainWindow?.hide();\n  setMacOsActivationPolicy("accessory");\n  showPetWindowAndHideMainWindow(sourceMainWindow, target);');
  });

  it("waits for the pet renderer layout before showing the transparent pet window", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).toContain("let isPetWindowReadyToShow = false;");
    expect(source).toContain("showPetWindowAfterRendererLayout();");
    expect(source).toContain("function showPetWindowAfterRendererLayout()");
    expect(source).toContain("isPetWindowReadyToShow = true;");
    expect(source).toContain("petWindow.showInactive();");
    expect(source).not.toContain("applyPetWindowBounds();\n    petWindow.showInactive();");
  });

  it("restores regular macOS activation policy before showing the full window", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).toContain('function setMacOsActivationPolicy(policy: "regular" | "accessory"): void');
    expect(source).toContain("app.setActivationPolicy(policy);");
    expect(source).toContain('function showMainWindow(target: RendererRouteTarget | null = null): void {\n  setMacOsActivationPolicy("regular");');
  });

  it("forces the traffic-light buttons visible whenever it repositions them, so they survive a pet<->full round-trip", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).toContain("function updateFullWindowButtonPosition(targetWindow: BrowserWindow): void {");
    const updateBody = source.slice(source.indexOf("function updateFullWindowButtonPosition(targetWindow: BrowserWindow): void {"));
    const updateBodyEnd = updateBody.indexOf("\n}\n");
    const scopedBody = updateBody.slice(0, updateBodyEnd);
    expect(scopedBody).toContain("targetWindow.setWindowButtonVisibility(true);");
    expect(scopedBody.indexOf("targetWindow.setWindowButtonVisibility(true);")).toBeLessThan(
      scopedBody.indexOf("targetWindow.setWindowButtonPosition(resolveFullWindowButtonPosition());")
    );
  });

  it("pins the app to the light theme so inactive traffic-light buttons stay visible on the light background", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).toContain("function forceLightWindowChrome(): void {");
    const chromeBody = source.slice(source.indexOf("function forceLightWindowChrome(): void {"));
    const scopedBody = chromeBody.slice(0, chromeBody.indexOf("\n}\n"));
    expect(scopedBody).toContain('nativeTheme.themeSource = "light";');
    // Applied during boot before any window is created.
    expect(source).toContain("initLogger();\n    forceLightWindowChrome();");
    expect(source).toContain("nativeTheme");
  });

  it("resolves native pet window bounds from a screen mascot anchor and measured renderer layout", () => {
    expect(
      resolvePetWindowBounds({
        anchorX: 800,
        anchorY: 500,
        layout: { width: 336, height: 280, mascotOffsetX: 108, mascotOffsetY: 112 }
      })
    ).toEqual({ x: 692, y: 388, width: 336, height: 280 });
  });

  it("resolves the dragged mascot anchor from cursor screen point and renderer layout", () => {
    expect(
      resolvePetWindowDragAnchor({
        cursorX: 920,
        cursorY: 512,
        clientX: 140,
        clientY: 150,
        layout: { width: 336, height: 280, mascotOffsetX: 108, mascotOffsetY: 112 }
      })
    ).toEqual({ x: 888, y: 474 });
  });

  it("accepts only finite positive renderer layout measurements", () => {
    expect(parsePetWindowLayout({ width: 320, height: 240, mascotOffsetX: 96, mascotOffsetY: 100 })).toEqual({
      width: 320,
      height: 240,
      mascotOffsetX: 96,
      mascotOffsetY: 100
    });
    expect(parsePetWindowLayout({ width: 0, height: 240, mascotOffsetX: 96, mascotOffsetY: 100 })).toBeNull();
    expect(parsePetWindowLayout({ width: 320, height: Number.NaN, mascotOffsetX: 96, mascotOffsetY: 100 })).toBeNull();
  });

  it("accepts only finite renderer pointer coordinates", () => {
    expect(parsePetWindowPointer({ clientX: 24, clientY: 40 })).toEqual({ clientX: 24, clientY: 40 });
    expect(parsePetWindowPointer({ clientX: Number.NaN, clientY: 40 })).toBeNull();
    expect(parsePetWindowPointer({ clientX: 12 })).toBeNull();
  });

  it("uses setBounds for dynamic layouts and a main-process position loop while dragging", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).toContain('ipcMain.on("memmy:update-pet-window-layout"');
    expect(source).toContain('ipcMain.on("memmy:start-pet-window-drag"');
    expect(source).toContain('ipcMain.on("memmy:stop-pet-window-drag"');
    expect(source).toContain("petWindow.setBounds(");
    expect(source).toContain("petWindow.setPosition(nextBounds.x, nextBounds.y, false);");
    expect(source).toContain("resolvePetWindowBounds({");
    expect(source).toContain("if (areBoundsEqual(latestPetWindowBounds, bounds))");
  });

  it("asks renderer before the first full-window close or minimize so the pet guide can appear once", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).toContain("setWindowButtonPosition(resolveFullWindowButtonPosition");
    expect(source).toContain("...resolveFullWindowSize(screen.getPrimaryDisplay().workArea)");
    expect(source).toContain('targetMainWindow.on("resize", () => updateFullWindowButtonPosition(targetMainWindow));');
    expect(source).toContain("attachMainWindowFullScreenSync(targetMainWindow);");
    expect(source).toContain('ipcMain.handle("memmy:get-main-window-fullscreen"');
    expect(source).toContain('targetWindow.webContents.send("memmy:main-window-fullscreen-changed"');
    expect(source).toContain('mainWindow.on("close", handleMainWindowClose);');
    expect(source).toContain('on("minimize", handleMainWindowMinimize)');
    expect(source).toContain('webContents.send("memmy:main-window-action-requested"');
    expect(source).toContain('ipcMain.handle("memmy:complete-main-window-action"');
    expect(source).toContain("setPetWindowMode(true);");
    expect(source).toContain('resolution === "quit"');
    expect(source).toContain("app.quit();");
    expect(source).toContain('if (process.platform === "win32") {\n      syncMenuBarTray(true);\n    }\n    targetWindow.hide();');
    expect(source).toContain("targetWindow.hide();");
    expect(source).toContain("targetWindow.minimize();");
    expect(source).toContain("targetWindow.close();");
    expect(source).toContain("function activateMainWindow()");
    expect(source).toContain("mainWindow.show();");
    expect(source).toContain("mainWindow.focus();");
    expect(source).toContain("activateMainWindow();");
  });
});
