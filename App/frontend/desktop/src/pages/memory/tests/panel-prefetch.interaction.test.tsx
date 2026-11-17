// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { usePanelPrefetch } from "../use-panel-prefetch.js";
import { createMemoryRuntimeClientStub } from "./fixtures.js";
it("prefetches serially after idle time, pauses while hidden, and cancels on navigation", async () => {
  vi.useFakeTimers();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const element = document.createElement("div");
  const root = createRoot(element);
  let finish!: () => void;
  const prefetch = vi.fn(
    (_section: string, _signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  const client = createMemoryRuntimeClientStub({ prefetchPanel: prefetch });
  function Fixture({ current }: { current: string }) {
    usePanelPrefetch(client, current);
    return null;
  }
  try {
    await act(async () => root.render(<Fixture current="memories" />));
    expect(prefetch).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(prefetch.mock.calls[0]?.[0]).toBe("tasks");
    await act(async () => vi.advanceTimersByTimeAsync(20000));
    expect(prefetch).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => vi.advanceTimersByTimeAsync(20000));
    expect(prefetch).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<Fixture current="tasks" />));
    expect(prefetch.mock.calls[0]?.[1].aborted).toBe(true);
  } finally {
    await act(async () => root.unmount());
    hidden.mockRestore();
    vi.useRealTimers();
  }
});

it("warms the overview on entry and waits for it before reading list previews", async () => {
  vi.useFakeTimers();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const root = createRoot(document.createElement("div"));
  const getPanelOverviewStats = vi.fn()
    .mockResolvedValueOnce({status: "preparing"})
    .mockResolvedValue({status: "ready", data: {}});
  let attempts = 0;
  const prefetchPanel = vi.fn(async (_section: string, _signal: AbortSignal) => ++attempts > 1);
  const client = createMemoryRuntimeClientStub({getPanelOverviewStats, prefetchPanel});
  function Fixture() { usePanelPrefetch(client, "overview"); return null; }
  try {
    await act(async () => root.render(<Fixture/>));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(getPanelOverviewStats).toHaveBeenCalledTimes(1);
    expect(prefetchPanel).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(prefetchPanel.mock.calls[0]?.[0]).toBe("L1");
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(prefetchPanel.mock.calls[1]?.[0]).toBe("L1");
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(prefetchPanel.mock.calls[2]?.[0]).toBe("tasks");
  } finally {
    await act(async () => root.unmount());
    hidden.mockRestore(); vi.useRealTimers();
  }
});

it("warms analysis before lists and prioritizes the actual analytics navigation id", async () => {
  vi.useFakeTimers();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const root = createRoot(document.createElement("div"));
  const calls: string[] = [];
  let ready = false;
  const client = createMemoryRuntimeClientStub({
    getPanelStats: vi.fn(async () => { calls.push("analysis"); return {status: ready ? "ready" : "preparing"} as never; }),
    getPanelOverviewStats: vi.fn(async () => { calls.push("overview"); return {status: "ready"} as never; }),
    prefetchPanel: vi.fn(async section => { calls.push(section); })
  });
  function Fixture() { usePanelPrefetch(client, "analytics"); return null; }
  try {
    await act(async () => root.render(<Fixture/>));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(calls).toEqual(["analysis"]);
    ready = true;
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(calls).toEqual(["analysis", "analysis", "overview", "L1"]);
  } finally {
    await act(async () => root.unmount());hidden.mockRestore();vi.useRealTimers();
  }
});
