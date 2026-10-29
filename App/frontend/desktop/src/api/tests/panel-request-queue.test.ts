import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelRequestQueue } from "../panel-request-queue.js";

import { ApiRequestError } from "../http.js";
afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("panel request queue", () => {
  it.each([false, true])("allows immediate same-key reentry after settlement (failed: %s)", async (failed) => {
    const queue = new PanelRequestQueue(1);
    const first = queue.request("same", async () => { if (failed) throw new Error("first failure"); return "first"; });
    if (failed) {
      try { await first; throw new Error("unexpected success"); }
      catch (error) { expect((error as Error).message).toBe("first failure"); }
    } else expect(await first).toBe("first");
    expect(queue.idle).toBe(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(await Promise.race([queue.request("same", async () => "second"),
        new Promise(resolve => { timer = setTimeout(() => resolve("TIMEOUT"), 150); })])).toBe("second");
      expect(queue.idle).toBe(true);
    } finally { clearTimeout(timer); }
  });

  it("lets both completed subscribers immediately request their next shared key", async () => {
    const queue = new PanelRequestQueue(1);
    const source = deferred<string>();
    const next = vi.fn(async () => "next");
    const a = queue.request("same", () => source.promise).then(() => queue.request("same", next));
    const b = queue.request("same", () => source.promise).then(() => queue.request("same", next));
    source.resolve("first");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(await Promise.race([Promise.all([a,b]), new Promise(resolve => { timer=setTimeout(()=>resolve("TIMEOUT"),150); })])).toEqual(["next","next"]);
      expect(next).toHaveBeenCalledTimes(1);
      expect(queue.idle).toBe(true);
    } finally { clearTimeout(timer); }
  });

  it("shares a request and preserves the remaining subscriber when another leaves", async () => {
    const queue = new PanelRequestQueue(1);
    const source = deferred<string>();
    const run = vi.fn((_signal: AbortSignal) => source.promise);
    const a = new AbortController();
    const first = queue.request("page", run, a.signal).catch((error) => error.name);
    const second = queue.request("page", run);
    await Promise.resolve();
    a.abort();
    expect(run.mock.calls[0]?.[0].aborted).toBe(false);
    source.resolve("data");
    expect(await first).toBe("AbortError");
    expect(await second).toBe("data");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("limits different keys and removes an obsolete queued search without running it", async () => {
    const queue = new PanelRequestQueue(1);
    const source = deferred<string>();
    const first = queue.request("a", () => source.promise);
    const abort = new AbortController();
    const obsolete = vi.fn(async () => "obsolete");
    const old = queue.request("old", obsolete, abort.signal).catch((error) => error.name);
    const nextRun = vi.fn(async () => "next");
    const next = queue.request("new", nextRun);
    abort.abort();
    expect(await old).toBe("AbortError");
    expect(nextRun).not.toHaveBeenCalled();
    source.resolve("a");
    expect(await first).toBe("a");
    expect(await next).toBe("next");
    expect(obsolete).not.toHaveBeenCalled();
  });

  it("aborts the transport only after its last subscriber leaves and can retry", async () => {
    const queue = new PanelRequestQueue(1);
    const abort = new AbortController();
    let transport: AbortSignal | undefined;
    const first = queue
      .request(
        "a",
        (signal) =>
          new Promise<string>((_resolve, reject) => {
            transport = signal;
            signal.addEventListener("abort", () => reject(new Error("cancelled")));
          }),
        abort.signal
      )
      .catch((error) => error.name);
    await Promise.resolve();
    abort.abort();
    expect(transport?.aborted).toBe(true);
    expect(await first).toBe("AbortError");
    expect(await queue.request("a", async () => "retry")).toBe("retry");
  });
  it("does not share a cancelled scope's in-flight result with the next scope", async () => {
    const queue = new PanelRequestQueue(2);
    let finish!: (value: string) => void;
    const old = queue.request("same", () => new Promise<string>(resolve => { finish = resolve; })).catch(error => error);
    await Promise.resolve();
    queue.clear();
    const fresh = queue.request("same", async () => "new account");
    finish("old account");
    expect((await old).name).toBe("AbortError");
    expect(await fresh).toBe("new account");
  });

});

describe("transient panel transport recovery", () => {
  it("shares one recovery for all subscribers, including before any view exists", async () => {
    vi.useFakeTimers();
    const queue = new PanelRequestQueue(2, true);
    const run = vi.fn().mockRejectedValueOnce(new ApiRequestError("starting",503)).mockRejectedValueOnce(new TypeError("network unavailable")).mockResolvedValue("ready");
    const a = queue.request("create",run), b = queue.request("create",run);
    await vi.advanceTimersByTimeAsync(249); expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(750);
    expect(await Promise.all([a,b])).toEqual(["ready","ready"]);
    expect(run).toHaveBeenCalledTimes(3); expect(queue.idle).toBe(true);
  });
  it.each([401,403,404,409,500])("never retries invalidation or permanent status %s", async status => {
    const queue=new PanelRequestQueue(2,true), error=new ApiRequestError("failed",status);
    const run=vi.fn().mockRejectedValue(error);
    await expect(queue.request("read",run)).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("bounds retries and cancels backoff when its last subscriber leaves", async()=>{
    vi.useFakeTimers();
    const queue=new PanelRequestQueue(2,true), run=vi.fn().mockRejectedValue(new ApiRequestError("busy",503));
    const result=queue.request("read",run).catch(e=>e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await result).status).toBe(503);expect(run).toHaveBeenCalledTimes(4);
    const controller=new AbortController();
    const cancelled=queue.request("next",run,controller.signal).catch(e=>e);
    await vi.advanceTimersByTimeAsync(0);controller.abort();
    expect((await cancelled).name).toBe("AbortError");
    await vi.advanceTimersByTimeAsync(10_000);expect(run).toHaveBeenCalledTimes(5);
  });
});
