import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpMemoryRuntimeClient, type MemoryRuntimeClient } from "../../../frontend/desktop/src/api/memory-runtime-client.js";
import { createHttpMemoryClient } from "../adapters/outbound/memory-client/http-memory-client.js";
import { MemoryLayerError } from "../adapters/outbound/memory-client/errors.js";

const page = {
  tasks: [], items: [], page: 1, pageSize: 20, total: 0, totalPages: 1,
  hasNext: false, hasPrev: false, serverTime: "2026-10-31T00:00:00Z"
};
type Read = (client: MemoryRuntimeClient, signal?: AbortSignal) => Promise<unknown>;
const reads: Array<{ name: string; read: Read; missing: string[] }> = [
  { name: "task detail", read: (client, signal) => client.listPanelTasks({ q: "task", page: 1 }, signal), missing: [] },
  { name: "items fallback", read: (client, signal) => client.listPanelItems({ layer: "L1", page: 1 }, signal), missing: ["browse"] },
  { name: "summary fallback", read: (client, signal) => client.listPanelTaskSummaries!({ page: 1 }, signal), missing: ["browse"] },
  { name: "legacy tasks fallback", read: (client, signal) => client.listPanelTaskSummaries!({ page: 1 }, signal), missing: ["browse", "task-summaries"] }
];
const errorResponse = (status: number) => Response.json({
  error: { code: status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not_found" : status === 409 ? "conflict" : "memory_layer_unavailable", message: "fixture failure", requestId: "fixture" }
}, { status });

// Compose the production clients; only transport and route dispatch are in-memory.
// Count Memory fetches separately from renderer requests and unsupported-route probes.
function setup(missing: string[], respond: typeof fetch) {
  vi.useFakeTimers();
  const memoryFetch = vi.fn(respond);
  const backend = createHttpMemoryClient({ baseUrl: "http://memory.invalid", token: "test", timeoutMs: 30_000, maxRetries: 3 }, { fetchImpl: memoryFetch });
  const probes: string[] = [];
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    if (missing.some(route => path === `/api/v1/panel/${route}`)) {
      probes.push(path);
      return Response.json({ message: `Route ${init?.method ?? "GET"}:${path} not found` }, { status: 404 });
    }
    requests.push(path);
    const context = { signal: init?.signal ?? undefined };
    try {
      const input = { page: 1, q: parsed.searchParams.get("q") ?? undefined };
      const result = path === "/api/v1/panel/tasks" ? await backend.panelTasks(input, context)
        : path === "/api/v1/panel/items" ? await backend.panelItems({ ...input, layer: "L1" }, context)
        : path === "/api/v1/panel/task-summaries" ? await backend.panelTaskSummaries(input, context)
        : path === "/api/v1/panel/browse" ? await backend.panelBrowse(JSON.parse(String(init?.body)), context)
        : path === "/api/v1/panel/logs" ? await backend.panelLogs(JSON.parse(String(init?.body)), context)
        : path === "/api/v1/panel/logs/1" ? await backend.panelLogDetail(1, context)
        : path === "/api/v1/panel/stats" ? await backend.panelStats(context)
        : path === "/api/v1/panel/overview-stats" ? await backend.panelOverviewStats(context)
        : path === "/api/v1/panel/memory/test" ? await backend.panelMemory!("test", context)
        : path.startsWith("/api/v1/memory/") ? await backend.getMemory({ memoryId: "test" }, context)
        : undefined;
      if (!result) throw new Error(`Unexpected route: ${path}`);
      return Response.json(result);
    } catch (error) {
      if (init?.signal?.aborted) throw init.signal.reason;
      if (!(error instanceof MemoryLayerError)) throw error;
      return Response.json({ error: { code: error.code, message: error.message, requestId: "fixture" } }, { status: error.status });
    }
  }));
  return { client: createHttpMemoryRuntimeClient({ baseUrl: "http://backend.invalid", localToken: "test" }), memoryFetch, requests, probes };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe.each(reads)("single retry owner: $name", ({ read, missing }) => {
  it("bounds persistent 503 to four total Memory requests", async () => {
    const env = setup(missing, async () => errorResponse(503));
    const result = read(env.client).catch(error => error);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toMatchObject({ status: 503 });
    expect(env.requests).toHaveLength(4);
    expect(env.memoryFetch).toHaveBeenCalledTimes(4);
    expect(env.probes).toHaveLength(missing.length);
  });

  it("recovers one transient failure through the frontend retry", async () => {
    let calls = 0;
    const env = setup(missing, async () => ++calls === 1 ? errorResponse(503) : Response.json(page));
    const result = read(env.client);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toMatchObject({ page: 1, total: 0 });
    expect(env.requests).toHaveLength(2);
    expect(env.memoryFetch).toHaveBeenCalledTimes(2);
    expect(env.probes).toHaveLength(missing.length);
  });

  it.each([401, 403, 404, 409])("does not retry or fall back on %i", async status => {
    const env = setup(missing, async () => errorResponse(status));
    const result = read(env.client).catch(error => error);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toMatchObject({ status });
    expect(env.requests).toHaveLength(1);
    expect(env.memoryFetch).toHaveBeenCalledTimes(1);
    expect(env.probes).toHaveLength(missing.length);
  });

  it("stops retrying when the caller leaves during backoff", async () => {
    const env = setup(missing, async () => errorResponse(503));
    const controller = new AbortController();
    const result = read(env.client, controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await result).toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(env.memoryFetch).toHaveBeenCalledTimes(1);
    expect(env.requests).toHaveLength(1);
  });

  it("keeps another shared subscriber alive when one caller leaves", async () => {
    let calls = 0;
    const env = setup(missing, async () => ++calls === 1 ? errorResponse(503) : Response.json(page));
    const controller = new AbortController();
    const first = read(env.client, controller.signal).catch(error => error);
    const second = read(env.client);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await first).toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await second).toMatchObject({ total: 0 });
    expect(env.memoryFetch).toHaveBeenCalledTimes(2);
    expect(env.requests).toHaveLength(2);
  });
});

// Audit the other shared-queue consumers as well, so the fix cannot silently
// leave a second retry owner on a sibling endpoint.
it.each<[string, Read]>([
  ["browse items", client => client.listPanelItems({ layer: "L1", page: 1 })],
  ["browse task summaries", client => client.listPanelTaskSummaries!({ page: 1 })],
  ["memory detail", client => client.getPanelMemory!("test")],
  ["logs", client => client.listPanelLogs!({ limit: 20 })],
  ["log detail", client => client.getPanelLogDetail!(1)],
  ["statistics", client => client.getPanelStats!()],
  ["overview statistics", client => client.getPanelOverviewStats!()]
])("bounds the existing %s queue consumer to four Memory requests", async (_name, read) => {
  const env = setup([], async () => errorResponse(503));
  const result = read(env.client).catch(error => error);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await result).toMatchObject({ status: 503 });
  expect(env.memoryFetch).toHaveBeenCalledTimes(4);
  expect(env.requests).toHaveLength(4);
});

it("propagates cancellation to Memory and releases a slot for queued work", async () => {
  const signals: AbortSignal[] = [];
  const env = setup([], async (_url, init) => {
    const signal = init!.signal!;
    signals.push(signal);
    if (signals.length > 2) return Response.json(page);
    return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const firstController = new AbortController(), secondController = new AbortController();
  const first = env.client.listPanelTasks({ q: "a" }, firstController.signal).catch(error => error);
  const second = env.client.listPanelTasks({ q: "b" }, secondController.signal).catch(error => error);
  const queued = env.client.listPanelTasks({ q: "c" });
  await vi.advanceTimersByTimeAsync(0);
  expect(signals).toHaveLength(2);
  firstController.abort();
  expect(await first).toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(0);
  expect(await queued).toMatchObject({ total: 0 });
  expect(signals[0].aborted).toBe(true);
  expect(signals[1].aborted).toBe(false);
  secondController.abort();
  expect(await second).toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(env.memoryFetch).toHaveBeenCalledTimes(3);
});

it("does not deliver a late cancelled response to a new same-key subscriber", async () => {
  let release!: (response: Response) => void;
  let calls = 0;
  const env = setup([], async () => ++calls === 1
    ? new Promise<Response>(resolve => { release = resolve; })
    : Response.json({ ...page, serverTime: "2026-10-31T00:01:00Z" }));
  const controller = new AbortController();
  const old = env.client.listPanelTasks({ q: "same" }, controller.signal).catch(error => error);
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  expect(await old).toMatchObject({ name: "AbortError" });
  const fresh = env.client.listPanelTasks({ q: "same" });
  await vi.advanceTimersByTimeAsync(0);
  expect(await fresh).toMatchObject({ serverTime: "2026-10-31T00:01:00Z" });
  release(Response.json(page));
  await vi.advanceTimersByTimeAsync(20_000);
  expect(env.memoryFetch).toHaveBeenCalledTimes(2);
  expect(await fresh).toMatchObject({ serverTime: "2026-10-31T00:01:00Z" });
});

it("preserves backend-only retries for the unsupported panel-memory fallback", async () => {
  const env = setup(["memory/test"], async () => errorResponse(503));
  const result = env.client.getPanelMemory!("test").catch(error => error);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await result).toMatchObject({ status: 503 });
  expect(env.probes).toHaveLength(1);
  expect(env.requests).toEqual(["/api/v1/memory/test"]);
  expect(env.memoryFetch).toHaveBeenCalledTimes(4);
});
