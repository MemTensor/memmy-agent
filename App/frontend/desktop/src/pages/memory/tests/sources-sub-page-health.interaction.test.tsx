// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppClients } from "../../../api/client-types.js";
import { AppProviders, useApiClients } from "../../../app/providers.js";
import { SourcesSubPage } from "../sources-sub-page.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const healthy = { ok: true, storage: { ready: true } };

describe("SourcesSubPage memory service recovery", () => {
  let container: HTMLDivElement;
  let root: Root;
  let mounted: boolean;
  let restart: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window, "localStorage", { configurable: true, value: createMemoryStorage() });
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: createMemoryStorage() });
    restart = vi.fn(async () => ({ ok: true }));
    Object.defineProperty(window, "memmy", {
      configurable: true,
      value: {
        restartMemoryService: restart,
        getAppInfo: async () => ({ platform: "darwin", isPackaged: true, isWindowsStore: false })
      }
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mounted = true;
  });

  afterEach(() => {
    if (mounted) act(() => root.unmount());
    document.body.replaceChildren();
    Object.defineProperty(window, "memmy", { configurable: true, value: undefined });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function render(clients: AppClients) {
    await act(async () => {
      root.render(<AppProviders><ClientsHarness clients={clients} /></AppProviders>);
    });
  }

  async function advance(milliseconds: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
  }

  function restartButton() {
    const button = Array.from(container.querySelectorAll("button"))
      .find((item) => item.textContent?.includes("重启"));
    if (!button) throw new Error("Memory restart action was not rendered");
    return button;
  }

  it("recovers automatically when Memory becomes ready after the first connection failure", async () => {
    const health = vi.fn().mockRejectedValueOnce(new Error("memory layer network error")).mockResolvedValue(healthy);
    await render(createClients(health));
    expect(container.textContent).toContain("暂不可用");
    expect(container.textContent).toContain("正在自动重试");
    expect(container.textContent).toContain("memory layer network error");
    expect(container.textContent).not.toContain("已停止");

    await advance(5_000);
    expect(health).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("运行中");
    expect(container.textContent).not.toContain("暂不可用");
    expect(container.textContent).not.toContain("正在自动重试");
    expect(container.textContent).not.toContain("memory layer network error");
  });

  it("does not overlap probes while a health request is still pending", async () => {
    const pending = deferred<typeof healthy>();
    const health = vi.fn().mockResolvedValueOnce(healthy).mockReturnValueOnce(pending.promise).mockResolvedValue(healthy);
    await render(createClients(health));
    await advance(5_000);
    await advance(5_000);
    expect(health).toHaveBeenCalledTimes(2);

    await act(async () => { pending.resolve(healthy); });
    await advance(5_000);
    expect(health).toHaveBeenCalledTimes(3);
  });

  it("aborts a timed out probe and resumes polling without waiting for its promise", async () => {
    const nextProbe = deferred<typeof healthy>();
    let firstSignal: AbortSignal | undefined;
    const health = vi.fn()
      .mockImplementationOnce((signal?: AbortSignal) => {
        firstSignal = signal;
        return new Promise(() => undefined);
      })
      .mockReturnValue(nextProbe.promise);
    await render(createClients(health));
    await advance(9_999);
    expect(firstSignal?.aborted).toBe(false);
    expect(health).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(firstSignal?.aborted).toBe(true);
    expect(container.textContent).toContain("记忆服务连接超时");
    await advance(5_000);
    expect(health).toHaveBeenCalledTimes(2);

    await act(async () => { nextProbe.resolve(healthy); });
    expect(container.textContent).toContain("运行中");
    expect(container.textContent).not.toContain("记忆服务连接超时");
  });

  it("ignores the old client's late health failure after switching clients", async () => {
    const oldProbe = deferred<typeof healthy>();
    const oldHealth = vi.fn(() => oldProbe.promise);
    const currentHealth = vi.fn(async () => healthy);
    await render(createClients(oldHealth));
    await render(createClients(currentHealth));
    expect(container.textContent).toContain("运行中");

    await act(async () => { oldProbe.reject(new Error("old client failure")); });
    expect(container.textContent).toContain("运行中");
    expect(container.textContent).not.toContain("old client failure");
    await advance(5_000);
    expect(oldHealth).toHaveBeenCalledTimes(1);
    expect(currentHealth).toHaveBeenCalledTimes(2);
  });

  it("stops polling on unmount and ignores a late response", async () => {
    const pending = deferred<typeof healthy>();
    const health = vi.fn(() => pending.promise);
    await render(createClients(health));
    act(() => root.unmount());
    mounted = false;
    await act(async () => { pending.reject(new Error("late unmounted failure")); });
    await advance(10_000);
    expect(health).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("");
  });

  it("keeps restart pending despite an older failed probe and rechecks after restart", async () => {
    const oldProbe = deferred<typeof healthy>();
    const restarting = deferred<{ ok: true }>();
    const health = vi.fn().mockReturnValueOnce(oldProbe.promise).mockResolvedValue(healthy);
    restart.mockReturnValue(restarting.promise);
    await render(createClients(health));

    await act(async () => { restartButton().click(); });
    expect(restartButton().disabled).toBe(true);
    expect(restartButton().textContent).toContain("重启中");
    await act(async () => { oldProbe.reject(new Error("probe from before restart")); });
    await advance(10_000);
    expect(health).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("probe from before restart");
    expect(container.textContent).not.toContain("暂不可用");
    expect(restartButton().disabled).toBe(true);

    await act(async () => { restarting.resolve({ ok: true }); });
    expect(health).toHaveBeenCalledTimes(2);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("运行中");
    expect(container.textContent).toContain("记忆服务已重新启动");
    expect(restartButton().disabled).toBe(false);
  });

  it("aborts a never settling old probe and completes a fresh health check after restart", async () => {
    let firstSignal: AbortSignal | undefined;
    const health = vi.fn()
      .mockImplementationOnce((signal?: AbortSignal) => {
        firstSignal = signal;
        return new Promise(() => undefined);
      })
      .mockResolvedValue(healthy);
    await render(createClients(health));
    await act(async () => { restartButton().click(); });

    expect(firstSignal?.aborted).toBe(true);
    expect(health).toHaveBeenCalledTimes(2);
    expect(restartButton().disabled).toBe(false);
    expect(container.textContent).toContain("运行中");
    expect(container.textContent).toContain("记忆服务已重新启动");
    expect(container.textContent).not.toContain("暂不可用");
  });

  it("bounds the fresh probe after restart so its timeout releases the restart button", async () => {
    let restartSignal: AbortSignal | undefined;
    const health = vi.fn()
      .mockResolvedValueOnce(healthy)
      .mockImplementationOnce((signal?: AbortSignal) => {
        restartSignal = signal;
        return new Promise(() => undefined);
      })
      .mockResolvedValue(healthy);
    await render(createClients(health));
    await act(async () => { restartButton().click(); });
    expect(restartButton().disabled).toBe(true);

    await advance(10_000);
    expect(restartSignal?.aborted).toBe(true);
    expect(restartButton().disabled).toBe(false);
    await advance(5_000);
    expect(container.textContent).toContain("运行中");
    expect(container.textContent).not.toContain("重启中");
  });

  it("releases restart controls on failure and subsequently recovers through polling", async () => {
    const health = vi.fn().mockRejectedValueOnce(new Error("connection refused")).mockResolvedValue(healthy);
    restart.mockRejectedValue(new Error("Memory is still starting; try again shortly"));
    await render(createClients(health));
    await act(async () => { restartButton().click(); });
    expect(restartButton().disabled).toBe(false);
    expect(container.textContent).toContain("记忆服务重启失败");
    expect(container.textContent).toContain("暂不可用");

    await advance(5_000);
    expect(container.textContent).toContain("运行中");
    expect(container.textContent).not.toContain("记忆服务重启失败");
    expect(container.textContent).not.toContain("暂不可用");
  });

  it("ignores an old restart result when a new client's health is already available", async () => {
    const restarting = deferred<{ ok: true }>();
    restart.mockReturnValue(restarting.promise);
    const oldHealth = vi.fn(async () => healthy);
    const currentHealth = vi.fn(async () => healthy);
    await render(createClients(oldHealth));
    await act(async () => { restartButton().click(); });
    await render(createClients(currentHealth));
    await act(async () => { restarting.reject(new Error("old restart failure")); });
    expect(container.textContent).toContain("运行中");
    expect(container.textContent).not.toContain("old restart failure");
    expect(restartButton().disabled).toBe(false);
    expect(oldHealth).toHaveBeenCalledTimes(1);
  });
});

function ClientsHarness(props: { clients: AppClients }) {
  const { setClients } = useApiClients();
  useEffect(() => { setClients(props.clients); }, [props.clients, setClients]);
  return <SourcesSubPage />;
}

function createClients(health: (signal?: AbortSignal) => Promise<unknown>): AppClients {
  return {
    runtimeConfig: {
      baseUrl: "http://127.0.0.1:18100",
      localToken: "test-token",
      memory: { baseUrl: "http://127.0.0.1:18960" }
    },
    localData: { getPath: async () => ({ ok: true, dataPath: "/test/memory" }) },
    agentSources: { listSources: async () => [] },
    config: {
      getScanPreferences: async () => ({ autoScanKnownAgents: true, watchFileChanges: true, autoInjectSkill: false })
    },
    memoryRuntime: { health }
  } as unknown as AppClients;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  };
}
