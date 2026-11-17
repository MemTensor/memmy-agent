import { describe, expect, it } from "vitest";
import { PanelBrowse } from "../../../src/service/panel/browse.js";

const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function fixture(heldPage = 2) {
  let safety = "safe";
  const reads: Array<{ signal?: AbortSignal; finish: (label: string) => void; fail: (error: Error) => void }> = [];
  const browse = new PanelBrowse({
    safety: () => safety, change: () => 0,
    read: async <T>(method: string, args: unknown[], signal?: AbortSignal) => {
      if (method === "members") return { safety, data: Array.from({ length: 40 }, (_, i) => `id-${i}`) as T };
      const page = (args[0] as string[])[0] === "id-0" ? 1 : 2;
      if (page !== heldPage) return { safety, data: { items: [] } as T };
      return new Promise<{ safety: string; data: T }>((resolve, reject) => reads.push({ signal,
        finish: label => resolve({ safety, data: { items: [{ id: label }] } as T }), fail: reject }));
    }
  });
  return { browse, reads, resetSafety: () => { safety = "reset"; } };
}

describe("shared panel page cancellation", () => {
  it("keeps a shared read alive when only one subscriber cancels", async () => {
    const { browse, reads } = fixture();
    const view = await browse.create({});
    const one = new AbortController();
    const first = browse.page(view.viewId, 2, {}, one.signal).catch(error => error);
    const second = browse.page(view.viewId, 2, {});
    await tick();
    expect(reads).toHaveLength(1);
    one.abort();
    expect((await first).name).toBe("AbortError");
    expect(reads[0]!.signal?.aborted).toBe(false);
    reads[0]!.finish("shared");
    expect((await second).items?.[0]?.id).toBe("shared");
    expect((await browse.page(view.viewId, 2, {})).items?.[0]?.id).toBe("shared");
    expect(reads).toHaveLength(1);
  });

  it.each([false, true])("ignores an old cancelled completion without removing its replacement (error: %s)", async (lateError) => {
    const { browse, reads } = fixture();
    const view = await browse.create({});
    const one = new AbortController(), two = new AbortController();
    const first = browse.page(view.viewId, 2, {}, one.signal).catch(error => error);
    const second = browse.page(view.viewId, 2, {}, two.signal).catch(error => error);
    await tick();
    one.abort(); two.abort();
    expect((await first).name).toBe("AbortError");
    expect((await second).name).toBe("AbortError");
    expect(reads[0]!.signal?.aborted).toBe(true);
    const replacement = browse.page(view.viewId, 2, {});
    await tick();
    if (lateError) reads[0]!.fail(new Error("Late cancelled failure"));
    else reads[0]!.finish("discard");
    await tick();
    const subscriber = browse.page(view.viewId, 2, {});
    await tick();
    expect(reads).toHaveLength(2);
    reads[1]!.finish("replacement");
    expect((await replacement).items?.[0]?.id).toBe("replacement");
    expect((await subscriber).items?.[0]?.id).toBe("replacement");
  });

  it("propagates cancellation into the first page of a new view", async () => {
    const { browse, reads } = fixture(1);
    const controller = new AbortController();
    const first = browse.create({}, controller.signal).catch(error => error);
    await tick();
    controller.abort();
    expect((await first).name).toBe("AbortError");
    expect(reads[0]!.signal?.aborted).toBe(true);
    reads[0]!.finish("discard");
    const next = browse.create({});
    await tick();
    reads[1]!.finish("fresh");
    expect((await next).items?.[0]?.id).toBe("fresh");
  });

  it("does not run an already cancelled request, including a cached page", async () => {
    const { browse, reads } = fixture();
    const view = await browse.create({});
    const controller = new AbortController(); controller.abort();
    await expect(browse.page(view.viewId, 1, {}, controller.signal)).rejects.toHaveProperty("name", "AbortError");
    await expect(browse.create({}, controller.signal)).rejects.toHaveProperty("name", "AbortError");
    expect(reads).toHaveLength(0);
  });

  it("releases a view and rejects its pending read even if the reader ignores abort", async () => {
    const { browse, reads } = fixture();
    const view = await browse.create({});
    const pending = browse.page(view.viewId, 2, {}).catch(error => error);
    await tick(); browse.release(view.viewId, {});
    expect((await pending).name).toBe("AbortError");
    expect(reads[0]!.signal?.aborted).toBe(true);
    reads[0]!.finish("discard"); await tick();
    await expect(browse.page(view.viewId, 1, {})).rejects.toThrow("expired");
  });

  it("preserves conflict errors when safety invalidates an in-flight view", async () => {
    const { browse, reads, resetSafety } = fixture();
    const view = await browse.create({});
    const pending = browse.page(view.viewId, 2, {}).catch(error => error);
    await tick(); resetSafety();
    expect(() => browse.check(view.viewId, {})).toThrow("expired");
    expect((await pending).code).toBe("conflict");
    reads[0]!.finish("discard"); await tick();
    await expect(browse.page(view.viewId, 1, {})).rejects.toThrow("expired");
  });
});
