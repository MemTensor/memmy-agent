/** Window fullscreen tests. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WINDOWS_PLATFORM_BODY_CLASS,
  WINDOW_FULLSCREEN_BODY_CLASS,
  applyWindowPlatformClass,
  applyWindowFullScreenClass,
  subscribeMainWindowFullScreen
} from "../window-fullscreen.js";

const mainSourcePath = fileURLToPath(new URL("../../main.tsx", import.meta.url));

describe("window-fullscreen", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("toggles the fullscreen body class", () => {
    const body = { classList: { toggle: vi.fn() } };
    vi.stubGlobal("document", { body });

    applyWindowFullScreenClass(true);
    expect(body.classList.toggle).toHaveBeenCalledWith(WINDOW_FULLSCREEN_BODY_CLASS, true);

    applyWindowFullScreenClass(false);
    expect(body.classList.toggle).toHaveBeenCalledWith(WINDOW_FULLSCREEN_BODY_CLASS, false);
  });

  it("marks Windows before the renderer mounts so its sidebar toggle starts at the left edge", () => {
    const body = { classList: { toggle: vi.fn() } };
    vi.stubGlobal("document", { body });

    applyWindowPlatformClass("win32");
    expect(body.classList.toggle).toHaveBeenCalledWith(WINDOWS_PLATFORM_BODY_CLASS, true);

    applyWindowPlatformClass("darwin");
    expect(body.classList.toggle).toHaveBeenLastCalledWith(WINDOWS_PLATFORM_BODY_CLASS, false);

    const mainSource = readFileSync(mainSourcePath, "utf8");
    expect(mainSource).toContain("applyWindowPlatformClass(window.memmy?.platform);");
    expect(mainSource.indexOf("applyWindowPlatformClass(window.memmy?.platform);")).toBeLessThan(
      mainSource.indexOf("createRoot(root).render(")
    );
  });

  it("subscribes to preload fullscreen events and cleans up on dispose", async () => {
    const onChange = vi.fn();
    const unsubscribe = vi.fn();
    const getMainWindowFullScreen = vi.fn().mockResolvedValue({ isFullScreen: true });
    const onMainWindowFullScreenChanged = vi.fn((callback: (state: { isFullScreen: boolean }) => void) => {
      callback({ isFullScreen: true });
      return unsubscribe;
    });
    const body = { classList: { toggle: vi.fn(), contains: vi.fn().mockReturnValue(false) } };

    vi.stubGlobal("document", { body });
    vi.stubGlobal("window", {
      memmy: {
        getMainWindowFullScreen,
        onMainWindowFullScreenChanged
      }
    });

    const dispose = subscribeMainWindowFullScreen(onChange);
    await Promise.resolve();

    expect(getMainWindowFullScreen).toHaveBeenCalledTimes(1);
    expect(body.classList.toggle).toHaveBeenCalledWith(WINDOW_FULLSCREEN_BODY_CLASS, true);
    expect(onChange).toHaveBeenCalledWith(true);

    dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(body.classList.toggle).toHaveBeenLastCalledWith(WINDOW_FULLSCREEN_BODY_CLASS, false);
  });

  it("falls back to non-fullscreen layout when preload bridge is unavailable", () => {
    const onChange = vi.fn();
    const body = { classList: { toggle: vi.fn() } };

    vi.stubGlobal("document", { body });
    vi.stubGlobal("window", {});

    const dispose = subscribeMainWindowFullScreen(onChange);

    expect(onChange).not.toHaveBeenCalled();
    expect(body.classList.toggle).toHaveBeenCalledWith(WINDOW_FULLSCREEN_BODY_CLASS, false);

    dispose();
  });
});
