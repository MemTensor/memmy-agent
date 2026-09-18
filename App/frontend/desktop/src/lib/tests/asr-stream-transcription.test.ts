import { describe, expect, it, vi } from "vitest";
import { createStreamLiveTranscriber, type StreamSocket } from "../asr-stream-transcription.js";
import type { AsrLiveLine } from "../asr-live-transcription.js";

const SAMPLE_RATE = 16_000;

/** A scriptable stand-in for the browser WebSocket. */
class FakeSocket implements StreamSocket {
  readyState = 0;
  binaryType = "blob";
  readonly sent: Array<string | ArrayBuffer> = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = 3;
    this.emit("close", { code: code ?? 1000, reason: reason ?? "" });
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener as (event: unknown) => void);
    this.listeners.set(type, list);
  }

  /** Simulates the relay accepting the connection. */
  open(): void {
    this.readyState = 1;
    this.emit("open", undefined);
  }

  /** Delivers a relay event as the browser would: a text frame. */
  receive(event: unknown): void {
    this.emit("message", { data: JSON.stringify(event) });
  }

  /** Simulates the relay dropping the socket without a `finished`. */
  drop(): void {
    this.readyState = 3;
    this.emit("close", { code: 1006, reason: "" });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  textFrames(): unknown[] {
    return this.sent.filter((frame): frame is string => typeof frame === "string").map((frame) => JSON.parse(frame));
  }

  binaryFrames(): ArrayBuffer[] {
    return this.sent.filter((frame): frame is ArrayBuffer => frame instanceof ArrayBuffer);
  }
}

function block(samples: number, amplitude = 8_000): Int16Array {
  return new Int16Array(samples).fill(amplitude);
}

describe("createStreamLiveTranscriber", () => {
  it("connects on the first block, announces the sample rate, then streams audio", () => {
    const socket = new FakeSocket();
    const transcriber = createStreamLiveTranscriber(() => socket, { sampleRate: SAMPLE_RATE, onLine: () => undefined });

    transcriber.push(block(1_600));
    expect(socket.sent).toHaveLength(0);

    socket.open();
    // The start frame goes first so the recognizer knows the format before
    // any audio arrives; the block pushed before `open` follows it.
    expect(socket.textFrames()).toEqual([{ type: "start", sampleRate: SAMPLE_RATE }]);
    expect(socket.binaryFrames()).toHaveLength(1);
    expect(socket.binaryFrames()[0]?.byteLength).toBe(1_600 * 2);

    transcriber.push(block(800));
    expect(socket.binaryFrames()).toHaveLength(2);
  });

  it("reports partial and final sentences under the same offset so the line is replaced in place", () => {
    const socket = new FakeSocket();
    const lines: AsrLiveLine[] = [];
    const transcriber = createStreamLiveTranscriber(() => socket, { sampleRate: SAMPLE_RATE, onLine: (line) => lines.push(line) });
    transcriber.push(block(160));
    socket.open();

    socket.receive({ type: "partial", sentenceId: 1, text: "公司目前", beginMs: 0 });
    socket.receive({ type: "partial", sentenceId: 1, text: "公司目前有多少", beginMs: 0 });
    socket.receive({ type: "sentence", sentenceId: 1, text: "公司目前有多少名员工", beginMs: 0, endMs: 2_400 });

    expect(lines.map((line) => line.text)).toEqual(["公司目前", "公司目前有多少", "公司目前有多少名员工"]);
    // Every reading of one sentence carries the same start, which is what the
    // panel keys on to overwrite rather than append.
    expect(new Set(lines.map((line) => line.startMs))).toEqual(new Set([0]));
    expect(lines.at(-1)?.endMs).toBe(2_400);
  });

  it("drops blank readings rather than showing empty lines", () => {
    const socket = new FakeSocket();
    const lines: AsrLiveLine[] = [];
    const transcriber = createStreamLiveTranscriber(() => socket, { sampleRate: SAMPLE_RATE, onLine: (line) => lines.push(line) });
    transcriber.push(block(160));
    socket.open();

    socket.receive({ type: "partial", sentenceId: 1, text: "", beginMs: 0 });
    socket.receive({ type: "partial", sentenceId: 1, text: "   ", beginMs: 0 });

    expect(lines).toEqual([]);
  });

  it("sends finish and settles once the relay reports finished", async () => {
    const socket = new FakeSocket();
    const transcriber = createStreamLiveTranscriber(() => socket, { sampleRate: SAMPLE_RATE, onLine: () => undefined });
    transcriber.push(block(160));
    socket.open();

    const finishing = transcriber.finish();
    expect(socket.textFrames().at(-1)).toEqual({ type: "finish" });

    socket.receive({ type: "finished" });
    await expect(finishing).resolves.toBeUndefined();
    expect(socket.closes.at(-1)).toEqual({ code: 1000, reason: "done" });
  });

  it("holds finish until the socket opens, so the tail of a short recording is not lost", async () => {
    const socket = new FakeSocket();
    const transcriber = createStreamLiveTranscriber(() => socket, { sampleRate: SAMPLE_RATE, onLine: () => undefined });
    transcriber.push(block(160));

    const finishing = transcriber.finish();
    expect(socket.sent).toHaveLength(0);

    socket.open();
    expect(socket.textFrames()).toEqual([{ type: "start", sampleRate: SAMPLE_RATE }, { type: "finish" }]);
    socket.receive({ type: "finished" });
    await expect(finishing).resolves.toBeUndefined();
  });

  it("settles immediately when nothing was ever pushed", async () => {
    const openSocket = vi.fn(() => new FakeSocket());
    const transcriber = createStreamLiveTranscriber(openSocket, { sampleRate: SAMPLE_RATE, onLine: () => undefined });

    await expect(transcriber.finish()).resolves.toBeUndefined();
    expect(openSocket).not.toHaveBeenCalled();
  });

  it("reports an error and settles when the relay drops the socket mid-recording", async () => {
    const socket = new FakeSocket();
    const onError = vi.fn();
    const transcriber = createStreamLiveTranscriber(() => socket, { sampleRate: SAMPLE_RATE, onLine: () => undefined, onError });
    transcriber.push(block(160));
    socket.open();

    const finishing = transcriber.finish();
    socket.drop();

    await expect(finishing).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("surfaces a relay error event and settles", async () => {
    const socket = new FakeSocket();
    const onError = vi.fn();
    const transcriber = createStreamLiveTranscriber(() => socket, { sampleRate: SAMPLE_RATE, onLine: () => undefined, onError });
    transcriber.push(block(160));
    socket.open();

    const finishing = transcriber.finish();
    socket.receive({ type: "error", message: "Live transcription requires account mode" });

    await expect(finishing).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Live transcription requires account mode" }));
  });

  it("stops reporting and closes the socket once cancelled", () => {
    const socket = new FakeSocket();
    const lines: AsrLiveLine[] = [];
    const onError = vi.fn();
    const transcriber = createStreamLiveTranscriber(() => socket, { sampleRate: SAMPLE_RATE, onLine: (line) => lines.push(line), onError });
    transcriber.push(block(160));
    socket.open();

    transcriber.cancel();
    socket.receive({ type: "sentence", sentenceId: 1, text: "迟到的一句", beginMs: 0 });
    transcriber.push(block(160));

    expect(lines).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
    expect(socket.closes.at(-1)).toEqual({ code: 1000, reason: "cancelled" });
    // Only the pre-cancel block reached the socket.
    expect(socket.binaryFrames()).toHaveLength(1);
  });

  it("ignores frames the contract does not recognise instead of ending the stream", () => {
    const socket = new FakeSocket();
    const lines: AsrLiveLine[] = [];
    const onError = vi.fn();
    const transcriber = createStreamLiveTranscriber(() => socket, { sampleRate: SAMPLE_RATE, onLine: (line) => lines.push(line), onError });
    transcriber.push(block(160));
    socket.open();

    socket.receive({ type: "heartbeat" });
    socket.receive("not json at all");
    socket.receive({ type: "sentence", sentenceId: 2, text: "还在", beginMs: 3_000 });

    expect(lines.map((line) => line.text)).toEqual(["还在"]);
    expect(onError).not.toHaveBeenCalled();
  });
});
