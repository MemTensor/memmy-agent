import { describe, expect, it, vi } from "vitest";
import type { PanelBrowseInput, PanelBrowseOutput, PanelBrowsePage } from "@memmy/local-api-contracts";
import { PanelBrowseClient } from "../panel-browse-client.js";
const at = "2026-10-27T00:00:00.000Z";
function page(viewId: string, n = 1): PanelBrowsePage {
  return {
    viewId,
    instanceId: "instance",
    safety: "safe",
    createdAt: at,
    serverTime: at,
    page: n,
    pageSize: 20,
    total: 40,
    totalPages: 2,
    hasNext: n < 2,
    hasPrev: n > 1,
    items: []
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function api(create: (input: PanelBrowseInput) => Promise<PanelBrowseOutput>) {
  return vi.fn(async (input: PanelBrowseInput): Promise<PanelBrowseOutput> => {
    if (input.op === "create") return create(input);
    if (input.op === "release") return { ok: true };
    if (input.op === "page") return page(input.viewId!, input.page);
    return { viewId: input.viewId!, instanceId: "instance", safety: "safe", updated: false, serverTime: at };
  });
}
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
describe("panel browse lifecycle", () => {
  it("discards a late different-filter create and releases only that obsolete view", async () => {
    const old = deferred<PanelBrowseOutput>();
    const request = api(async (input) => (input.filter?.q === "old" ? old.promise : page("new")));
    const client = new PanelBrowseClient(request, () => false);
    const first = client.list("L1", { layer: "L1", q: "old" }).catch((error) => error);
    await tick();
    expect((await client.list("L1", { layer: "L1", q: "new" }))?.viewId).toBe("new");
    old.resolve(page("old"));
    await tick();
    expect((await first).name).toBe("AbortError");
    expect((await client.list("L1", { layer: "L1", q: "new", page: 2 }))?.viewId).toBe("new");
    expect(request.mock.calls.filter(([input]) => input.op === "release").map(([input]) => input.viewId)).toEqual([
      "old"
    ]);
  });
  it("shares creation and keeps it alive when one caller cancels", async () => {
    const created = deferred<PanelBrowseOutput>();
    const request = api(() => created.promise);
    const client = new PanelBrowseClient(request, () => false);
    const controller = new AbortController();
    const first = client.list("L1", {}, controller.signal).catch((error) => error);
    const second = client.list("L1", {});
    await tick();
    controller.abort();
    created.resolve(page("shared"));
    expect((await first).name).toBe("AbortError");
    expect((await second)?.viewId).toBe("shared");
    expect(request.mock.calls.filter(([input]) => input.op === "create")).toHaveLength(1);
    expect(request.mock.calls.some(([input]) => input.op === "release")).toBe(false);
  });
  it("retains a valid old view after failed refresh and swaps only after successful replacement", async () => {
    let fails = false;
    let id = "original";
    const request = api(async () => {
      if (fails) throw new Error("network");
      return page(id);
    });
    const client = new PanelBrowseClient(request, () => false);
    await client.list("L1", {});
    fails = true;
    client.refresh("L1");
    await expect(client.list("L1", { page: 2 })).rejects.toThrow("network");
    expect(await client.check("L1")).toHaveProperty("viewId", "original");
    expect(request.mock.calls.some(([input]) => input.op === "release")).toBe(false);
    fails = false;
    id = "replacement";
    expect(await client.list("L1", { page: 2 })).toMatchObject({ viewId: id, page: 1 });
    expect(request.mock.calls.some(([input]) => input.op === "release" && input.viewId === "original")).toBe(true);
  });
  it("evicts cached pages across sections under an aggregate budget", async () => {
    let id = 0;
    const request = api(async () => page(String(++id)));
    const client = new PanelBrowseClient(request, () => false, JSON.stringify(page("1")).length * 2 + 10);
    await client.list("L1", { layer: "L1" });
    await client.list("L2", { layer: "L2" });
    await client.list("L1", { layer: "L1" });
    expect(request.mock.calls.some(([input]) => input.op === "page" && input.viewId === "1")).toBe(true);
  });
  it("does not treat authentication or network errors as missing capability", async () => {
    const request = api(async () => {
      throw new Error("unauthorized");
    });
    const client = new PanelBrowseClient(
      request,
      (error) => error instanceof Error && error.message === "missing route"
    );
    await expect(client.list("L1", {})).rejects.toThrow("unauthorized");
    await expect(client.list("L1", {})).rejects.toThrow("unauthorized");
    expect(request.mock.calls).toHaveLength(2);
  });
});
