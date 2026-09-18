// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useComputerHistoryModelSync } from "./computer-history-model-sync.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
function Harness(props: Parameters<typeof useComputerHistoryModelSync>[0]) {
  useComputerHistoryModelSync(props);
  return null;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("syncs default and explicit models, refreshes settings changes and stops on unmount", async () => {
  const client = { setComputerHistoryModel: vi.fn().mockResolvedValue({}) };
  const render = (preset: string | null, revision = "account-v1") => act(async () => {
    root.render(<Harness client={client} enabled preset={preset} revision={revision}/>);
  });
  await render(null);
  expect(client.setComputerHistoryModel).toHaveBeenLastCalledWith(null);
  await render("custom");
  expect(client.setComputerHistoryModel).toHaveBeenLastCalledWith("custom");
  await render("custom", "account-v2");
  expect(client.setComputerHistoryModel).toHaveBeenCalledTimes(3);
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(client.setComputerHistoryModel).toHaveBeenCalledTimes(4);
  await act(async () => root.render(null));
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(client.setComputerHistoryModel).toHaveBeenCalledTimes(4);
});

it("serializes rapid model changes and skips superseded queued choices", async () => {
  let finish!: (value: unknown) => void;
  const client = { setComputerHistoryModel: vi.fn().mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValue({}) };
  const render = (preset: string) => act(async () => {
    root.render(<Harness client={client} enabled preset={preset} revision="v1"/>);
  });
  await render("account");
  await render("custom-a");
  await render("custom-b");
  expect(client.setComputerHistoryModel).toHaveBeenCalledTimes(1);
  await act(async () => finish({}));
  expect(client.setComputerHistoryModel.mock.calls.map(([preset]) => preset)).toEqual(["account", "custom-b"]);
});

it("retries failed synchronization and does not sync before bootstrap is ready", async () => {
  const client = { setComputerHistoryModel: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({}) };
  await act(async () => root.render(<Harness client={client} enabled={false} preset="custom" revision="v1"/>));
  expect(client.setComputerHistoryModel).not.toHaveBeenCalled();
  await act(async () => root.render(<Harness client={client} enabled preset="custom" revision="v1"/>));
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(client.setComputerHistoryModel).toHaveBeenCalledTimes(2);
  expect(client.setComputerHistoryModel).toHaveBeenLastCalledWith("custom");
});

it("does not let an inactive window overwrite the selected model", async () => {
  vi.mocked(document.hasFocus).mockReturnValue(false);
  const client = { setComputerHistoryModel: vi.fn().mockResolvedValue({}) };
  await act(async () => root.render(<Harness client={client} enabled preset={null} revision="v1"/>));
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(client.setComputerHistoryModel).not.toHaveBeenCalled();
  vi.mocked(document.hasFocus).mockReturnValue(true);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(client.setComputerHistoryModel).toHaveBeenCalledOnce();
});
