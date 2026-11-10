/**
 * Live transcription of an in-progress recording over the streaming ASR relay.
 *
 * The recording card shows transcript lines while the microphone is still
 * open. The earlier design cut the PCM into six-second WAV segments and posted
 * each to the request/response ASR endpoint; that read as a subtitle that only
 * updated every few seconds. This module opens one WebSocket for the whole
 * recording, pushes PCM as it is captured, and receives the recognizer's own
 * sentence boundaries back — the text appears while the sentence is still
 * being spoken and is replaced in place as the recognizer revises it.
 *
 * Speaker attribution deliberately does not happen here. The realtime model
 * does not separate speakers, and numbering only means something across the
 * whole recording anyway; the diarized pass over the finished recording is
 * what produces speaker labels.
 */
import { AsrStreamEventSchema } from "@memmy/local-api-contracts";
import { mergeLiveLines, type AsrLiveLine, type AsrLiveTranscriber, type AsrLiveTranscriptionResult } from "./asr-live-transcription.js";

export interface AsrStreamTranscriberOptions {
  /** Sample rate of the PCM being pushed; sent to the recognizer on start. */
  sampleRate: number;
  onLine: (line: AsrLiveLine) => void;
  onError?: (error: Error) => void;
}

/** Minimal WebSocket surface, so tests can stand in a fake. */
export interface StreamSocket {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  binaryType: string;
  /** Mirrors the DOM signature; the transcriber only ever passes a string or an ArrayBuffer. */
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
}

/** Opens the relay socket; the ASR client supplies this so the URL and token stay in one place. */
export type StreamSocketOpener = () => StreamSocket | Promise<StreamSocket>;

/** `WebSocket.OPEN`, spelled out so the fake in tests need not carry the constant. */
const OPEN = 1;

/**
 * Hands the socket exactly the bytes of one PCM block.
 *
 * A typed array may be a window onto a larger (or shared) buffer, and the DOM
 * `send` wants a plain `ArrayBuffer`; slicing the view's own byte range gives
 * a fresh, correctly-sized copy without any ambiguity about offsets.
 *
 * @param samples The captured block.
 * @returns A standalone buffer holding just those samples.
 */
function toArrayBuffer(samples: Int16Array): ArrayBuffer {
  return samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength) as ArrayBuffer;
}

/**
 * Transcribes an in-progress recording over one streaming connection.
 *
 * @param openSocket Connects to the local relay.
 * @param options Sample rate and the line sink.
 * @returns A transcriber fed by the recorder's PCM tap.
 */
export function createStreamLiveTranscriber(
  openSocket: StreamSocketOpener,
  options: AsrStreamTranscriberOptions
): AsrLiveTranscriber {
  const maxBytes = 256 * 1024;
  let socket: StreamSocket | null = null;
  let connecting = false;
  let terminal = false;
  let finishRequested = false;
  let pendingBytes = 0;
  const pending: Int16Array[] = [];
  let lines: AsrLiveLine[] = [];
  const finals = new Set<number>();
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (result: AsrLiveTranscriptionResult | null) => void;
  const completion = new Promise<AsrLiveTranscriptionResult | null>((done) => { resolve = done; });
  const settle = (result: AsrLiveTranscriptionResult | null, reason: string) => {
    if (terminal) return;
    terminal = true;
    clearTimeout(readyTimer);
    clearTimeout(finishTimer);
    pending.length = 0;
    pendingBytes = 0;
    resolve(result);
    try { socket?.close(1000, reason); } catch { /* The full recording is independent of this socket. */ }
  };
  const fail = (message: string) => {
    if (terminal) return;
    settle(null, "fallback");
    options.onError?.(new Error(message));
  };
  const send = (data: string | ArrayBuffer) => {
    if (terminal) return;
    if ((socket?.bufferedAmount ?? 0) > maxBytes) { fail("Live ASR send buffer exceeded"); return; }
    try { socket?.send(data); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  };
  const attach = (next: StreamSocket) => {
    if (terminal) { next.close(); return; }
    socket = next;
    next.binaryType = "arraybuffer";
    let started = false;
    const onOpen = () => {
      if (started) return;
      started = true;
      if (terminal) { next.close(); return; }
      send(JSON.stringify({ type: "start", sampleRate: options.sampleRate }));
      for (const block of pending) send(toArrayBuffer(block));
      pending.length = 0;
      pendingBytes = 0;
      if (finishRequested) send(JSON.stringify({ type: "finish" }));
    };
    next.addEventListener("open", onOpen);
    next.addEventListener("message", (event) => {
      if (terminal || typeof event.data !== "string") return;
      let value: unknown;
      try { value = JSON.parse(event.data); } catch { return; }
      const parsed = AsrStreamEventSchema.safeParse(value);
      if (!parsed.success) return;
      const frame = parsed.data;
      if (frame.type === "error") { fail(frame.message); return; }
      if (frame.type === "ready") { clearTimeout(readyTimer); return; }
      if (frame.type === "finished") {
        if (!finishRequested) { fail("Live ASR finished before recording stopped"); return; }
        if (!lines.length || lines.some((line) => !finals.has(line.sentenceId))) {
          fail("Live ASR did not return a complete final transcript"); return;
        }
        settle({ text: lines.map((line) => line.text).join(" ") }, "done");
        return;
      }
      clearTimeout(readyTimer); // Older Cloud relays confirm acceptance through their first result.
      const text = frame.text.trim();
      if (!text || (frame.type === "partial" && finals.has(frame.sentenceId))) return;
      const line = { sentenceId: frame.sentenceId, text, startMs: frame.beginMs, endMs: frame.endMs ?? frame.beginMs };
      lines = mergeLiveLines(lines, line);
      if (frame.type === "sentence") finals.add(frame.sentenceId);
      options.onLine(line);
    });
    next.addEventListener("error", () => fail("Live ASR connection failed"));
    next.addEventListener("close", () => fail("Live ASR closed before its final result"));
    if (next.readyState === OPEN) onOpen();
  };
  const connect = () => {
    connecting = true;
    readyTimer = setTimeout(() => fail("Live ASR handshake timed out"), 8_000);
    try {
      const opened = openSocket();
      if ("then" in opened) void opened.then(attach, (error: unknown) => fail(error instanceof Error ? error.message : String(error)));
      else attach(opened);
    } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  };
  return {
    push(samples) {
      if (terminal || finishRequested || !samples.length) return;
      if (!connecting) connect();
      if (terminal) return;
      if (socket?.readyState === OPEN) send(toArrayBuffer(samples));
      else if (pendingBytes + samples.byteLength > maxBytes) fail("Live ASR audio buffer exceeded");
      else { pending.push(samples.slice()); pendingBytes += samples.byteLength; }
    },
    async finish() {
      if (!terminal && !finishRequested) {
        finishRequested = true;
        if (!connecting) settle(null, "empty");
        else {
          finishTimer = setTimeout(() => fail("Live ASR final result timed out"), 10_000);
          if (socket?.readyState === OPEN) send(JSON.stringify({ type: "finish" }));
        }
      }
      return completion;
    },
    cancel() { settle(null, "cancelled"); }
  };
}
