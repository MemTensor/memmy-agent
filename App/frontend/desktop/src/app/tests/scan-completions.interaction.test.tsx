// @vitest-environment happy-dom
import { act, StrictMode, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { appReducer, createInitialAppState, type AppState } from "../../state/app-reducer.js";
import { appActions as a, AGENT_SOURCE_SCAN_COMPLETION_FEEDBACK_MS, type AppAction } from "../../state/app-actions.js";
import { useScanCompletions } from "../use-scan-completions.js";
import type { AgentSourceView } from "@memmy/local-api-contracts";
import { trackAgentSourceScanOutcome } from "../../analytics/memory-ui-analytics.js";
import { clearMemoryPanelCache } from "../../pages/memory/memory-panel-cache.js";
vi.mock("../../analytics/memory-ui-analytics.js", () => ({ trackAgentSourceScanOutcome: vi.fn() }));
vi.mock("../../pages/memory/memory-panel-cache.js", () => ({ clearMemoryPanelCache: vi.fn() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const completion = (sequence: number, attemptId = "a") => ({ version: { generation: 1, sequence }, jobId: "job", attemptId, sourceId: "all", succeeded: true, completedAt: "2026-10-21T00:00:00Z" });
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
it("does not replace newer source statistics with a previous attempt's delayed completion refresh", async () => {
  let dispatch!: (action: AppAction) => void; let state!: AppState;
  const pending: Array<(sources: AgentSourceView[]) => void> = [];
  const client = { listSources: vi.fn(() => new Promise<AgentSourceView[]>(resolve => pending.push(resolve))) };
  function Host() {
    [state, dispatch] = useReducer(appReducer, createInitialAppState());
    useScanCompletions(client, state.agentSources, dispatch, key => key);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const newerSources: AgentSourceView[] = []; const olderSources: AgentSourceView[] = [];
  try {
    await act(async () => { root.render(<Host />); });
    await act(async () => { dispatch(a.agentSourceScanCompleted(completion(1))); });
    await act(async () => { dispatch(a.agentSourceScanCompleted(completion(2, "retry"))); });
    expect(pending).toHaveLength(2);
    await act(async () => { pending[1]!(newerSources); });
    expect(state.agentSources.items).toBe(newerSources);
    await act(async () => { pending[0]!(olderSources); });
    expect(state.agentSources.items).toBe(newerSources);
  } finally { act(() => root.unmount()); }
});
it("executes accepted completion effects once and expires retry feedback independently under StrictMode", async () => {
  vi.useFakeTimers(); let dispatch!: (action: AppAction) => void; let state!: AppState;
  const client = { listSources: vi.fn(async () => []) };
  const initial = appReducer(createInitialAppState(), a.agentSourceScanCompleted(completion(2)));
  function Host() {
    [state, dispatch] = useReducer(appReducer, initial);
    useScanCompletions(client, state.agentSources, dispatch, key => key);
    return null;
  }
  const container = document.createElement("div"); const root = createRoot(container);
  try {
    await act(async () => { root.render(<StrictMode><Host /></StrictMode>); });
    expect(trackAgentSourceScanOutcome).toHaveBeenCalledTimes(1); expect(clearMemoryPanelCache).toHaveBeenCalledTimes(1); expect(client.listSources).toHaveBeenCalledTimes(1);
    await act(async () => { dispatch(a.agentSourceScanCompleted(completion(2))); });
    expect(client.listSources).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); dispatch(a.agentSourceScanCompleted(completion(3, "retry"))); });
    expect(client.listSources).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(AGENT_SOURCE_SCAN_COMPLETION_FEEDBACK_MS - 1000); });
    expect(state.agentSources.recentScanCompletions[0]?.attemptId).toBe("retry");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(state.agentSources.recentScanCompletions).toEqual([]);
    await act(async () => { dispatch(a.agentSourceScanCompleted(completion(3, "retry"))); });
    expect(client.listSources).toHaveBeenCalledTimes(2);
  } finally { act(() => root.unmount()); }
});
it("rejected old or cancelled completions never consume analytics/cache effects", async () => {
  let dispatch!: (action: AppAction) => void;
  const client = { listSources: vi.fn(async () => []) };
  const initial = appReducer(createInitialAppState(), a.agentSourceScanStatusReceived({ active: false, progress: null, version: { generation: 1, sequence: 3 }, status: "cancelled", execution: { jobId: "job", attemptId: "a" } }));
  function Host() { const [state, send] = useReducer(appReducer, initial); dispatch = send; useScanCompletions(client, state.agentSources, send, key => key); return null; }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => { root.render(<Host />); });
    await act(async () => { dispatch(a.agentSourceScanCompleted(completion(2))); });
    expect(trackAgentSourceScanOutcome).not.toHaveBeenCalled(); expect(clearMemoryPanelCache).not.toHaveBeenCalled(); expect(client.listSources).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); }
});
