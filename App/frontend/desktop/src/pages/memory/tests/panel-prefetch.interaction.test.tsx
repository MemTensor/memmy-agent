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
