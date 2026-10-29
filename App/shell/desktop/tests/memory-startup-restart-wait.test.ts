import { afterEach, expect, it, vi } from "vitest";
import { waitForMemoryStartupBeforeRestart } from "../src/main/runtime-services.js";

afterEach(() => vi.useRealTimers());

it("settles a restart request when startup keeps waiting on a busy database owner", async () => {
  vi.useFakeTimers();
  let finishStartup!: () => void;
  const startup = new Promise<void>((resolve) => { finishStartup = resolve; });
  const restart = vi.fn();
  const request = waitForMemoryStartupBeforeRestart(startup).then(restart);
  const rejected = expect(request).rejects.toThrow("restart was not started");
  await vi.advanceTimersByTimeAsync(120_000);
  await rejected;
  expect(restart).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);

  // The timeout leaves the original startup running and does not queue a late restart.
  finishStartup();
  await startup;
  await vi.runAllTimersAsync();
  expect(restart).not.toHaveBeenCalled();
  await waitForMemoryStartupBeforeRestart(startup).then(restart);
  expect(restart).toHaveBeenCalledOnce();
});

it("restarts promptly after startup settles and removes the wait timer", async () => {
  vi.useFakeTimers();
  await waitForMemoryStartupBeforeRestart(Promise.resolve());
  await waitForMemoryStartupBeforeRestart(null);
  expect(vi.getTimerCount()).toBe(0);
});
