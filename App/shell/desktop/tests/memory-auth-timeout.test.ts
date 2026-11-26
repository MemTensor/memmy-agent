import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { probeMemoryAuthentication } from "../src/main/memory-auth.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("authenticates when both local HTTP responses take longer than one second", async () => {
  const statuses: number[] = [];
  const server = createServer((req, res) => {
    const status = req.headers.authorization === "Bearer valid" ? 200 : 401;
    statuses.push(status);
    setTimeout(() => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ authenticated: true, authVersion: 1 }));
    }, 1200);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a test port");
    expect(await probeMemoryAuthentication(`http://127.0.0.1:${address.port}`, "valid")).toBe("authenticated");
    expect(statuses).toEqual([401, 200]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 10_000);

it.each([
  { phase: "anonymous", betweenRequestsMs: 0, expectedMs: 2500 },
  { phase: "authorized", betweenRequestsMs: 0, expectedMs: 4800 },
  { phase: "whole probe", betweenRequestsMs: 500, expectedMs: 5000 }
])("bounds the $phase wait", async ({ phase, betweenRequestsMs, expectedMs }) => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
    return controller.signal;
  });
  const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    if (phase !== "anonymous" && !Object.hasOwn(init.headers!, "authorization")) {
      setTimeout(() => resolve(new Response(new ReadableStream({
        cancel: () => betweenRequestsMs ? new Promise<void>(done => setTimeout(done, betweenRequestsMs)) : undefined
      }), { status: 401 })), 2300);
    }
  }));
  vi.stubGlobal("fetch", fetch);
  const result = vi.fn();
  const probe = probeMemoryAuthentication("http://127.0.0.1", "valid").catch(result);
  await vi.advanceTimersByTimeAsync(expectedMs - 1);
  expect(result).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await probe;
  expect(result).toHaveBeenCalledWith(expect.objectContaining({ name: "TimeoutError" }));
  expect(fetch).toHaveBeenCalledTimes(phase === "anonymous" ? 1 : 2);
});
