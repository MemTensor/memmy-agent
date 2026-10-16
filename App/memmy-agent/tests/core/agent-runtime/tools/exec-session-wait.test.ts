import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecSession, type SessionPoll } from "../../../../src/core/agent-runtime/tools/exec-session.js";

const children: any[] = [];

function childProcess() {
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => {
    child.signalCode = "SIGTERM";
    child.stdout.destroy();
    child.stderr.destroy();
    child.emit("exit", null, "SIGTERM");
    close(child);
    return true;
  });
  children.push(child);
  return child;
}

function close(child: any) {
  child.stdout.end();
  child.stderr.end();
  child.emit("close", child.exitCode, child.signalCode);
}

function exit(child: any, code = 0) {
  child.exitCode = code;
  child.emit("exit", code, null);
  close(child);
}

function sessionFor(child: any, timeoutS?: number) {
  return new ExecSession({ command: "controlled child", timeoutS, spawnProcess: (() => child) as any });
}

function observe(pending: Promise<SessionPoll>) {
  const state: { settled: boolean; poll?: SessionPoll; error?: Error } = { settled: false };
  void pending.then((poll) => { state.settled = true; state.poll = poll; }, (error) => { state.settled = true; state.error = error; });
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(async () => {
  for (const child of children.splice(0)) exit(child);
  await vi.runOnlyPendingTimersAsync();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("exec session waiting", () => {
  it("returns when a silent process completes instead of waiting 30 seconds", async () => {
    const child = childProcess();
    const state = observe(sessionFor(child).poll(30_000, 10_000));
    await vi.advanceTimersByTimeAsync(100);
    exit(child);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.poll).toMatchObject({ done: true, exitCode: 0, output: "", elapsedS: 0.1 });
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("wakes on signal exit with a null exit code", async () => {
    const child = childProcess();
    const state = observe(sessionFor(child).poll(30_000, 10_000));
    await vi.advanceTimersByTimeAsync(50);
    child.kill();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.poll).toMatchObject({ done: true, exitCode: null, elapsedS: 0.05 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns immediately if the process has already completed", async () => {
    const child = childProcess();
    const session = sessionFor(child);
    child.stdout.write("finished\n");
    exit(child);
    expect(await session.poll(30_000, 10_000)).toMatchObject({ done: true, output: "finished\n", elapsedS: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces stdout and stderr for one second from the first readable output", async () => {
    const child = childProcess();
    const session = sessionFor(child);
    const state = observe(session.poll(30_000, 10_000));
    await vi.advanceTimersByTimeAsync(100);
    child.stdout.write("first\n");
    await vi.advanceTimersByTimeAsync(500);
    child.stderr.write("second\n");
    await vi.advanceTimersByTimeAsync(499);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.poll).toMatchObject({ done: false, output: "first\nSTDERR:\nsecond\n", elapsedS: 1.1 });
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("close")).toBe(1);
    child.stdout.write("third\n");
    expect((await session.poll(0, 10_000)).output).toBe("third\n");
    expect((await session.poll(0, 10_000)).output).toBe("");
  });

  it("also coalesces output that was buffered before polling", async () => {
    const child = childProcess();
    const session = sessionFor(child);
    child.stdout.write("buffered\n");
    const state = observe(session.poll(30_000, 10_000));
    await vi.advanceTimersByTimeAsync(999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.poll).toMatchObject({ done: false, output: "buffered\n", elapsedS: 1 });
  });

  it("returns stderr-only output without waiting the full yield", async () => {
    const child = childProcess();
    const session = sessionFor(child);
    const state = observe(session.poll(30_000, 10_000));
    child.stderr.write("diagnostic\n");
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.poll).toMatchObject({ done: false, output: "STDERR:\ndiagnostic\n" });
  });

  it("does not restart an expired output window when a later poll begins", async () => {
    const child = childProcess();
    const session = sessionFor(child);
    child.stdout.write("ready-before-poll\n");
    await vi.advanceTimersByTimeAsync(1200);
    expect(await session.poll(30_000, 10_000)).toMatchObject({ done: false, output: "ready-before-poll\n", elapsedS: 1.2 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not restart the coalescing window for continuous small chunks", async () => {
    const child = childProcess();
    const state = observe(sessionFor(child).poll(30_000, 10_000));
    for (let i = 1; i <= 80; i++) {
      await vi.advanceTimersByTimeAsync(10);
      child.stdout.write(`chunk-${i}\n`);
      expect(state.settled).toBe(false);
    }
    await vi.advanceTimersByTimeAsync(209);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.poll?.output).toBe(Array.from({ length: 80 }, (_, i) => `chunk-${i + 1}\n`).join(""));
    expect(state.poll?.elapsedS).toBe(1.01);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("respects a shorter yield instead of extending it for coalescing", async () => {
    const child = childProcess();
    const state = observe(sessionFor(child).poll(200, 10_000));
    await vi.advanceTimersByTimeAsync(100);
    child.stdout.write("progress\n");
    await vi.advanceTimersByTimeAsync(100);
    expect(state.poll).toMatchObject({ done: false, output: "progress\n", elapsedS: 0.2 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns at the yield deadline when no output arrives", async () => {
    const state = observe(sessionFor(childProcess()).poll(1000, 10_000));
    await vi.advanceTimersByTimeAsync(999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.poll).toMatchObject({ done: false, output: "", elapsedS: 1 });
  });

  it("keeps zero-yield reads immediate and preserves the output limit", async () => {
    const child = childProcess();
    const session = sessionFor(child);
    child.stdout.write("a".repeat(2000));
    expect(await session.poll(0, 1000)).toMatchObject({ done: false, truncatedChars: 1000, elapsedS: 0 });
    expect((await session.poll(0, 1000)).output).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bypasses coalescing on completion and waits for the last stream bytes", async () => {
    const child = childProcess();
    const session = sessionFor(child);
    const state = observe(session.poll(30_000, 10_000));
    child.stdout.write("head|");
    await vi.advanceTimersByTimeAsync(100);
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    child.stdout.write("tail\n");
    child.stderr.write("final-error\n");
    close(child);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.poll).toMatchObject({ done: true, output: "head|tail\nSTDERR:\nfinal-error\n", elapsedS: 0.15 });
    expect((await session.poll(0, 10_000)).output).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels during coalescing and preserves unread output for a subsequent poll", async () => {
    const child = childProcess();
    const session = sessionFor(child);
    const controller = new AbortController();
    const state = observe(session.poll(30_000, 10_000, {}, controller.signal));
    child.stdout.write("keep-this\n");
    await vi.advanceTimersByTimeAsync(50);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.error?.name).toBe("AbortError");
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect((await session.poll(0, 10_000)).output).toBe("keep-this\n");
  });

  it("cancels while draining an exited process without consuming its final output", async () => {
    const child = childProcess();
    const session = sessionFor(child);
    const controller = new AbortController();
    child.exitCode = 0;
    child.emit("exit", 0, null);
    const state = observe(session.poll(30_000, 10_000, {}, controller.signal));
    await vi.advanceTimersByTimeAsync(50);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.error?.name).toBe("AbortError");
    expect(vi.getTimerCount()).toBe(0);
    child.stdout.write("late-tail\n");
    close(child);
    expect(await session.poll(0, 10_000)).toMatchObject({ done: true, output: "late-tail\n" });
  });

  it("rejects an already-cancelled poll without installing wait listeners", async () => {
    const child = childProcess();
    const controller = new AbortController();
    controller.abort();
    await expect(sessionFor(child).poll(30_000, 10_000, {}, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("honors the command timeout before a longer yield expires", async () => {
    const child = childProcess();
    const state = observe(sessionFor(child, 0.1).poll(30_000, 10_000));
    await vi.advanceTimersByTimeAsync(100);
    expect(state.poll).toMatchObject({ done: true, timedOut: true, elapsedS: 0.1 });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wakes when a spawn failure closes streams even without an exit code", async () => {
    const child = childProcess();
    const state = observe(sessionFor(child).poll(30_000, 10_000));
    child.emit("error", new Error("spawn failed"));
    close(child);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.poll).toMatchObject({ done: true, exitCode: null, output: "Error executing command: spawn failed" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles once when completion and the yield deadline coincide", async () => {
    const child = childProcess();
    const session = sessionFor(child);
    setTimeout(() => exit(child), 1000);
    const settled = vi.fn();
    const pending = session.poll(1000, 10_000).then((poll) => { settled(); return poll; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ done: true, exitCode: 0 });
    expect(settled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
