/** Memory source scan tests. */
import { AgentSourceViewSchema } from "@memmy/local-api-contracts";
import { describe, expect, it, vi } from "vitest";
import { appActions, type AppAction } from "../../state/app-actions.js";
import { startAgentSourceScan } from "../memory-source-scan.js";

const source = AgentSourceViewSchema.parse({
  sourceId: "cursor",
  displayName: "Cursor",
  dataPath: "/Users/test/.cursor",
  builtin: true,
  available: true,
  status: "skill_installed",
  messageCount: 1,
  lastScannedAt: null
});

describe("startAgentSourceScan", () => {
  it("schedules fallback list reload for real scans and reports fallback failures", async () => {
    const actions: AppAction[] = [];
    let fallback: () => void = () => {
      throw new Error("fallback was not scheduled");
    };
    const clients = {
      agentSources: {
        startScan: vi.fn(async () => ({ jobId: "job-1" })),
        listSources: vi.fn(async () => {
          throw new Error("SSE fallback failed");
        })
      }
    };

    await startAgentSourceScan({
      clients,
      dispatch: (action) => actions.push(action),
      queuedMessage: "queued",
      scheduleFallback(callback) {
        fallback = callback;
      }
    });
    fallback();
    await Promise.resolve();

    expect(actions).toEqual([
      appActions.agentSourceScanStarted(),
      appActions.agentSourceScanProgressReceived({
        jobId: "job-1",
        sourceId: "all",
        phase: "scan",
        current: 0,
        total: 0,
        message: "queued"
      }),
      appActions.agentSourcesFailed("SSE fallback failed")
    ]);
  });

  it("loads sources when the fallback callback runs", async () => {
    const actions: AppAction[] = [];
    let fallback: () => void = () => {
      throw new Error("fallback was not scheduled");
    };
    const clients = {
      agentSources: {
        startScan: vi.fn(async () => ({ jobId: "job-2" })),
        listSources: vi.fn(async () => [source])
      }
    };

    await startAgentSourceScan({
      clients,
      dispatch: (action) => actions.push(action),
      queuedMessage: "queued",
      scheduleFallback(callback) {
        fallback = callback;
      }
    });
    fallback();
    await Promise.resolve();

    expect(actions.at(-1)).toEqual(appActions.agentSourcesRefreshed([source]));
  });

  it("passes the requested source id to the backend scan job", async () => {
    const actions: AppAction[] = [];
    const clients = {
      agentSources: {
        startScan: vi.fn(async () => ({ jobId: "job-source" })),
        listSources: vi.fn(async () => [source])
      }
    };

    await startAgentSourceScan({
      clients,
      dispatch: (action) => actions.push(action),
      sourceId: "openclaw",
      queuedMessage: "queued",
      scheduleFallback() {
        return undefined;
      }
    });

    expect(clients.agentSources.startScan).toHaveBeenCalledWith({ sourceId: "openclaw" });
    expect(actions[0]).toEqual(appActions.agentSourceScanStarted("openclaw"));
    expect(actions).toContainEqual(appActions.agentSourceScanProgressReceived({
      jobId: "job-source",
      sourceId: "openclaw",
      phase: "scan",
      current: 0,
      total: 0,
      message: "queued"
    }));
  });

  it("passes the requested scan mode to the backend scan job", async () => {
    const actions: AppAction[] = [];
    const clients = {
      agentSources: {
        startScan: vi.fn(async () => ({ jobId: "job-full" })),
        listSources: vi.fn(async () => [source])
      }
    };

    await startAgentSourceScan({
      clients,
      dispatch: (action) => actions.push(action),
      sourceId: "all",
      mode: "full",
      queuedMessage: "queued",
      scheduleFallback() {
        return undefined;
      }
    });

    expect(clients.agentSources.startScan).toHaveBeenCalledWith({ sourceId: "all", mode: "full" });
    expect(actions).toContainEqual(appActions.agentSourceScanProgressReceived({
      jobId: "job-full",
      sourceId: "all",
      phase: "scan",
      current: 0,
      total: 0,
      message: "queued"
    }));
  });

  it("uses the caller's localized formatter for scan request failures", async () => {
    const actions: AppAction[] = [];
    const formatError = vi.fn(() => "找不到路径：C:\\Users\\10970\\.claude\\projects");
    const clients = {
      agentSources: {
        startScan: vi.fn(async () => {
          throw new Error("ENOENT: no such file or directory, scandir 'C:\\Users\\10970\\.claude\\projects'");
        }),
        listSources: vi.fn(async () => [source])
      }
    };

    await startAgentSourceScan({
      clients,
      dispatch: (action) => actions.push(action),
      queuedMessage: "queued",
      formatError,
      scheduleFallback() {
        return undefined;
      }
    });

    expect(formatError).toHaveBeenCalledTimes(1);
    expect(actions).toEqual([
      appActions.agentSourceScanStarted(),
      appActions.agentSourcesFailed("找不到路径：C:\\Users\\10970\\.claude\\projects")
    ]);
  });

  it("uses backend scan status after starting a resumed scan job", async () => {
    const actions: AppAction[] = [];
    const clients = {
      agentSources: {
        startScan: vi.fn(async () => ({ jobId: "job-resume" })),
        getScanStatus: vi.fn(async () => ({
          active: true,
          progress: {
            jobId: "job-resume",
            sourceId: "cursor",
            phase: "add" as const,
            current: 12,
            total: 20,
            message: "Resuming raw memory import"
          }
        })),
        listSources: vi.fn(async () => [source])
      }
    };

    await startAgentSourceScan({
      clients,
      dispatch: (action) => actions.push(action),
      queuedMessage: "queued",
      scheduleFallback() {
        return undefined;
      }
    });

    expect(actions).toContainEqual(appActions.agentSourceScanProgressReceived({
      jobId: "job-resume",
      sourceId: "cursor",
      phase: "add",
      current: 12,
      total: 20,
      message: "Resuming raw memory import"
    }));
  });

  it("runs scan permission preparation before starting the backend scan job", async () => {
    const actions: AppAction[] = [];
    const calls: string[] = [];
    const clients = {
      agentSources: {
        startScan: vi.fn(async () => {
          calls.push("startScan");
          return { jobId: "job-3" };
        }),
        listSources: vi.fn(async () => [source])
      }
    };

    await startAgentSourceScan({
      clients,
      dispatch: (action) => actions.push(action),
      async ensureScanPermission() {
        calls.push("ensureScanPermission");
      },
      queuedMessage: "queued",
      scheduleFallback() {
        return undefined;
      }
    });

    expect(actions[0]).toEqual(appActions.agentSourceScanStarted());
    expect(calls).toEqual(["ensureScanPermission", "startScan"]);
  });
});
