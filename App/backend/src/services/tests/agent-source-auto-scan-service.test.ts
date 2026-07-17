/** Agent source auto scan service tests. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSourceAutoScanService } from "../agent-source-auto-scan-service.js";
import type { ScanPreferences } from "@memmy/local-api-contracts";

const enabledPreferences: ScanPreferences = {
  autoScanKnownAgents: true,
  watchFileChanges: true,
  autoInjectSkill: false
};

afterEach(() => {
  vi.useRealTimers();
});

describe("agent source auto scan service", () => {
  it("posts to the local scan endpoint on the configured interval", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async () => ({} as Response));
    const service = createAgentSourceAutoScanService({
      baseUrl: "http://127.0.0.1:19001",
      localToken: "test-token",
      intervalMs: 1_000,
      initialDelayMs: 1_000,
      fetchFn,
      getScanPreferences: () => enabledPreferences
    });

    service.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchFn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(fetchFn).toHaveBeenCalledWith("http://127.0.0.1:19001/api/agent-sources/scan", {
      method: "POST",
      headers: {
        "x-memmy-local-token": "test-token"
      },
      signal: expect.any(AbortSignal)
    });
    service.close();
  });

  it("does not overlap auto scan requests", async () => {
    vi.useFakeTimers();
    let resolveFetch: (response: Response) => void = () => undefined;
    const fetchFn = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    const service = createAgentSourceAutoScanService({
      baseUrl: "http://127.0.0.1:19001",
      localToken: "test-token",
      intervalMs: 100,
      initialDelayMs: 100,
      fetchFn,
      getScanPreferences: () => enabledPreferences
    });

    service.start();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetchFn).toHaveBeenCalledTimes(1);

    resolveFetch({} as Response);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    service.close();
  });

  it("clears a pending auto scan when closed", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async () => ({} as Response));
    const service = createAgentSourceAutoScanService({
      baseUrl: "http://127.0.0.1:19001",
      localToken: "test-token",
      intervalMs: 100,
      initialDelayMs: 100,
      fetchFn,
      getScanPreferences: () => enabledPreferences
    });

    service.start();
    service.close();
    await vi.advanceTimersByTimeAsync(100);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("skips scans when hourly incremental sync is disabled", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async () => ({} as Response));
    const service = createAgentSourceAutoScanService({
      baseUrl: "http://127.0.0.1:19001",
      localToken: "test-token",
      intervalMs: 100,
      initialDelayMs: 100,
      fetchFn,
      getScanPreferences: () => ({ ...enabledPreferences, watchFileChanges: false })
    });

    service.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(fetchFn).not.toHaveBeenCalled();
    service.close();
  });
});
