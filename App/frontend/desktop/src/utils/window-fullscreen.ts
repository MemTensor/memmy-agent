/** Window fullscreen module. */
import { useEffect } from "react";

export const WINDOW_FULLSCREEN_BODY_CLASS = "memmy-window-fullscreen";
export const WINDOWS_PLATFORM_BODY_CLASS = "memmy-platform-windows";

/** Applies the desktop platform class used by native window chrome layout. */
export function applyWindowPlatformClass(platform: string | null | undefined): void {
  if (typeof document === "undefined") {
    return;
  }

  document.body.classList.toggle(WINDOWS_PLATFORM_BODY_CLASS, platform === "win32");
}

/** Handles apply window full screen class. */
export function applyWindowFullScreenClass(isFullScreen: boolean): void {
  if (typeof document === "undefined") {
    return;
  }

  document.body.classList.toggle(WINDOW_FULLSCREEN_BODY_CLASS, isFullScreen);
}

/** Handles subscribe main window full screen. */
export function subscribeMainWindowFullScreen(onChange: (isFullScreen: boolean) => void): () => void {
  const bridge = typeof window !== "undefined" ? window.memmy : undefined;
  if (!bridge?.getMainWindowFullScreen || !bridge.onMainWindowFullScreenChanged) {
    applyWindowFullScreenClass(false);
    return () => undefined;
  }

  let disposed = false;

  void bridge.getMainWindowFullScreen().then((state) => {
    if (disposed) {
      return;
    }

    applyWindowFullScreenClass(state.isFullScreen);
    onChange(state.isFullScreen);
  }).catch(() => {
    if (!disposed) {
      applyWindowFullScreenClass(false);
      onChange(false);
    }
  });

  const unsubscribe = bridge.onMainWindowFullScreenChanged((state) => {
    applyWindowFullScreenClass(state.isFullScreen);
    onChange(state.isFullScreen);
  });

  return () => {
    disposed = true;
    unsubscribe();
    applyWindowFullScreenClass(false);
  };
}

/** Handles use window full screen sync. */
export function useWindowFullScreenSync(): void {
  useEffect(() => subscribeMainWindowFullScreen(() => undefined), []);
}
