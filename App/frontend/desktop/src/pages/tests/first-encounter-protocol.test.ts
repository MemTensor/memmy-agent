import type { OnboardingInsightDiagnostics, OnboardingInsightReportStreamEvent } from "@memmy/local-api-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamFirstEncounterReport } from "../first-encounter-protocol.js";

vi.mock("../../api/runtime-config.js", () => ({
  getRuntimeConfig: vi.fn(async () => ({
    baseUrl: "http://127.0.0.1:18100",
    localToken: "test-local-token"
  }))
}));

const request = { agents: [], nickname: "", language: "zh-CN" as const };
const diagnostics: OnboardingInsightDiagnostics = {
  discoveredAgentCount: 1,
  sampledQueryCount: 2,
  usedLlm: true,
  elapsedMs: 3_000,
  reportLanguage: "zh-CN",
  agents: [{
    sourceId: "codex",
    displayName: "Codex",
    recentSessionCount: 2,
    queryCount: 2,
    latestActivityAt: null
  }]
};

function frame(event: OnboardingInsightReportStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function handlers() {
  return { onAgents: vi.fn(), onChunk: vi.fn(), onDone: vi.fn() };
}

describe("first encounter report stream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("ends a response that sends headers and sampled data but never finishes", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame({ type: "sampled", diagnostics })));
      },
      cancel
    });
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Response(body);
    }));
    const callbacks = handlers();
    let settled = false;
    const result = streamFirstEncounterReport(request, callbacks).then(
      () => { settled = true; return null; },
      (error: unknown) => { settled = true; return error; }
    );

    await vi.advanceTimersByTimeAsync(99_999);
    expect(callbacks.onAgents).toHaveBeenCalledWith([{ sourceId: "codex", name: "Codex", conversations: 2 }]);
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await result).toMatchObject({ name: "TimeoutError", message: "first encounter report timed out" });
    expect(signal?.aborted).toBe(true);
    expect(callbacks.onDone).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("bounds fetch even if the transport does not respond to the abort signal", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    }));
    const callbacks = handlers();
    const result = streamFirstEncounterReport(request, callbacks).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(100_000);

    expect(await result).toMatchObject({ name: "TimeoutError" });
    expect(signal?.aborted).toBe(true);
    expect(callbacks.onDone).not.toHaveBeenCalled();
  });

  it("delivers a normal fragmented stream and stops at done while the body stays open", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const done: OnboardingInsightReportStreamEvent = {
      type: "done",
      response: { status: "ready", reportMarkdown: "嗨，我是 Memmy。", diagnostics }
    };
    const data = frame({ type: "sampled", diagnostics })
      + frame({ type: "chunk", delta: "嗨，我是 Memmy。" })
      + frame(done)
      + frame({ type: "chunk", delta: "must not appear after done" })
      + frame(done);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(data.slice(0, 30)));
        controller.enqueue(encoder.encode(data.slice(30)));
      },
      cancel
    });
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Response(body);
    }));
    const callbacks = handlers();

    await streamFirstEncounterReport(request, callbacks);

    expect(callbacks.onChunk).toHaveBeenCalledOnce();
    expect(callbacks.onChunk).toHaveBeenCalledWith("嗨，我是 Memmy。", expect.objectContaining({ body: "嗨，我是 Memmy。" }));
    expect(callbacks.onDone).toHaveBeenCalledOnce();
    expect(callbacks.onDone).toHaveBeenCalledWith(expect.objectContaining({ body: "嗨，我是 Memmy。", emptyHistory: false }), { streamed: true });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(signal?.aborted).toBe(false);
  });

  it("reports an early EOF without waiting for the deadline", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));

    await expect(streamFirstEncounterReport(request, handlers())).rejects.toThrow("first encounter report stream ended before done");
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
