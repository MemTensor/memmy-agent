import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

interface MainWindowActionRequest {
  id: string;
  action: "close" | "minimize";
}

interface ExposedMemmyApi {
  platform: string;
  onMainWindowActionRequest(callback: (request: MainWindowActionRequest) => void): () => void;
}

function loadPreload(): {
  memmy: ExposedMemmyApi;
  emitMainWindowAction(request: MainWindowActionRequest): void;
} {
  const preloadPath = fileURLToPath(new URL("../src/preload/preload.cts", import.meta.url));
  const compiled = ts.transpileModule(readFileSync(preloadPath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>();
  let memmy: ExposedMemmyApi | null = null;
  const electron = {
    contextBridge: {
      exposeInMainWorld(_name: string, api: ExposedMemmyApi): void {
        memmy = api;
      }
    },
    ipcRenderer: {
      invoke: vi.fn(),
      send: vi.fn(),
      on(channel: string, listener: (event: unknown, payload: unknown) => void): void {
        const channelListeners = listeners.get(channel) ?? new Set();
        channelListeners.add(listener);
        listeners.set(channel, channelListeners);
      },
      removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void {
        listeners.get(channel)?.delete(listener);
      }
    }
  };
  const module = { exports: {} };
  const preloadRequire = (specifier: string): unknown => {
    if (specifier === "electron") {
      return electron;
    }
    throw new Error(`Unexpected preload dependency: ${specifier}`);
  };

  Function("require", "module", "exports", compiled)(preloadRequire, module, module.exports);
  if (!memmy) {
    throw new Error("Preload did not expose the Memmy API");
  }

  return {
    memmy,
    emitMainWindowAction(request): void {
      for (const listener of listeners.get("memmy:main-window-action-requested") ?? []) {
        listener({}, request);
      }
    }
  };
}

describe("main window action preload buffer", () => {
  it("exposes the desktop platform synchronously for first-paint window chrome layout", () => {
    const preload = loadPreload();

    expect(preload.memmy.platform).toBe(process.platform);
  });

  it("delivers a close request that arrives before the renderer subscribes", () => {
    const preload = loadPreload();
    const callback = vi.fn();
    const request = { id: "main-window-action-1", action: "close" } as const;

    preload.emitMainWindowAction(request);
    preload.memmy.onMainWindowActionRequest(callback);

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(request);
  });

  it("delivers requests immediately while subscribed without replaying them", () => {
    const preload = loadPreload();
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const unsubscribe = preload.memmy.onMainWindowActionRequest(firstCallback);
    const request = { id: "main-window-action-2", action: "minimize" } as const;

    preload.emitMainWindowAction(request);
    unsubscribe();
    preload.memmy.onMainWindowActionRequest(secondCallback);

    expect(firstCallback).toHaveBeenCalledWith(request);
    expect(secondCallback).not.toHaveBeenCalled();
  });

  it("buffers a request that arrives between renderer subscriptions", () => {
    const preload = loadPreload();
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const unsubscribe = preload.memmy.onMainWindowActionRequest(firstCallback);
    unsubscribe();
    const request = { id: "main-window-action-3", action: "close" } as const;

    preload.emitMainWindowAction(request);
    preload.memmy.onMainWindowActionRequest(secondCallback);

    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledWith(request);
  });
});
