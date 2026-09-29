import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAppMemoryBudget } from "../../src/model/token-usage.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchAppMemoryBudget", () => {
  it("returns null when the caller aborts before the App responds", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        return;
      }
      const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    }));
    const pending = fetchAppMemoryBudget({
      runtimeConfig: { baseUrl: "http://127.0.0.1:18100", localToken: "runtime-token" },
      fetchImpl: fetchImpl as typeof fetch,
      signal: controller.signal,
      timeoutMs: 60_000
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    controller.abort();
    await expect(pending).resolves.toBeNull();
  });
});
