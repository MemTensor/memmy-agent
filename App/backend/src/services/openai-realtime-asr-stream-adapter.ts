import { mergeProviderHeaders } from "../shared/provider-headers.js";
import { randomUUID } from "node:crypto";
import type { AsrStreamControl, AsrStreamEvent, ActualModelContext, ResolvedProviderSnapshot } from "@memmy/local-api-contracts";
import WebSocket from "ws";

export interface OpenAiRealtimeAsrStreamAdapter {
  control(frame: AsrStreamControl): void;
  audio(bytes: Buffer): void;
  close(): void;
}

export interface CreateOpenAiRealtimeAsrStreamAdapterOptions {
  context: Readonly<ActualModelContext>;
  provider: Readonly<ResolvedProviderSnapshot>;
  connect(url: string, headers: Record<string, string>): WebSocket;
  emit(event: AsrStreamEvent): void;
  done(code: number, reason: string): void;
  readyTimeoutMs?: number;
}

const CLOSE_NORMAL = 1000;
const CLOSE_UPSTREAM_GONE = 1011;
const DEFAULT_READY_TIMEOUT_MS = 3_000;
const FINISH_TIMEOUT_MS = 8_000;
const MAX_PENDING_AUDIO_BYTES = 256 * 1024;
const TRANSCRIPTION_INSTRUCTIONS = "Transcribe the user's speech verbatim. Return only the transcript text.";

/** Uses the selected OpenAI Realtime model itself to turn microphone audio into text. */
export function createOpenAiRealtimeAsrStreamAdapter(
  options: CreateOpenAiRealtimeAsrStreamAdapterOptions
): OpenAiRealtimeAsrStreamAdapter {
  const upstream = options.connect(toOpenAiRealtimeUrl(options.provider.apiBase, options.context.model), mergeProviderHeaders({
    ...(options.provider.apiKey ? { authorization: `Bearer ${options.provider.apiKey}` } : {}),
    ...(options.context.model.includes("preview") ? { "OpenAI-Beta": "realtime=v1" } : {})
  }, options.provider.extraHeaders));
  const pendingAudio: Buffer[] = [];
  const responseText = new Map<string, string>();
  const sentenceIds = new Map<string, number>();
  let pendingBytes = 0;
  let nextSentenceId = 1;
  let ready = false;
  let finishRequested = false;
  let finishSent = false;
  let finished = false;
  let closed = false;
  let finalCommitId: string | undefined;
  let finalCommitSettled = false;
  const pendingItems = new Set<string>();
  const pendingSpeech = new Set<string>();
  const responseItems = new Map<string, string>();
  const preview = options.context.model.includes("preview");
  const resampler = createPcm16Resampler(16_000, 24_000);
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let finishTimer: ReturnType<typeof setTimeout> | undefined;

  const fail = (message: string) => {
    if (closed || finished) return;
    closed = true;
    clearTimeout(readyTimer);
    clearTimeout(finishTimer);
    options.emit({ type: "error", message });
    options.done(CLOSE_UPSTREAM_GONE, "upstream error");
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close(CLOSE_NORMAL, "adapter failed");
    }
  };

  const sendJson = (value: unknown) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(value));
  };

  const sendAudio = (bytes: Buffer) => {
    if (closed || finished) return;
    if (upstream.bufferedAmount > MAX_PENDING_AUDIO_BYTES) { fail("ASR stream cannot keep up with audio"); return; }
    const pcm = resampler.push(bytes);
    if (pcm.length) sendJson({ event_id: eventId(), type: "input_audio_buffer.append", audio: pcm.toString("base64") });
  };

  const flush = () => {
    if (closed || ready) return;
    ready = true;
    clearTimeout(readyTimer);
    options.emit({ type: "ready" });
    for (const bytes of pendingAudio) sendAudio(bytes);
    pendingAudio.length = 0;
    pendingBytes = 0;
    if (finishRequested) finishUpstream();
  };

  const finishSuccessfully = () => {
    if (closed || finished) return;
    finished = true;
    clearTimeout(readyTimer);
    clearTimeout(finishTimer);
    options.emit({ type: "finished" });
    options.done(CLOSE_NORMAL, "done");
    if (upstream.readyState === WebSocket.OPEN) upstream.close(CLOSE_NORMAL, "done");
  };

  const maybeFinish = () => {
    if (finalCommitSettled && pendingItems.size === 0 && pendingSpeech.size === 0 && sentenceIds.size > 0) {
      finishSuccessfully();
    }
  };

  const finishUpstream = () => {
    if (closed || finished || finishSent) return;
    finishSent = true;
    finishTimer = setTimeout(() => fail("upstream ASR session did not finish"), FINISH_TIMEOUT_MS);
    const tail = resampler.finish();
    if (tail.length) sendJson({ event_id: eventId(), type: "input_audio_buffer.append", audio: tail.toString("base64") });
    // Acknowledgement orders prior VAD commits before our one final manual commit.
    sendJson({ event_id: eventId(), type: "session.update", session: preview
      ? { turn_detection: null }
      : { type: "realtime", audio: { input: { turn_detection: null } } } });
  };

  upstream.on("open", () => {
    readyTimer = setTimeout(() => fail("upstream ASR session did not become ready"), options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    sendJson({
      event_id: eventId(),
      type: "session.update",
      session: preview ? {
        modalities: ["text"], instructions: TRANSCRIPTION_INSTRUCTIONS,
        input_audio_format: "pcm16",
        turn_detection: { type: "server_vad", threshold: 0.2, silence_duration_ms: 400, create_response: false, interrupt_response: false }
      } : {
        type: "realtime", output_modalities: ["text"], instructions: TRANSCRIPTION_INSTRUCTIONS,
        audio: { input: { format: { type: "audio/pcm", rate: 24_000 },
          turn_detection: { type: "server_vad", threshold: 0.2, silence_duration_ms: 400, create_response: false, interrupt_response: false } } }
      }
    });
  });

  upstream.on("message", (raw, isBinary) => {
    if (isBinary || closed) return;
    const frame = safeRecord(raw.toString());
    if (!frame) return;
    const type = stringValue(frame.type);
    if (type === "session.updated") {
      if (!ready) flush();
      else if (finishSent && !finalCommitId) {
        const session = record(frame.session);
        const turnDetection = preview ? session?.turn_detection : record(record(session?.audio)?.input)?.turn_detection;
        if (turnDetection !== null) return;
        finalCommitId = eventId();
        sendJson({ event_id: finalCommitId, type: "input_audio_buffer.commit" });
      }
      return;
    }
    if (type === "error") {
      const error = record(frame.error);
      const code = stringValue(error?.code);
      // VAD may already have committed the last utterance. Only our empty tail is harmless.
      if (code === "input_audio_buffer_commit_empty_audio" && finalCommitId && error?.event_id === finalCommitId
        && sentenceIds.size > 0 && pendingSpeech.size === 0) {
        finalCommitSettled = true;
        maybeFinish();
        return;
      }
      fail(stringValue(error?.message) ?? code ?? "upstream realtime ASR failed");
      return;
    }
    if (type === "input_audio_buffer.speech_started") {
      const itemId = stringValue(frame.item_id);
      if (itemId) pendingSpeech.add(itemId);
      return;
    }
    if (type === "input_audio_buffer.committed") {
      const itemId = stringValue(frame.item_id);
      if (!itemId) { fail("ASR commit has no audio item"); return; }
      if (finalCommitId) finalCommitSettled = true;
      pendingSpeech.delete(itemId);
      if (sentenceIds.has(itemId)) return;
      sentenceId(itemId);
      pendingItems.add(itemId);
      // Transcribe each audio item once, without prior conversation text or response conflicts.
      sendJson({ event_id: eventId(), type: "response.create", response: {
        ...(preview ? { modalities: ["text"] } : { output_modalities: ["text"] }),
        conversation: "none", input: [{ type: "item_reference", id: itemId }],
        instructions: TRANSCRIPTION_INSTRUCTIONS, metadata: { memmy_asr_item: itemId }
      } });
      return;
    }
    if (type === "response.created") {
      const response = record(frame.response);
      const id = stringValue(response?.id);
      const itemId = stringValue(record(response?.metadata)?.memmy_asr_item);
      if (!id || !itemId || !pendingItems.has(itemId)) { fail("ASR response has no matching audio item"); return; }
      responseItems.set(id, itemId);
      return;
    }
    if (type === "response.text.delta" || type === "response.output_text.delta"
      || type === "response.text.done" || type === "response.output_text.done") {
      const id = stringValue(frame.response_id);
      const itemId = id ? responseItems.get(id) : undefined;
      if (!id || !itemId) { fail("ASR text has no matching audio item"); return; }
      const text = type.endsWith(".delta")
        ? `${responseText.get(id) ?? ""}${stringValue(frame.delta) ?? ""}`
        : stringValue(frame.text) ?? responseText.get(id) ?? "";
      responseText.set(id, text);
      if (text.trim()) options.emit({ type: "partial", sentenceId: sentenceId(itemId), text, beginMs: 0 });
      return;
    }
    if (type === "response.done") {
      const response = record(frame.response);
      if (response?.status !== "completed") {
        fail(stringValue(record(record(response?.status_details)?.error)?.message) ?? `ASR response ${String(response?.status ?? "missing status")}`);
        return;
      }
      const id = stringValue(response.id);
      const itemId = id ? responseItems.get(id) : undefined;
      const text = (id ? responseText.get(id) : undefined)?.trim();
      if (!id || !itemId || !text) { fail("ASR final response has no transcript"); return; }
      options.emit({ type: "sentence", sentenceId: sentenceId(itemId), text, beginMs: 0, endMs: 0 });
      pendingItems.delete(itemId);
      responseItems.delete(id);
      responseText.delete(id);
      maybeFinish();
    }
  });

  upstream.on("error", (error) => fail(`upstream: ${error.message}`));
  upstream.on("close", () => {
    if (!closed && !finished) fail("upstream ASR stream closed before completion");
  });

  function sentenceId(responseId: string): number {
    const existing = sentenceIds.get(responseId);
    if (existing !== undefined) return existing;
    const created = nextSentenceId++;
    sentenceIds.set(responseId, created);
    return created;
  }

  return {
    control(frame) {
      if (closed || finished) return;
      if (frame.type === "start") {
        if (frame.sampleRate !== undefined && frame.sampleRate !== 16_000) fail("OpenAI ASR expects 16 kHz source PCM");
        return;
      }
      finishRequested = true;
      if (ready) finishUpstream();
    },
    audio(bytes) {
      if (closed || finished || finishRequested || bytes.length === 0) return;
      if (ready) {
        sendAudio(bytes);
        return;
      }
      if (pendingBytes + bytes.length > MAX_PENDING_AUDIO_BYTES) {
        fail("upstream ASR session took too long to accept audio");
        return;
      }
      pendingAudio.push(Buffer.from(bytes));
      pendingBytes += bytes.length;
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(readyTimer);
      clearTimeout(finishTimer);
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close(CLOSE_NORMAL, "downstream closed");
      }
    }
  };
}

export function toOpenAiRealtimeUrl(apiBase: string, model: string): string {
  const url = new URL(apiBase);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/realtime`;
  url.search = new URLSearchParams({ model }).toString();
  url.hash = "";
  return url.toString();
}

function eventId(): string {
  return `event_${randomUUID().replaceAll("-", "")}`;
}

function safeRecord(text: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Stateful linear resampling; keeps fractional positions across PCM blocks. */
export function createPcm16Resampler(sourceRate: number, targetRate: number) {
  let carry: number[] = [];
  let position = 0;
  const convert = (samples: number[]) => {
    const values = [...carry, ...samples];
    const output: number[] = [];
    while (Math.floor(position / targetRate) + 1 < values.length) {
      const index = Math.floor(position / targetRate);
      const fraction = (position % targetRate) / targetRate;
      output.push(Math.round(values[index]! + (values[index + 1]! - values[index]!) * fraction));
      position += sourceRate;
    }
    const consumed = Math.floor(position / targetRate);
    carry = values.slice(consumed);
    position -= consumed * targetRate;
    const result = Buffer.alloc(output.length * 2);
    output.forEach((value, index) => result.writeInt16LE(value, index * 2));
    return result;
  };
  return {
    push(bytes: Buffer) {
      const values: number[] = [];
      for (let index = 0; index + 1 < bytes.length; index += 2) values.push(bytes.readInt16LE(index));
      return convert(values);
    },
    finish() {
      const result = carry.length ? convert([carry[carry.length - 1]!]) : Buffer.alloc(0);
      carry = []; position = 0;
      return result;
    }
  };
}
