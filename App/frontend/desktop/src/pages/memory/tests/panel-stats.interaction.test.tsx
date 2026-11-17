// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePanelStats } from "../use-panel-stats.js";
import { ApiRequestError } from "../../../api/http.js";
import { createMemoryRuntimeClientStub } from "./fixtures.js";

afterEach(() => vi.useRealTimers());
describe("statistics failure lifecycle", () => {
  it("keeps safe results on a network failure, clears them on denial ", async () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    const root = createRoot(container);
    const snapshot = {status: "ready", data: {overview: {count: 42}}, serverTime: "2026-10-27T00:00:00Z"};
    const getPanelStats = vi.fn().mockResolvedValueOnce(snapshot)
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new ApiRequestError("denied", 403));
    const client = createMemoryRuntimeClientStub({getPanelStats});
    function Fixture() {
      const {state} = usePanelStats(client, "overview", async () => ({count: 0}));
      return <div>{JSON.stringify(state)}</div>;
    }
    try {
      await act(async () => root.render(<Fixture/>));
      expect(container.textContent).toContain('"count":42');
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(container.textContent).toContain('"count":42');
      expect(container.textContent).not.toContain("offline");
      await act(async () => vi.advanceTimersByTimeAsync(120_000));
      expect(container.textContent).not.toContain('"count":42');
      expect(container.textContent).toContain("denied");
    } finally { await act(async () => root.unmount()); }
  });
});

it("loads the dedicated overview without waiting for analysis and does not downgrade denial", async () => {
  vi.useFakeTimers();
  const container = document.createElement("div");
  const root = createRoot(container);
  const getPanelOverviewStats = vi.fn().mockResolvedValueOnce({status: "ready", data: {count: 42}})
    .mockRejectedValue(new ApiRequestError("denied", 403));
  const getPanelStats = vi.fn();
  const client = createMemoryRuntimeClientStub({getPanelOverviewStats, getPanelStats});
  function Fixture() {
    const {state} = usePanelStats(client, "overview", async () => ({count: 0}));
    return <div>{JSON.stringify(state)}</div>;
  }
  try {
    await act(async () => root.render(<Fixture/>));
    expect(container.textContent).toContain('"count":42');
    expect(getPanelStats).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(container.textContent).not.toContain('"count":42');
    expect(getPanelStats).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

it("publishes prepared analysis on a short status poll instead of waiting two seconds", async () => {
  vi.useFakeTimers();
  const container = document.createElement("div"); const root = createRoot(container);
  const getPanelStats = vi.fn().mockResolvedValueOnce({status: "preparing"})
    .mockResolvedValue({status: "ready",data: {analysis: {count: 42}}});
  const client = createMemoryRuntimeClientStub({getPanelStats});
  function Fixture() { const {state} = usePanelStats(client,"analysis",async()=>({count:0}));return <div>{JSON.stringify(state)}</div>; }
  try {
    await act(async () => root.render(<Fixture/>));
    expect(container.textContent).toContain("loading");
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(container.textContent).toContain('"count":42');
    expect(getPanelStats).toHaveBeenCalledTimes(2);
  } finally { await act(async () => root.unmount()); }
});
