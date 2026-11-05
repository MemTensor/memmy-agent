// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppClients } from "../../../api/client-types.js";
import { AppProviders, useApiClients } from "../../../app/providers.js";
import { AgentSourceScanReconciler } from "../../../app/agent-source-scan-reconciler.js";
import { useAppState } from "../../../state/app-state.js";
import { appActions } from "../../../state/app-actions.js";
import { SourcesSubPage } from "../sources-sub-page.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let stateApi: ReturnType<typeof useAppState>;
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

  async function render(clients: AppClients, showPage = true) {
    await act(async () => {
      root.render(<AppProviders><ClientsHarness clients={clients} showPage={showPage} /></AppProviders>);
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

  it.each(["idle", "completed"] as const)("uses the new version on the first scan after restarting from %s", async (lifecycle) => {
    const clients = createClients(async () => healthy);
    const version = { generation: 2, sequence: 0 };
    const completion = { jobId: "finished", attemptId: "attempt", sourceId: "all", succeeded: true, completedAt: "2026-10-21T00:00:00Z" };
    clients.agentSources.getScanStatus = vi.fn(async () => ({ active: false, progress: null, status: lifecycle, version,
      ...(lifecycle === "completed" ? { completion: { ...completion, version } } : {}) }));
    clients.config.updateOnboarding = vi.fn(async () => ({} as never));
    clients.agentSources.startScan = vi.fn(async (input) => {
      if (input?.expectedVersion?.generation !== version.generation) throw new Error("Scan state changed");
      clients.agentSources.getScanStatus = vi.fn(async () => ({ active: true, progress: { jobId: "new-job", attemptId: "new-attempt", sourceId: "all", phase: "scan", current: 0, total: 0, version: { generation: 2, sequence: 1 } } }));
      return { jobId: "new-job", attemptId: "new-attempt", version: { generation: 2, sequence: 1 } };
    });
    await render(clients);
    await act(async () => {
      if (lifecycle === "completed") {
        stateApi.dispatch(appActions.agentSourceScanCompleted({ ...completion, version: { generation: 1, sequence: 5 } }));
        stateApi.dispatch(appActions.agentSourceScanCompletionExpired("finished", "attempt"));
      } else {
        stateApi.dispatch(appActions.agentSourceScanStatusReceived({ active: false, progress: null, status: "idle", version: { generation: 1, sequence: 0 } }));
      }
    });
    await act(async () => { restartButton().click(); });
    expect(stateApi.state.agentSources.scanStamp?.version).toEqual(version);
    expect(container.textContent).toContain("记忆服务已重新启动");
    const scan = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "同步新增");
    expect(scan).toBeDefined();
    expect(scan?.disabled).toBe(false);
    await act(async () => { scan!.click(); });
    expect(clients.agentSources.startScan).toHaveBeenCalledTimes(1);
    expect(clients.agentSources.startScan).toHaveBeenCalledWith({ sourceId: "all", expectedVersion: version });
    expect(stateApi.state.agentSources.scanProgress?.jobId).toBe("new-job");
    expect(stateApi.state.agentSources.error).toBeNull();
  });

  it("reconciles restart state while the sources page is unmounted, then starts the first scan on return", async () => {
    const clients = createClients(async () => healthy);
    const restarting = deferred<{ ok: true }>();
    let restartCompleted = false;
    const version = { generation: 2, sequence: 0 };
    restart.mockImplementation(() => restarting.promise.then((value) => { restartCompleted = true; return value; }));
    clients.agentSources.getScanStatus = vi.fn(async () => restartCompleted
      ? { active: false, progress: null, status: "idle", version }
      : { active: false, progress: null, status: "idle", version: { generation: 1, sequence: 7 } });
    clients.agentSources.startScan = vi.fn(async (input) => {
      if (input?.expectedVersion?.generation !== version.generation) throw new Error("Scan state changed");
      return { jobId: "first-after-restart", version: { generation: 2, sequence: 1 } };
    });
    clients.config.updateOnboarding = vi.fn(async () => ({ scanPermission: "scan_only" } as never));
    await render(clients);
    await act(async () => {
      stateApi.dispatch(appActions.agentSourceScanStatusReceived({ active: false, progress: null, status: "idle", version: { generation: 1, sequence: 7 } }));
    });

    await act(async () => { restartButton().click(); });
    expect(stateApi.state.agentSources.scanStateSyncRequired).toBe(true);
    await render(clients, false);
    expect(container.querySelector("button")).toBeNull();

    await act(async () => {
      restarting.resolve({ ok: true });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(clients.agentSources.getScanStatus).toHaveBeenCalled();
    expect(stateApi.state.agentSources.scanStamp?.version).toEqual(version);
    expect(stateApi.state.agentSources.scanStateSyncRequired).toBe(false);

    await render(clients);
    const scan = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "同步新增");
    expect(scan?.disabled).toBe(false);
    await act(async () => { scan?.click(); });
    expect(clients.agentSources.startScan).toHaveBeenCalledWith({ sourceId: "all", expectedVersion: version });
  });

  it("does not unlock scans on a healthy service that still reports the pre-restart generation", async () => {
    const clients = createClients(async () => healthy);
    let generation = 1;
    clients.agentSources.getScanStatus = vi.fn(async () => ({ active: false, progress: null, status: "idle", version: { generation, sequence: 8 } }));
    await render(clients);
    await act(async () => {
      stateApi.dispatch(appActions.agentSourceScanStatusReceived({ active: false, progress: null, status: "idle", version: { generation: 1, sequence: 7 } }));
    });

    await act(async () => { restartButton().click(); });
    const scan = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "同步新增");
    expect(scan()?.disabled).toBe(true);
    expect(stateApi.state.agentSources.scanStateSyncRequired).toBe(true);

    generation = 2;
    await advance(1_000);
    expect(stateApi.state.agentSources.scanStamp?.version?.generation).toBe(2);
    expect(stateApi.state.agentSources.scanStateSyncRequired).toBe(false);
    expect(scan()?.disabled).toBe(false);
  });

  it("keeps scan actions blocked until the post-restart snapshot arrives", async () => {
    const clients = createClients(async () => healthy);
    const pending = deferred<Awaited<ReturnType<AppClients["agentSources"]["getScanStatus"]>>>();
    clients.agentSources.getScanStatus = vi.fn(() => pending.promise);
    await render(clients);
    await act(async () => { restartButton().click(); });
    const scan = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "同步新增");
    expect(scan?.disabled).toBe(true);
    expect(container.textContent).not.toContain("记忆服务已重新启动");
    await act(async () => { pending.resolve({ active: false, progress: null, status: "idle", version: { generation: 2, sequence: 0 } }); });
    expect(scan?.disabled).toBe(false);
    expect(stateApi.state.agentSources.scanStamp?.version?.generation).toBe(2);
  });

  it.each(["scan", "stopped"] as const)("reconciles recovered execution before the first control after %s restart", async (phase) => {
    const clients = createClients(async () => healthy);
    const progress = { jobId: "recovered", attemptId: "attempt", sourceId: "all", phase, current: 1, total: 10, version: { generation: 2, sequence: 0 } };
    clients.agentSources.getScanStatus = vi.fn(async () => ({ active: phase === "scan", progress, version: progress.version }));
    clients.agentSources.cancelScan = vi.fn(async () => ({ ok: true, snapshot: { active: false, progress: null, status: "cancelled", version: { generation: 2, sequence: 1 }, execution: { jobId: progress.jobId, attemptId: progress.attemptId } } }));
    await render(clients);
    await act(async () => { restartButton().click(); });
    expect(stateApi.state.agentSources.scanProgress).toEqual(progress);
    const cancel = [...container.querySelectorAll("button")].find(button => button.getAttribute("aria-label")?.includes("停止"));
    expect(cancel?.disabled).toBe(false);
    await act(async () => { cancel!.click(); });
    expect(clients.agentSources.cancelScan).toHaveBeenCalledWith({ expectedExecution: { jobId: "recovered", attemptId: "attempt" } });
    expect(stateApi.state.agentSources.scanProgress).toBeNull();
  });

  it("does not announce success when health is ready but scan status is unavailable", async () => {
    const clients = createClients(async () => healthy);
    clients.agentSources.getScanStatus = vi.fn(async () => ({ active: false, progress: null, unavailable: { code: "memory_layer_unavailable" as const, message: "offline" } }));
    await render(clients);
    await act(async () => { restartButton().click(); });
    expect(container.textContent).not.toContain("记忆服务已重新启动");
    expect(stateApi.state.agentSources.scanUnavailable).toBeTruthy();
    expect(restartButton().disabled).toBe(false);
  });

  it("does not overwrite a newer execution with a delayed restart snapshot", async () => {
    const clients = createClients(async () => healthy);
    const pending = deferred<Awaited<ReturnType<AppClients["agentSources"]["getScanStatus"]>>>();
    clients.agentSources.getScanStatus = vi.fn(() => pending.promise);
    await render(clients);
    await act(async () => { restartButton().click(); });
    const progress = { jobId: "other-page", attemptId: "new-attempt", sourceId: "all", phase: "scan" as const, current: 1, total: 10, version: { generation: 2, sequence: 1 } };
    await act(async () => { stateApi.dispatch(appActions.agentSourceScanProgressReceived(progress)); });
    await act(async () => { pending.resolve({ active: false, progress: null, status: "idle", version: { generation: 2, sequence: 0 } }); });
    expect(stateApi.state.agentSources.scanProgress).toEqual(progress);
    expect(stateApi.state.agentSources.isScanning).toBe(true);
  });

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

  it("keeps scans locked until a fresh snapshot succeeds after a health timeout", async () => {
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
    const scan = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "同步新增");
    expect(scan()?.disabled).toBe(true);

    await advance(10_000);
    expect(restartSignal?.aborted).toBe(true);
    expect(restartButton().disabled).toBe(false);
    await advance(5_000);
    expect(container.textContent).toContain("运行中");
    expect(container.textContent).not.toContain("重启中");
    expect(scan()?.disabled).toBe(false);
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

  it("bounds a never-settling restart and unlocks scans only after a fresh snapshot", async () => {
    const clients = createClients(async () => healthy);
    restart.mockReturnValue(new Promise(() => undefined));
    const pendingStatus = deferred<Awaited<ReturnType<AppClients["agentSources"]["getScanStatus"]>>>();
    clients.agentSources.getScanStatus = vi.fn(() => pendingStatus.promise);
    await render(clients);
    const scan = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "同步新增");
    await act(async () => { restartButton().click(); });
    expect(scan()?.disabled).toBe(true);

    await advance(30_000);
    expect(restartButton().disabled).toBe(false);
    expect(scan()?.disabled).toBe(true);
    expect(container.textContent).not.toContain("记忆服务已重新启动");
    expect(stateApi.state.agentSources.scanStateSyncRequired).toBe(true);

    expect(clients.agentSources.getScanStatus).toHaveBeenCalled();
    await act(async () => { pendingStatus.resolve({ active: false, progress: null, status: "idle", version: { generation: 2, sequence: 0 } }); });
    expect(stateApi.state.agentSources.scanStamp?.version).toEqual({ generation: 2, sequence: 0 });
    expect(scan()?.disabled).toBe(false);
  });

  it("aborts a hanging post-restart status read and ignores its late result", async () => {
    const clients = createClients(async () => healthy);
    const late = deferred<Awaited<ReturnType<AppClients["agentSources"]["getScanStatus"]>>>();
    const retry = deferred<Awaited<ReturnType<AppClients["agentSources"]["getScanStatus"]>>>();
    let statusCalls = 0;
    let statusSignal: AbortSignal | undefined;
    const fresh = { active: false, progress: null, status: "idle" as const, version: { generation: 3, sequence: 0 } };
    clients.agentSources.getScanStatus = vi.fn((options?: { signal?: AbortSignal }) => {
      statusCalls += 1;
      if (statusCalls === 1) {
        statusSignal = options?.signal;
        return late.promise;
      }
      return retry.promise;
    });
    await render(clients);
    const scan = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "同步新增")!;
    await act(async () => { restartButton().click(); });
    expect(scan.disabled).toBe(true);

    await advance(5_000);
    expect(statusSignal?.aborted).toBe(true);
    expect(restartButton().disabled).toBe(false);
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "同步新增")?.disabled).toBe(true);
    await advance(1_000);
    expect(statusCalls).toBe(2);
    await act(async () => { retry.resolve(fresh); });
    expect(stateApi.state.agentSources.scanStamp?.version).toEqual(fresh.version);
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "同步新增")?.disabled).toBe(false);

    await act(async () => { late.resolve({ active: true, progress: null, status: "idle", version: { generation: 2, sequence: 99 } }); });
    expect(stateApi.state.agentSources.scanStamp?.version).toEqual(fresh.version);
  });

  it.each([false, true])("starts the first scan immediately after clearing a just-completed scan (leave page: %s)", async (leavePage) => {
    const clients = createClients(async () => healthy);
    const clearPending = deferred<Awaited<ReturnType<AppClients["localData"]["clear"]>>>();
    const previousVersion = { generation: 3, sequence: 8 };
    const clearedVersion = { generation: 3, sequence: 9 };
    let cleared = false;
    let scanStarted = false;
    clients.localData.clear = vi.fn(() => clearPending.promise);
    clients.config.updateOnboarding = vi.fn(async () => ({ scanPermission: "scan_only" } as never));
    clients.agentSources.getScanStatus = vi.fn(async () => scanStarted
      ? { active: true, progress: { jobId: "after-clear", attemptId: "attempt-after-clear", sourceId: "all", phase: "scan", current: 0, total: 0, version: { generation: 3, sequence: 10 } }, version: { generation: 3, sequence: 10 } }
      : { active: false, progress: null, status: "idle", version: cleared ? clearedVersion : previousVersion });
    clients.agentSources.startScan = vi.fn(async () => {
      scanStarted = true;
      return { jobId: "after-clear", attemptId: "attempt-after-clear", version: { generation: 3, sequence: 10 } };
    });

    await render(clients);
    await act(async () => {
      stateApi.dispatch(appActions.agentSourceScanCompleted({ jobId: "before-clear", attemptId: "old-attempt", sourceId: "all", succeeded: true, completedAt: new Date().toISOString(), version: previousVersion }));
    });
    const completedAt = Date.now();
    expect(stateApi.state.agentSources.recentScanCompletions).toHaveLength(1);
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "同步完成")?.disabled).toBe(true);
    const clearButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("清除所有本地数据"));
    expect(clearButton).toBeDefined();
    await act(async () => { clearButton!.click(); });
    const confirmButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("清空记忆数据库"));
    expect(confirmButton).toBeDefined();
    await act(async () => { confirmButton!.click(); });
    expect(clients.localData.clear).toHaveBeenCalledTimes(1);
    expect(stateApi.state.agentSources.memoryDataClearing).toBe(true);
    expect(stateApi.state.agentSources.scanStateSyncRequired).toBe(true);

    if (leavePage) await render(clients, false);
    cleared = true;
    await act(async () => {
      clearPending.resolve({} as Awaited<ReturnType<AppClients["localData"]["clear"]>>);
      await clearPending.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(Date.now()).toBe(completedAt); // No completion-feedback timer has elapsed.
    expect(stateApi.state.agentSources.recentScanCompletions).toEqual([]);
    expect(clients.agentSources.getScanStatus).toHaveBeenCalled();
    expect(clients.agentSources.listSources).toHaveBeenCalledTimes(2);
    expect(stateApi.state.agentSources.scanStamp?.version).toEqual(clearedVersion);
    expect(stateApi.state.agentSources.scanStateSyncRequired).toBe(false);
    expect(stateApi.state.agentSources.memoryDataClearing).toBe(false);

    await render(clients);
    const scanButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "同步新增");
    expect(scanButton?.disabled).toBe(false);
    await act(async () => { scanButton?.click(); });
    expect(clients.agentSources.startScan).toHaveBeenCalledTimes(1);
    expect(clients.agentSources.startScan).toHaveBeenCalledWith({ sourceId: "all", expectedVersion: clearedVersion });
    expect(stateApi.state.agentSources.scanProgress?.jobId).toBe("after-clear");
  });

  it("keeps scans locked after clear until both status and source refresh succeed", async () => {
    const clients = createClients(async () => healthy);
    const previousVersion = { generation: 4, sequence: 2 };
    const clearedVersion = { generation: 4, sequence: 3 };
    let failStatusRefresh = false;
    let failSourceRefresh = false;
    clients.localData.clear = vi.fn(async () => ({} as never));
    clients.agentSources.getScanStatus = vi.fn(async () => {
      if (failStatusRefresh) {
        failStatusRefresh = false;
        throw new Error("scan status refresh failed");
      }
      return { active: false, progress: null, status: "idle", version: clearedVersion };
    });
    clients.agentSources.listSources = vi.fn(async () => {
      if (failSourceRefresh) {
        failSourceRefresh = false;
        throw new Error("source list refresh failed");
      }
      return [];
    });
    await render(clients);
    await act(async () => {
      stateApi.dispatch(appActions.agentSourceScanStatusReceived({ active: false, progress: null, status: "idle", version: previousVersion }));
    });
    failStatusRefresh = true;
    failSourceRefresh = true;
    const clearButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("清除所有本地数据"));
    await act(async () => { clearButton?.click(); });
    const confirmButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("清空记忆数据库"));
    await act(async () => { confirmButton?.click(); });

    expect(stateApi.state.agentSources.scanStateSyncRequired).toBe(true);
    expect(stateApi.state.agentSources.scanStamp?.version).toEqual(previousVersion);
    await advance(1_000);
    expect(stateApi.state.agentSources.scanStateSyncRequired).toBe(true);
    expect(stateApi.state.agentSources.scanStamp?.version).toEqual(previousVersion);
    await advance(1_000);
    expect(stateApi.state.agentSources.scanStamp?.version).toEqual(clearedVersion);
    expect(stateApi.state.agentSources.scanStateSyncRequired).toBe(false);
    expect(clients.agentSources.getScanStatus).toHaveBeenCalledTimes(3);
    expect(clients.agentSources.listSources).toHaveBeenCalledTimes(3);
  });

  it("reconciles after a rejected clear request so a no-op failure does not leave scanning locked", async () => {
    const clients = createClients(async () => healthy);
    const version = { generation: 5, sequence: 4 };
    clients.localData.clear = vi.fn(async () => { throw new Error("clear rejected"); });
    clients.agentSources.getScanStatus = vi.fn(async () => ({ active: false, progress: null, status: "idle", version }));
    await render(clients);
    await act(async () => {
      stateApi.dispatch(appActions.agentSourceScanStatusReceived({ active: false, progress: null, status: "idle", version }));
    });
    const clearButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("清除所有本地数据"));
    await act(async () => { clearButton?.click(); });
    const confirmButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("清空记忆数据库"));
    await act(async () => {
      confirmButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("clear rejected");
    expect(stateApi.state.agentSources.memoryDataClearing).toBe(false);
    expect(stateApi.state.agentSources.scanStateSyncRequired).toBe(false);
    expect(stateApi.state.agentSources.scanStamp?.version).toEqual(version);
    expect(clients.agentSources.listSources).toHaveBeenCalledTimes(2);
  });
});

function ClientsHarness(props: { clients: AppClients; showPage?: boolean }) {
  const { setClients } = useApiClients();
  stateApi = useAppState();
  useEffect(() => { setClients(props.clients); }, [props.clients, setClients]);
  return <><AgentSourceScanReconciler />{props.showPage === false ? null : <SourcesSubPage />}</>;
}

function createClients(health: (signal?: AbortSignal) => Promise<unknown>): AppClients {
  return {
    runtimeConfig: {
      baseUrl: "http://127.0.0.1:18100",
      localToken: "test-token",
      memory: { baseUrl: "http://127.0.0.1:18960" }
    },
    localData: { getPath: async () => ({ ok: true, dataPath: "/test/memory" }), clear: async () => ({} as never) },
    agentSources: { listSources: vi.fn(async () => []), getScanStatus: async () => ({ running: false, jobId: null, progress: null, unavailable: null }) },
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
