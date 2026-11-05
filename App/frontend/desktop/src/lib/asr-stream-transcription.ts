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
import { AsrStreamEventSchema, type AsrStreamEvent } from "@memmy/local-api-contracts";
import type { AsrLiveLine, AsrLiveTranscriber } from "./asr-live-transcription.js";

export interface AsrStreamTranscriberOptions {
  /** Sample rate of the PCM being pushed; sent to the recognizer on start. */
  sampleRate: number;
  onLine: (line: AsrLiveLine) => void;
  onError?: (error: Error) => void;
}

/** Minimal WebSocket surface, so tests can stand in a fake. */
export interface StreamSocket {
  readonly readyState: number;
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
export type StreamSocketOpener = () => StreamSocket;

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
  let socket: StreamSocket | null = null;
  let cancelled = false;
  let finished = false;
  // PCM captured before the socket opens is held so the first block of speech
  // is not lost to the handshake.
  const pending: Int16Array[] = [];
  let resolveFinished: (() => void) | null = null;
  const finishedPromise = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  const fail = (message: string) => {
    if (cancelled) return;
    options.onError?.(new Error(message));
  };

  const settle = () => {
    finished = true;
    resolveFinished?.();
  };

  const connect = () => {
    if (socket || cancelled) return;
    const next = openSocket();
    socket = next;
    next.binaryType = "arraybuffer";
    next.addEventListener("open", () => {
      if (cancelled) {
        next.close();
        return;
      }
      next.send(JSON.stringify({ type: "start", sampleRate: options.sampleRate }));
      for (const block of pending) next.send(toArrayBuffer(block));
      pending.length = 0;
      if (finishRequested) next.send(JSON.stringify({ type: "finish" }));
    });
    next.addEventListener("message", (event) => {
      if (cancelled) return;
      if (typeof event.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      const result = AsrStreamEventSchema.safeParse(parsed);
      if (!result.success) return;
      handleEvent(result.data);
    });
    next.addEventListener("close", () => {
      // A close without `finished` is the relay or the Cloud giving up. The
      // recording itself keeps going: the finished recording is transcribed
      // again in full, so nothing is permanently lost.
      if (!finished && !cancelled) fail("live transcription stream closed");
      settle();
    });
    next.addEventListener("error", () => {
      if (!finished) fail("live transcription stream failed");
    });
  };

  let finishRequested = false;

  const handleEvent = (event: AsrStreamEvent) => {
    switch (event.type) {
      case "partial":
      case "sentence": {
        const text = event.text.trim();
        if (!text) return;
        options.onLine({ startMs: event.beginMs, endMs: event.endMs ?? event.beginMs, text });
        return;
      }
      case "finished":
        settle();
        socket?.close(1000, "done");
        return;
      case "error":
        fail(event.message);
        settle();
        return;
      default:
        return;
    }
  };

  return {
    push(samples) {
      if (cancelled || samples.length === 0) return;
      if (!socket) connect();
      const current = socket;
      if (current && current.readyState === OPEN) {
        current.send(toArrayBuffer(samples));
      } else {
        pending.push(samples.slice());
      }
    },

    async finish() {
      if (cancelled) return;
      finishRequested = true;
      if (!socket) {
        // Nothing was ever pushed; there is nothing to wait for.
        settle();
        return;
      }
      if (socket.readyState === OPEN) socket.send(JSON.stringify({ type: "finish" }));
      await finishedPromise;
    },

    cancel() {
      cancelled = true;
      pending.length = 0;
      settle();
      socket?.close(1000, "cancelled");
      socket = null;
    }
  };
}
