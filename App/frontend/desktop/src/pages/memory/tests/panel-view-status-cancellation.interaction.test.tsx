// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createHttpMemoryRuntimeClient, type MemoryRuntimeClient } from "../../../api/memory-runtime-client.js";
import { ApiRequestError } from "../../../api/http.js";
import { PanelVisibilityContext } from "../panel-visibility.js";
import { usePanelViewStatus } from "../panel-view-status.js";
import { createMemoryRuntimeClientStub } from "./fixtures.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const at = "2026-10-31T00:00:00Z";
function ViewCheck(props: { client: MemoryRuntimeClient; section?: string; invalidate?: () => void }) {
  usePanelViewStatus(props.client, props.section ?? "L2", props.invalidate ?? (() => {}));
  return null;
}
async function runtimeFixture() {
  const signals: AbortSignal[] = [];
  let available = false;
  const check = vi.fn((signal: AbortSignal) => {
    signals.push(signal);
    return new Response(available ? JSON.stringify({
      viewId: "view", instanceId: "instance", safety: "safe", updated: false, serverTime: at
    }) : "{}", { status: available ? 200 : 503 });
  });
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const input = JSON.parse(init.body);
    if (input.op === "check") return check(init.signal);
    return new Response(JSON.stringify({
      viewId: "view", instanceId: "instance", safety: "safe", createdAt: at, serverTime: at,
      page: 1, pageSize: 20, total: 0, totalPages: 1, hasNext: false, hasPrev: false, items: []
    }));
  }));
  const client = createHttpMemoryRuntimeClient({ baseUrl: "http://fixture.invalid", localToken: "fixture" });
  await client.listPanelItems({ layer: "L2", page: 1 });
  return { client, check, signals, recover: () => { available = true; } };
}

it("stops retries when leaving a memory subpage and checks again on return", async () => {
  vi.useFakeTimers();
  const fixture = await runtimeFixture();
  const root = createRoot(document.createElement("div"));
  const invalidate = vi.fn();
  const render = (visible: boolean) => act(async () => root.render(
    <PanelVisibilityContext.Provider value={visible}>
      <ViewCheck client={fixture.client} invalidate={invalidate} />
    </PanelVisibilityContext.Provider>
  ));
  try {
    await render(true);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(fixture.check).toHaveBeenCalledTimes(1);
    invalidate.mockClear();
    await render(false);
    expect(fixture.signals[0].aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(fixture.check).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
    fixture.recover();
    await render(true);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(fixture.check).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(fixture.check).toHaveBeenCalledTimes(2);
  } finally { await act(async () => root.unmount()); }
});

it("keeps a shared check and its recovery alive for another visible subscriber", async () => {
  vi.useFakeTimers();
  const fixture = await runtimeFixture();
  const root = createRoot(document.createElement("div"));
  const render = (firstVisible: boolean) => act(async () => root.render(<>
    <PanelVisibilityContext.Provider value={firstVisible}><ViewCheck client={fixture.client} /></PanelVisibilityContext.Provider>
    <ViewCheck client={fixture.client} />
  </>));
  try {
    await render(true);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(fixture.check).toHaveBeenCalledTimes(1);
    await render(false);
    expect(fixture.signals[0].aborted).toBe(false);
    fixture.recover();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(fixture.check).toHaveBeenCalledTimes(2);
    expect(fixture.signals[1]).toBe(fixture.signals[0]);
  } finally { await act(async () => root.unmount()); }
});

it("unsubscribes an unmounted page during retry backoff", async () => {
  vi.useFakeTimers();
  const fixture = await runtimeFixture();
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<ViewCheck client={fixture.client} />));
  await act(async () => vi.advanceTimersByTimeAsync(0));
  await act(async () => root.unmount());
  expect(fixture.signals[0].aborted).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(fixture.check).toHaveBeenCalledTimes(1);
});

it.each(["client", "section", "subpage", "window"] as const)("cancels an in-flight check on %s change and ignores its late rejection", async change => {
  vi.useFakeTimers();
  let reject!: (error: unknown) => void;
  let signal!: AbortSignal;
  const checkPanelView = vi.fn((_section: string, nextSignal?: AbortSignal) => {
    signal = nextSignal!;
    return new Promise<{ updated: boolean }>((_resolve, fail) => { reject = fail; });
  });
  const client = createMemoryRuntimeClientStub({ checkPanelView });
  const otherClient = createMemoryRuntimeClientStub({ checkPanelView: async () => ({ updated: false }) });
  const invalidate = vi.fn();
  const root = createRoot(document.createElement("div"));
  const render = (changed: boolean) => act(async () => root.render(
    <PanelVisibilityContext.Provider value={!(changed && change === "subpage")}>
      <ViewCheck client={changed && change === "client" ? otherClient : client}
        section={changed && change === "section" ? "L1" : "L2"} invalidate={invalidate} />
    </PanelVisibilityContext.Provider>
  ));
  try {
    await render(false);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(signal.aborted).toBe(false);
    if (change === "window") {
      vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    } else await render(true);
    expect(signal.aborted).toBe(true);
    invalidate.mockClear();
    await act(async () => { reject(new ApiRequestError("obsolete check", 409)); });
    expect(invalidate).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});
