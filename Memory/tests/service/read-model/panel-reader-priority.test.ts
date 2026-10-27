import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const workers = vi.hoisted(() => ({ instances: [] as Array<{
  messages: Array<{ id: number; method: string }>;
  emit: (event: string, payload: unknown) => boolean;
  finishTermination: () => void;
}> }));
vi.mock("node:worker_threads", () => ({
  Worker: class extends EventEmitter {
    messages: Array<{ id: number; method: string }> = [];
    finishTermination = () => {};
    constructor() { super(); workers.instances.push(this); }
    ref() {}
    unref() {}
    postMessage(message: { id: number; method: string }) { this.messages.push(message); }
    terminate() { return new Promise<number>((resolve) => { this.finishTermination = () => resolve(0); }); }
  }
}));
import { PanelReader } from "../../../src/service/panel/reader.js";

const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
afterEach(() => { workers.instances.length = 0; });

describe("foreground reads during background statistics", () => {
  it("waits for the old worker to terminate, serves the page, then retries unpublished statistics", async () => {
    const reader = new PanelReader("synthetic.sqlite");
    const statsDone = vi.fn();
    const stats = reader.run("stats", [{}], 1).then(statsDone);
    const old = workers.instances[0]!;
    const oldStats = old.messages[0]!;
    const page = reader.run("members", [{}]);
    expect(workers.instances).toHaveLength(1);
    old.emit("message", { id: oldStats.id, result: { safety: "old", data: "discard" } });
    await tick();
    expect(statsDone).not.toHaveBeenCalled();
    old.finishTermination();
    await tick();
    const next = workers.instances[1]!;
    expect(next.messages.map(item => item.method)).toEqual(["members"]);
    next.emit("message", { id: next.messages[0]!.id, result: { safety: "new", data: ["visible"] } });
    await expect(page).resolves.toEqual({ safety: "new", data: ["visible"] });
    expect(next.messages.map(item => item.method)).toEqual(["members", "stats"]);
    next.emit("message", { id: next.messages[1]!.id, result: { safety: "new", data: "complete" } });
    await stats;
    expect(statsDone).toHaveBeenCalledExactlyOnceWith({ safety: "new", data: "complete" });
    const stop = reader.stop(); next.finishTermination(); await stop;
  });

  it("cancels statistics while yielded without reviving them or cancelling the page", async () => {
    const reader = new PanelReader("synthetic.sqlite");
    const controller = new AbortController();
    const stats = reader.run("stats", [{}], 1, controller.signal).catch(error => error);
    const old = workers.instances[0]!;
    const page = reader.run("items", [{}]);
    controller.abort();
    expect((await stats).name).toBe("AbortError");
    old.finishTermination(); await tick();
    const next = workers.instances[1]!;
    next.emit("message", { id: next.messages[0]!.id, result: { safety: "new", data: [] } });
    await page;
    expect(next.messages.map(item => item.method)).toEqual(["items"]);
    const stop = reader.stop(); next.finishTermination(); await stop;
  });

  it("rejects queued work on stop while a background worker is terminating", async () => {
    const reader = new PanelReader("synthetic.sqlite");
    const stats = reader.run("stats", [{}], 1).catch(error => error);
    const old = workers.instances[0]!;
    const page = reader.run("items", [{}]).catch(error => error);
    const stop = reader.stop();
    old.finishTermination(); await stop;
    expect((await stats).message).toContain("stopped");
    expect((await page).message).toContain("stopped");
    expect(workers.instances).toHaveLength(1);
  });
});
