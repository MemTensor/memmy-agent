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
    postMessage(message: { id: number; method: string; stop?:boolean }) { if(message.stop) {this.finishTermination=()=>this.emit("exit",0);return;} this.messages.push(message); }
    terminate() { return new Promise<number>((resolve) => { this.finishTermination = () => resolve(0); }); }
  }
}));
import { PanelReader } from "../../../src/service/panel/reader.js";

const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
afterEach(() => { workers.instances.length = 0; });

describe("foreground reads during background statistics", () => {
  it("terminates a cancelled active read before starting queued work and ignores its late reply", async () => {
    const reader = new PanelReader("synthetic.sqlite");
    const controller = new AbortController();
    const cancelled = reader.run("page", [[], {}], 0, controller.signal).catch(error => error);
    const old = workers.instances[0]!;
    const nextRead = reader.run("members", [{}]);
    controller.abort();
    expect((await cancelled).name).toBe("AbortError");
    old.emit("message", { id: old.messages[0]!.id, result: { safety: "old", data: "discard" } });
    await tick();
    expect(workers.instances).toHaveLength(1);
    old.finishTermination(); await tick();
    const next = workers.instances[1]!;
    expect(next.messages.map(item => item.method)).toEqual(["members"]);
    next.emit("message", { id: next.messages[0]!.id, result: { safety: "new", data: ["visible"] } });
    await expect(nextRead).resolves.toEqual({ safety: "new", data: ["visible"] });
    const stop = reader.stop(); next.finishTermination(); await stop;
  });

  it.each(["stats", "overviewStats"])("waits for %s to yield, serves the page, and retries the unpublished result", async (method) => {
    const reader = new PanelReader("synthetic.sqlite");
    const statsDone = vi.fn();
    const stats = reader.run(method, [{}], 1).then(statsDone);
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
    expect(next.messages.map(item => item.method)).toEqual(["members", method]);
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

it("resumes committed statistics while a background model remains busy",async()=>{
  vi.useFakeTimers();
  let busy=true;
  const reader=new PanelReader("synthetic.sqlite",1000,()=>busy);
  const stats=reader.run("stats",[{}],1);
  const worker=workers.instances[0]!,id=worker.messages[0]!.id;
  try{
    worker.emit("message",{id,yield:true});
    await vi.advanceTimersByTimeAsync(25);
    expect(busy).toBe(true);
    expect(worker.messages[1]).toEqual({resume:id});
    worker.emit("message",{id,result:{safety:"safe",data:"finished"}});
    await expect(stats).resolves.toEqual({safety:"safe",data:"finished"});
    expect(workers.instances).toHaveLength(1);
  }finally{const stop=reader.stop();worker.finishTermination();await stop;vi.useRealTimers();}
});


it("counts write admission and queued time in the total deadline", async () => {
  vi.useFakeTimers();
  const reader = new PanelReader("synthetic.sqlite",100);
  const first = reader.run("items",[{}]).catch(error=>error);
  const second = reader.run("items",[{}]).catch(error=>error);
  const worker=workers.instances[0]!;
  try {
    await vi.advanceTimersByTimeAsync(100);
    expect((await first).message).toContain("time budget");
    expect((await second).message).toContain("time budget");
    expect(worker.messages).toHaveLength(1);
  } finally { const stopped=reader.stop();worker.finishTermination();await stopped;vi.useRealTimers(); }
});
