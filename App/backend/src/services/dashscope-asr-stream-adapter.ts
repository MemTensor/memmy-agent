import { mergeProviderHeaders } from "../shared/provider-headers.js";
import { randomUUID } from "node:crypto";
import type { AsrStreamControl, AsrStreamEvent, ActualModelContext, ResolvedProviderSnapshot } from "@memmy/local-api-contracts";
import WebSocket from "ws";

export interface DashScopeAsrStreamAdapter {
  control(frame: AsrStreamControl): void;
  audio(bytes: Buffer): void;
  close(): void;
}

export interface CreateDashScopeAsrStreamAdapterOptions {
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
const FINISH_TIMEOUT_MS = 5_000;
const MAX_PENDING_AUDIO_BYTES = 256 * 1024;

/** Adapts Memmy's one stream contract to DashScope's two ASR WebSocket protocols. */
export function createDashScopeAsrStreamAdapter(options: CreateDashScopeAsrStreamAdapterOptions): DashScopeAsrStreamAdapter {
  const realtimeSession = isQwenAsrRealtimeModel(options.context.model);
  const urls = dashScopeStreamCandidates(options.provider.apiBase, options.context.model, realtimeSession);
  const routeFailures: string[] = [];
  let candidateIndex = 0;
  let upstream: WebSocket;
  const headers = mergeProviderHeaders({
    ...(options.provider.apiKey ? { authorization: `Bearer ${options.provider.apiKey}` } : {}),
    ...(realtimeSession ? { "OpenAI-Beta": "realtime=v1" } : {})
  }, options.provider.extraHeaders);
  const taskId = randomUUID().replaceAll("-", "");
  const pendingAudio: Buffer[] = [];
  const sentenceIds = new Map<string, number>();
  const pendingTranscripts = new Set<string>();
  const starts = new Map<string, number>();
  const ends = new Map<string, number>();
  let pendingBytes = 0;
  let nextSentenceId = 1;
  let sampleRate = 16_000;
  let ready = false;
  let finishRequested = false;
  let finishSent = false;
  let finished = false;
  let closed = false;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let finishTimer: ReturnType<typeof setTimeout> | undefined;

  const fail = (message: string) => {
    if (closed || finished) return;
    closed = true;
    clearTimeout(readyTimer);
    clearTimeout(finishTimer);
    options.emit({ type: "error", message });
    options.done(CLOSE_UPSTREAM_GONE, "upstream error");
    if (upstream?.readyState === WebSocket.OPEN || upstream?.readyState === WebSocket.CONNECTING) {
      upstream.close(CLOSE_NORMAL, "adapter failed");
    }
  };

  const sendJson = (value: unknown) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(value));
  };

  const sendAudio = (bytes: Buffer) => {
    if (closed || finished) return;
    if (upstream.bufferedAmount > MAX_PENDING_AUDIO_BYTES) { fail("ASR stream cannot keep up with audio"); return; }
    if (realtimeSession) {
      sendJson({ event_id: eventId(), type: "input_audio_buffer.append", audio: bytes.toString("base64") });
    } else if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(bytes, { binary: true });
    }
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

  const finishUpstream = () => {
    if (closed || finished || finishSent) return;
    finishSent = true;
    finishTimer = setTimeout(() => fail("upstream ASR session did not finish"), FINISH_TIMEOUT_MS);
    if (realtimeSession) {
      sendJson({ event_id: eventId(), type: "session.finish" });
      return;
    }
    sendJson({
      header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
      payload: { input: {} }
    });
  };

  function failCandidate(message: string): void {
    fail([...routeFailures, message].join("; "));
  }

  function openCandidate(): void {
    let socket: WebSocket;
    try {
      socket = options.connect(urls[candidateIndex]!, headers);
    } catch (error) {
      failCandidate(error instanceof Error ? error.message : String(error));
      return;
    }
    upstream = socket;
    socket.on("open", () => {
      if (closed || socket !== upstream) return;
      readyTimer = setTimeout(() => failCandidate(`${new URL(urls[candidateIndex]!).pathname}: upstream ASR session did not become ready`), options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
      if (realtimeSession) {
        sendJson({
          event_id: eventId(),
          type: "session.update",
          session: {
            modalities: ["text"],
            input_audio_format: "pcm",
            sample_rate: sampleRate,
            turn_detection: { type: "server_vad", threshold: 0.2, silence_duration_ms: 400 }
          }
        });
        return;
      }
      sendJson({
        header: { action: "run-task", task_id: taskId, streaming: "duplex" },
        payload: {
          task_group: "audio",
          task: "asr",
          function: "recognition",
          model: options.context.model,
          parameters: { format: "pcm", sample_rate: sampleRate },
          input: {}
        }
      });
    });

    socket.on("message", (raw, isBinary) => {
      if (isBinary || closed || socket !== upstream) return;
      const frame = safeRecord(raw.toString());
      if (!frame) return;
      if (realtimeSession) handleRealtime(frame);
      else handleTask(frame);
    });

    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      if (closed || socket !== upstream) { socket.terminate(); return; }
      const failure = `${new URL(urls[candidateIndex]!).pathname}: HTTP ${response.statusCode}`;
      // A proxy can expose Qwen's session protocol at /v1/realtime instead of the native path.
      if (!ready && [404, 405].includes(response.statusCode ?? 0) && candidateIndex + 1 < urls.length) {
        routeFailures.push(failure);
        clearTimeout(readyTimer);
        candidateIndex++;
        openCandidate();
        socket.terminate();
        return;
      }
      failCandidate(failure);
      socket.terminate();
    });
    socket.on("error", (error) => {
      if (socket === upstream) failCandidate(`${new URL(urls[candidateIndex]!).pathname}: ${error.message}`);
    });
    socket.on("close", (code) => {
      if (socket === upstream && !closed && !finished) {
        failCandidate(`${new URL(urls[candidateIndex]!).pathname}: closed (${code}) ${ready ? "before completion" : "before session acceptance"}`);
      }
    });
  }

  openCandidate();

  function handleTask(frame: Record<string, unknown>): void {
    const header = record(frame.header);
    const event = stringValue(header?.event);
    if (event === "task-started") {
      flush();
      return;
    }
    if (event === "task-failed") {
      fail(stringValue(header?.error_message) ?? stringValue(header?.error_code) ?? "upstream task failed");
      return;
    }
    if (event === "task-finished") {
      if (!finishSent || !ready) { fail("upstream ASR finished before the recording ended"); return; }
      if (pendingTranscripts.size) { fail("upstream ASR finished with missing final transcripts"); return; }
      finishSuccessfully();
      return;
    }
    if (event !== "result-generated") return;
    const sentence = record(record(record(frame.payload)?.output)?.sentence);
    const text = stringValue(sentence?.text)?.trim();
    if (!text || sentence?.heartbeat === true) return;
    const beginMs = numberValue(sentence?.begin_time) ?? 0;
    const endMs = numberValue(sentence?.end_time);
    // Native Inference events identify a sentence by its start time, not always by sentence_id.
    const key = `task:${numberValue(sentence?.sentence_id) ?? beginMs}`;
    if (sentence?.sentence_end === true) pendingTranscripts.delete(key);
    else pendingTranscripts.add(key);
    options.emit({
      type: sentence?.sentence_end === true ? "sentence" : "partial",
      sentenceId: sentenceId(key),
      text,
      beginMs,
      ...(endMs === undefined ? {} : { endMs })
    });
  }

  function handleRealtime(frame: Record<string, unknown>): void {
    const type = stringValue(frame.type);
    if (type === "session.updated") {
      flush();
      return;
    }
    if (type === "error" || type === "conversation.item.input_audio_transcription.failed") {
      fail(stringValue(record(frame.error)?.message) ?? "upstream realtime ASR failed");
      return;
    }
    if (type === "input_audio_buffer.speech_started") {
      const itemId = stringValue(frame.item_id);
      if (itemId) {
        sentenceId(itemId);
        starts.set(itemId, numberValue(frame.audio_start_ms) ?? 0);
        pendingTranscripts.add(itemId);
      }
      return;
    }
    if (type === "input_audio_buffer.committed") {
      const itemId = stringValue(frame.item_id);
      if (itemId) { sentenceId(itemId); pendingTranscripts.add(itemId); }
      return;
    }
    if (type === "input_audio_buffer.speech_stopped") {
      const itemId = stringValue(frame.item_id);
      if (itemId) ends.set(itemId, numberValue(frame.audio_end_ms) ?? starts.get(itemId) ?? 0);
      return;
    }
    if (type === "conversation.item.input_audio_transcription.text") {
      const itemId = stringValue(frame.item_id) ?? "current";
      pendingTranscripts.add(itemId);
      const text = `${stringValue(frame.text) ?? ""}${stringValue(frame.stash) ?? ""}`.trim();
      if (text) options.emit({ type: "partial", sentenceId: sentenceId(itemId), text, beginMs: starts.get(itemId) ?? 0 });
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const itemId = stringValue(frame.item_id) ?? "current";
      const text = stringValue(frame.transcript)?.trim();
      if (text === undefined) { fail("upstream ASR completed without transcript text"); return; }
      pendingTranscripts.delete(itemId);
      if (text) options.emit({
        type: "sentence",
        sentenceId: sentenceId(itemId),
        text,
        beginMs: starts.get(itemId) ?? 0,
        endMs: ends.get(itemId) ?? starts.get(itemId) ?? 0
      });
      return;
    }
    if (type === "session.finished") {
      if (!finishSent || !ready) { fail("upstream ASR finished before the recording ended"); return; }
      if (pendingTranscripts.size) { fail("upstream ASR finished with missing final transcripts"); return; }
      finishSuccessfully();
    }
  }

  function sentenceId(itemId: string): number {
    const existing = sentenceIds.get(itemId);
    if (existing !== undefined) return existing;
    const created = nextSentenceId++;
    sentenceIds.set(itemId, created);
    return created;
  }

  function finishSuccessfully(): void {
    if (finished || closed) return;
    finished = true;
    clearTimeout(readyTimer);
    clearTimeout(finishTimer);
    options.emit({ type: "finished" });
    options.done(CLOSE_NORMAL, "done");
    if (upstream.readyState === WebSocket.OPEN) upstream.close(CLOSE_NORMAL, "done");
  }

  return {
    control(frame) {
      if (closed || finished) return;
      if (frame.type === "start") {
        if (ready || pendingBytes > 0) return;
        sampleRate = frame.sampleRate ?? sampleRate;
        return;
      }
      finishRequested = true;
      if (ready) finishUpstream();
    },
    audio(bytes) {
      if (closed || finished || bytes.length === 0) return;
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
      if (upstream?.readyState === WebSocket.OPEN || upstream?.readyState === WebSocket.CONNECTING) {
        upstream.close(CLOSE_NORMAL, "downstream closed");
      }
    }
  };
}

export function isQwenAsrRealtimeModel(model: string): boolean {
  return /^qwen3-asr-flash-realtime(?:$|-)/i.test(model);
}

function dashScopeStreamCandidates(apiBase: string, model: string, realtimeSession: boolean): string[] {
  const native = toDashScopeStreamUrl(apiBase, model, realtimeSession);
  const base = new URL(apiBase);
  const official = /(^|\.)dashscope(?:-intl|-us)?\.aliyuncs\.com$/.test(base.hostname)
    || /\.maas\.aliyuncs\.com$/.test(base.hostname);
  if (!realtimeSession || official || !/\/v1\/?$/.test(base.pathname)) return [native];
  base.protocol = base.protocol === "http:" ? "ws:" : "wss:";
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/realtime`;
  base.search = new URLSearchParams({ model }).toString();
  base.hash = "";
  return [...new Set([native, base.toString()])];
}

export function toDashScopeStreamUrl(apiBase: string, model: string, realtimeSession: boolean): string {
  const url = new URL(apiBase);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  const prefix = url.pathname.replace(/\/(?:compatible-mode\/v1|api\/v1|v1)\/?$/, "").replace(/\/+$/, "");
  url.pathname = `${prefix}/api-ws/v1/${realtimeSession ? "realtime" : "inference"}`;
  url.search = realtimeSession ? new URLSearchParams({ model }).toString() : "";
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

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
