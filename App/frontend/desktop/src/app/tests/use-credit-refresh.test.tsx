// @vitest-environment happy-dom
import { act, useCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCreditRefresh } from "../use-credit-refresh.js";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
let refresh: () => void;
const version = (data: { version: number; text: string }) => data.version;
function Harness({ read, account = "a" }: { read: (signal: AbortSignal) => Promise<{ version: number; text: string }>; account?: string }) {
  const load = useCallback(read, [read, account]);
  const result = useCreditRefresh(load, true, account, -1, version); refresh = result.refresh;
  return <span>{result.data?.text ?? "empty"}:{result.error ?? "ok"}</span>;
}
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible"); host = document.createElement("div"); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.restoreAllMocks(); });
it("serializes manual/timed reads, pauses in background and aborts on exit", async () => {
  let resolve!: (data: { version: number; text: string }) => void;
  const read = vi.fn<(signal: AbortSignal) => Promise<{ version: number; text: string }>>().mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue({ version: 2, text: "new" });
  await act(async () => root.render(<Harness read={read} />));
  await act(async () => { refresh(); await vi.advanceTimersByTimeAsync(30000); }); expect(read).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ version: 1, text: "old" })); expect(read).toHaveBeenCalledTimes(2); expect(host.textContent).toBe("new:ok");
  await act(async () => vi.advanceTimersByTimeAsync(10000)); expect(read).toHaveBeenCalledTimes(3);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(30000); }); expect(read).toHaveBeenCalledTimes(3);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await act(async () => document.dispatchEvent(new Event("visibilitychange"))); expect(read).toHaveBeenCalledTimes(4);
  await act(async () => { window.dispatchEvent(new Event("blur")); await vi.advanceTimersByTimeAsync(30000); }); expect(read).toHaveBeenCalledTimes(4);
  await act(async () => window.dispatchEvent(new Event("focus"))); expect(read).toHaveBeenCalledTimes(5);
});
it("hides the old account immediately and ignores its delayed response", async () => {
  let resolve!: (data: { version: number; text: string }) => void;
  const old = vi.fn(() => new Promise<{ version: number; text: string }>(done => { resolve = done; }));
  const next = vi.fn(async () => ({ version: 1, text: "account-b" }));
  await act(async () => root.render(<Harness read={old} />));
  await act(async () => root.render(<Harness account="b" read={next} />));
  await act(async () => resolve({ version: 99, text: "account-a" })); expect(host.textContent).toBe("account-b:ok");
});
it("retains last good data on failure and rejects responses older than a change event", async () => {
  const read = vi.fn(async () => ({ version: 2, text: "balance-2" }));
  await act(async () => root.render(<Harness read={read} />));
  await act(async () => window.dispatchEvent(new CustomEvent("credits.changed", { detail: { userId: "b", accountVersion: 3 } }))); expect(read).toHaveBeenCalledTimes(1);
  await act(async () => window.dispatchEvent(new CustomEvent("credits.changed", { detail: { userId: "a", accountVersion: 3 } })));
  expect(host.textContent).toBe("balance-2:load");
  read.mockResolvedValue({ version: 3, text: "balance-3" }); await act(async () => refresh()); expect(host.textContent).toBe("balance-3:ok");
  await act(async () => window.dispatchEvent(new CustomEvent("credits.changed", { detail: { userId: "a", accountVersion: 2 } }))); expect(read).toHaveBeenCalledTimes(3);
  read.mockRejectedValue(new Error("offline")); await act(async () => refresh()); expect(host.textContent).toBe("balance-3:load");
});
