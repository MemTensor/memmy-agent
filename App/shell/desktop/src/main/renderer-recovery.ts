import type { BrowserWindow, Event as ElectronEvent, RenderProcessGoneDetails } from "electron";

export const RENDERER_AUTO_RECOVERY_INTERVAL_MS = 60_000;
export const RENDERER_RECOVERY_TIMEOUT_MS = 30_000;

export interface RendererRecoveryDiagnostic {
  event: "renderer-gone" | "renderer-reload-started" | "renderer-reload-failed"
    | "renderer-reload-timeout" | "renderer-recovered" | "renderer-recovery-dialog-failed";
  mode: "full" | "pet";
  reason?: string;
  exitCode?: number;
  errorCode?: number;
  source?: "automatic" | "user";
}

interface RendererRecoveryOptions {
  window: BrowserWindow;
  mode: "full" | "pet";
  isQuitting(): boolean;
  isStartup(): boolean;
  clearRendererState(): void;
  reload(): Promise<void>;
  showRecoveryDialog(): Promise<"reload" | "quit">;
  quit(): void;
  record(diagnostic: RendererRecoveryDiagnostic): void;
}

/** Keep the current app route without ever navigating to an unrelated page on recovery. */
export function rendererRecoveryUrl(currentUrl: string, trustedUrl: string): string {
  try {
    const current = new URL(currentUrl);
    const trusted = new URL(trustedUrl);
    if (current.origin === trusted.origin && current.pathname === trusted.pathname) {
      current.searchParams.set("memmyMode", trusted.searchParams.get("memmyMode") ?? "full");
      return current.toString();
    }
  } catch { /* A renderer with no committed app document uses its normal launch URL. */ }
  return trustedUrl;
}

/**
 * Observe the shell renderer for the window's entire lifetime, independently of the startup splash.
 * Automatic recovery is limited to one attempt per minute. Only a fresh renderer-ready IPC marks
 * recovery successful; a loaded Chromium error page or a page with broken app bootstrap does not.
 */
export function attachRendererRecovery(options: RendererRecoveryOptions) {
  const targetWindow = options.window;
  const webContents = targetWindow.webContents;
  let disposed = false;
  let unavailable = false;
  let reloading = false;
  let prompting = false;
  let generation = 0;
  let lastRecoveryAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const active = () => !disposed && !options.isQuitting()
    && !targetWindow.isDestroyed() && !webContents.isDestroyed();
  const record = (diagnostic: Omit<RendererRecoveryDiagnostic, "mode">) => {
    options.record({ ...diagnostic, mode: options.mode });
  };
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const invalidate = () => {
    ++generation;
    clearTimer();
    reloading = false;
    unavailable = true;
    options.clearRendererState();
  };

  const prompt = async () => {
    if (!active() || options.isStartup() || !unavailable || prompting) return;
    prompting = true;
    try {
      const choice = await options.showRecoveryDialog();
      if (!active() || !unavailable) return;
      if (choice === "reload") reload("user");
      else options.quit();
    } catch {
      if (active() && unavailable) record({ event: "renderer-recovery-dialog-failed" });
    } finally {
      prompting = false;
    }
  };

  const reload = (source: "automatic" | "user") => {
    if (!active() || reloading) return;
    invalidate();
    const attempt = generation;
    reloading = true;
    lastRecoveryAt = Date.now();
    record({ event: "renderer-reload-started", source });
    timer = setTimeout(() => {
      if (!active() || attempt !== generation) return;
      invalidate();
      record({ event: "renderer-reload-timeout" });
      void prompt();
    }, RENDERER_RECOVERY_TIMEOUT_MS);
    timer.unref?.();
    // A synchronous loadURL failure and its rejected promise follow the same bounded path.
    void Promise.resolve().then(() => {
      if (!active() || attempt !== generation) return;
      return options.reload();
    }).catch((error: unknown) => {
      if (!active() || attempt !== generation || (error as { code?: string } | null)?.code === "ERR_ABORTED") return;
      invalidate();
      record({ event: "renderer-reload-failed" });
      void prompt();
    });
  };

  const handleGone = (_event: ElectronEvent, details: RenderProcessGoneDetails) => {
    if (disposed || targetWindow.isDestroyed()) return;
    record({ event: "renderer-gone", reason: details.reason, exitCode: details.exitCode });
    invalidate();
    // Startup has its own failure reporting/quit path. Never race it with a recovery load.
    if (!active() || options.isStartup()) return;
    if (lastRecoveryAt === null || Date.now() - lastRecoveryAt >= RENDERER_AUTO_RECOVERY_INTERVAL_MS) {
      reload("automatic");
    } else {
      void prompt();
    }
  };
  const handleFailed = (_event: ElectronEvent, code: number, _description: string, _url: string, isMainFrame: boolean) => {
    if (!active() || options.isStartup() || !isMainFrame || code === -3) return;
    invalidate();
    record({ event: "renderer-reload-failed", errorCode: code });
    void prompt();
  };
  const handleClose = (event: ElectronEvent) => {
    if (!active() || options.isStartup() || !unavailable) return;
    // The dead renderer cannot answer the normal first-run pet close guidance request.
    event.preventDefault();
    void prompt();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    ++generation;
    clearTimer();
    options.clearRendererState();
    webContents.removeListener("render-process-gone", handleGone);
    webContents.removeListener("did-fail-load", handleFailed);
    targetWindow.removeListener("close", handleClose);
    targetWindow.removeListener("closed", dispose);
  };

  webContents.on("render-process-gone", handleGone);
  webContents.on("did-fail-load", handleFailed);
  targetWindow.on("close", handleClose);
  targetWindow.once("closed", dispose);

  return {
    dispose,
    isUnavailable: () => unavailable,
    markReady() {
      if (!active()) return;
      const recovered = unavailable;
      ++generation;
      clearTimer();
      reloading = false;
      unavailable = false;
      if (recovered) record({ event: "renderer-recovered" });
    }
  };
}
