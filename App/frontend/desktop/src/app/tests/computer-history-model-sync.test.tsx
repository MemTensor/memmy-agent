// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useComputerHistoryModelSync } from "../computer-history-model-sync.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
function Harness(props: Parameters<typeof useComputerHistoryModelSync>[0] & { taskPreset?: string }) {
  useComputerHistoryModelSync(props);
  return null;
}
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, "memmy", { configurable: true, value: { platform: "darwin" } });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); delete window.memmy; vi.useRealTimers(); vi.restoreAllMocks(); });

it("refreshes summary configuration without following task selections and stops on unmount", async () => {
  const client = { refreshComputerHistoryModel: vi.fn().mockResolvedValue({}) };
  const render = (taskPreset: string, revision = "account-v1") => act(async () => {
    root.render(<Harness client={client} enabled taskPreset={taskPreset} revision={revision}/>);
  });
  await render("default");
  expect(client.refreshComputerHistoryModel).toHaveBeenCalledWith();
  await render("custom");
  expect(client.refreshComputerHistoryModel).toHaveBeenCalledTimes(1);
  await render("custom", "account-v2");
  expect(client.refreshComputerHistoryModel).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(client.refreshComputerHistoryModel).toHaveBeenCalledTimes(3);
  await act(async () => root.render(null));
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(client.refreshComputerHistoryModel).toHaveBeenCalledTimes(3);
});

it("serializes rapid configuration revisions and skips superseded queued refreshes", async () => {
  let finish!: (value: unknown) => void;
  const client = { refreshComputerHistoryModel: vi.fn().mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValue({}) };
  const render = (revision: string) => act(async () => {
    root.render(<Harness client={client} enabled revision={revision}/>);
  });
  await render("v1");
  await render("v2");
  await render("v3");
  expect(client.refreshComputerHistoryModel).toHaveBeenCalledTimes(1);
  await act(async () => finish({}));
  expect(client.refreshComputerHistoryModel.mock.calls).toEqual([[], []]);
});

it("retries failed synchronization and does not sync before bootstrap is ready", async () => {
  const client = { refreshComputerHistoryModel: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({}) };
  await act(async () => root.render(<Harness client={client} enabled={false} revision="v1"/>));
  expect(client.refreshComputerHistoryModel).not.toHaveBeenCalled();
  await act(async () => root.render(<Harness client={client} enabled revision="v1"/>));
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(client.refreshComputerHistoryModel).toHaveBeenCalledTimes(2);
  expect(client.refreshComputerHistoryModel).toHaveBeenLastCalledWith();
});

it("does not let an inactive window overwrite the selected model", async () => {
  vi.mocked(document.hasFocus).mockReturnValue(false);
  const client = { refreshComputerHistoryModel: vi.fn().mockResolvedValue({}) };
  await act(async () => root.render(<Harness client={client} enabled revision="v1"/>));
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(client.refreshComputerHistoryModel).not.toHaveBeenCalled();
  vi.mocked(document.hasFocus).mockReturnValue(true);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(client.refreshComputerHistoryModel).toHaveBeenCalledOnce();
});

it("refreshes the same summary assignment on Windows 11", async () => {
  Object.defineProperty(window, "memmy", { configurable: true, value: { platform: "win32", osRelease: "10.0.22631" } });
  const client = { refreshComputerHistoryModel: vi.fn().mockResolvedValue({}) };
  await act(async () => root.render(<Harness client={client} enabled revision="summary-v1"/>));
  expect(client.refreshComputerHistoryModel).toHaveBeenCalledWith();
});

it.each(["win32", "linux", undefined])("never syncs or retries History on an unsupported/unknown host: %s", async (platform) => {
  Object.defineProperty(window, "memmy", { configurable: true, value: platform ? { platform } : undefined });
  const client = { refreshComputerHistoryModel: vi.fn().mockRejectedValue(new Error("unsupported")) };
  await act(async () => root.render(<Harness client={client} enabled revision="v1"/>));
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  await act(async () => window.dispatchEvent(new Event("focus")));
  await act(async () => root.render(<Harness client={client} enabled revision="v2"/>));
  expect(client.refreshComputerHistoryModel).not.toHaveBeenCalled();
});
