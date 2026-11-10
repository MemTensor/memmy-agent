import { useCallback, useEffect, useRef, useState } from "react";
import { ASR_MAX_AUDIO_BYTES, type AsrTranscriptionResponse } from "@memmy/local-api-contracts";
import type { AsrClient } from "../api/asr-client.js";
import { formatMessage, type MessageKey, zhCNMessages } from "../i18n/messages.js";
import {
  type AsrLiveLine,
  type AsrLiveTranscriber
} from "../lib/asr-live-transcription.js";
import { createStreamLiveTranscriber } from "../lib/asr-stream-transcription.js";
import { createPcmTap, PCM_TAP_SAMPLE_RATE, type PcmTap } from "../lib/audio-pcm-tap.js";

/**
 * Opus bitrate for recordings, mono.
 *
 * Chosen so a two-hour interview still fits {@link ASR_MAX_AUDIO_BYTES} in a
 * single request. Opus is designed for speech at this rate, and ASR cares about
 * intelligibility rather than fidelity.
 */
export const ASR_AUDIO_BITS_PER_SECOND = 16_000;

/** Longest recording that fits the payload ceiling at the pinned bitrate. */
export const ASR_MAX_RECORDING_MS = Math.floor((ASR_MAX_AUDIO_BYTES * 8) / ASR_AUDIO_BITS_PER_SECOND) * 1_000;

const EMPTY_AUDIO_ERROR_MESSAGE = formatMessage(zhCNMessages["asr.error.emptyAudio"]);
const MICROPHONE_PERMISSION_ERROR_MESSAGE = formatMessage(zhCNMessages["asr.error.microphonePermissionDenied"]);

export type AsrRecorderStatus = "idle" | "checkingPermission" | "requestingPermission" | "starting" | "recording" | "paused" | "transcribing" | "error";
export type MicrophoneAccessStatus = "not-determined" | "granted" | "denied" | "restricted" | "unsupported";

export interface AsrTranscribeOptions {
  /** Requests speaker separation. Honoured only by upstream models that support it. */
  diarization?: boolean;
  /**
   * Called once the browser recording has been stopped, before the ASR request
   * starts. Callers can keep the audio visible while transcription is pending.
   */
  onRecordingReady?(recording: Blob, recordingMimeType: string, durationMs: number | undefined): void;
}

export interface AsrRecorder {
  status: AsrRecorderStatus;
  error: Error | null;
  isRecording: boolean;
  isTranscribing: boolean;
  isStarting: boolean;
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  cancel(): void;
  /** Stops capture, finalizes the live result, and returns the recording for background work. */
  stop(): Promise<AsrStoppedRecording>;
  finishAndTranscribe(options?: AsrTranscribeOptions): Promise<AsrRecordingTranscription>;
}

/** A stopped recording and the result of its optional realtime pass. */
export interface AsrStoppedRecording {
  sessionId?: string;
  /** Present only after the live stream completed successfully. */
  liveText?: string;
  liveError?: Error;
  recording: Blob;
  recordingMimeType: string;
  durationMs: number | undefined;
}

/**
 * Transcribes a finished recording.
 *
 * Independent of any recorder instance, so it can run after the card that
 * captured the audio has gone — which is what lets the user move on while a
 * long interview is still being transcribed.
 *
 * @param asrClient Transcription client.
 * @param recording The captured audio.
 * @param durationMs Measured length, forwarded to the upstream model.
 * @param options Diarization and the empty-audio message.
 * @returns The transcript, with the recording it came from.
 */
export async function transcribeRecording(
  asrClient: AsrClient,
  recording: Blob,
  durationMs: number | undefined,
  options: { diarization?: boolean; emptyAudioMessage?: string; signal?: AbortSignal } & Pick<AsrStoppedRecording, "sessionId" | "liveText" | "liveError"> = {}
): Promise<AsrRecordingTranscription> {
  options.signal?.throwIfAborted();
  if (options.liveText && !options.liveError && !options.diarization) {
    return { text: options.liveText, transcribedAt: new Date().toISOString(), recording,
      recordingMimeType: recording.type || "audio/webm", durationMs };
  }
  try {
    if (recording.size > ASR_MAX_AUDIO_BYTES) {
      // Fail here with the recording still in hand rather than letting the
      // gateway reject the payload after a long upload.
      throw Object.assign(new Error(formatMessage(zhCNMessages["asr.error.audioTooLarge"])), { code: "audio_too_large" });
    }
    const encoded = await blobToAudioBase64(recording, options.emptyAudioMessage);
    options.signal?.throwIfAborted();
    const result = await asrClient.transcribe({
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      audioBase64: encoded.audioBase64,
      mimeType: encoded.mimeType,
      durationMs,
      ...(options.diarization ? { diarization: true } : {})
    }, options.signal);
    options.signal?.throwIfAborted();
    if (!hasTranscribedSpeech(result)) {
      throw Object.assign(new Error(options.emptyAudioMessage ?? EMPTY_AUDIO_ERROR_MESSAGE), { code: "empty_audio" });
    }
    const text = result.text.trim() ? result.text
      : result.segments!.map((segment) => segment.text.trim()).filter(Boolean).join(" ");
    return { ...result, text, recording, recordingMimeType: encoded.mimeType, durationMs };
  } catch (caught) {
    options.signal?.throwIfAborted();
    const httpError = caught instanceof Error ? caught : new Error(String(caught));
    const error = new Error(options.liveError
      ? `Realtime ASR: ${options.liveError.message}\nHTTP ASR: ${httpError.message}` : httpError.message, { cause: httpError });
    error.name = "AsrTranscriptionError";
    throw error;
  }
}

/** A finished recording together with its transcript. */
export type AsrRecordingTranscription = Pick<AsrTranscriptionResponse, "text" | "transcribedAt" | "segments"> & {
  /** The audio as captured, for callers that have to keep or upload the original. */
  recording: Blob;
  recordingMimeType: string;
  durationMs: number | undefined;
};

export interface EncodedAudio {
  audioBase64: string;
  mimeType: string;
}

export interface AsrRecorderOptions {
  emptyAudioMessage?: string;
  /**
   * Transcribes the recording while it is still running.
   *
   * Supplying this opens a second read of the microphone stream for raw
   * samples. The lines it reports are provisional: they carry no speaker
   * labels, because speaker numbering only means something across a whole
   * recording, which the diarized pass at the end produces.
   */
  live?: {
    onLine(line: AsrLiveLine): void;
    /** Receives a 0..1 loudness reading per captured block, for the waveform. */
    onLevel?(level: number): void;
  };
}

export interface MicrophoneAccessBridge {
  getMicrophoneAccessStatus(): Promise<MicrophoneAccessStatus>;
  requestMicrophoneAccess(): Promise<MicrophoneAccessStatus>;
}

export class MicrophonePermissionError extends Error {
  readonly status: MicrophoneAccessStatus;

  constructor(status: MicrophoneAccessStatus, message = MICROPHONE_PERMISSION_ERROR_MESSAGE) {
    super(message);
    this.name = "MicrophonePermissionError";
    this.status = status;
  }
}

/**
 * Resolves the toast/copy key that guides the user to the OS microphone settings page.
 *
 * macOS and Windows use different Settings paths, so the key is platform-aware.
 *
 * @param platform The desktop runtime platform (`darwin`, `win32`, …).
 * @returns A message key that can be translated for the current OS.
 */
export function microphonePermissionDeniedMessageKey(
  platform: string | undefined = typeof window === "undefined" ? undefined : window.memmy?.platform
): MessageKey {
  return platform === "win32"
    ? "asr.error.microphonePermissionDenied.windows"
    : "asr.error.microphonePermissionDenied.mac";
}

/** Classifies the final failure without exposing provider responses in the UI. */
export function asrErrorMessageKey(error: unknown): MessageKey {
  // HTTP is the last attempt; an earlier realtime failure must not hide its cause.
  const failure = error instanceof Error && error.name === "AsrTranscriptionError" && error.cause
    ? error.cause : error;
  if (failure instanceof MicrophonePermissionError || isMicrophonePermissionDenial(failure)) {
    return microphonePermissionDeniedMessageKey();
  }
  if (isAsrModelNotConfiguredError(failure)) return "home.asrNotConfigured";
  const code = failure && typeof failure === "object" && "code" in failure ? failure.code : null;
  const message = failure instanceof Error ? failure.message : String(failure);
  switch (code) {
    case "empty_audio": return "asr.error.emptyAudio";
    case "audio_too_large": return "asr.error.audioTooLarge";
    case "model_selection_unavailable":
      return /Assigned ASR model is unavailable/i.test(message)
        ? "home.asrNotConfigured" : "home.asrModelUnavailable";
    case "unauthorized":
    case "forbidden": return "home.asrAccessDenied";
    case "rate_limited": return "home.asrRateLimited";
    case "invalid_argument": return "home.asrInvalidConfiguration";
    case "internal": return "home.asrServiceUnavailable";
  }
  if ((failure instanceof Error && failure.name === "TimeoutError") || /timed? ?out|timeout/i.test(message)) {
    return "home.asrTimeout";
  }
  if (/failed to fetch|network|connection refused|econnrefused|enotfound|socket hang up/i.test(message)) {
    return "home.asrConnectionFailed";
  }
  return "home.asrFailed";
}

export function isAsrModelNotConfiguredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ASR (?:model catalog|model|client) is not configured|ASR requires account or BYOK mode/i.test(message);
}

export function useAsrRecorder(asrClient?: AsrClient, options: AsrRecorderOptions = {}): AsrRecorder {
  const [status, setStatus] = useState<AsrRecorderStatus>("idle");
  const [error, setError] = useState<Error | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number | null>(null);
  const tapRef = useRef<PcmTap | null>(null);
  const liveRef = useRef<AsrLiveTranscriber | null>(null);
  const pausedRef = useRef(false);
  const pausedAtRef = useRef<number | null>(null);
  const pausedDurationRef = useRef(0);
  const generationRef = useRef(0);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<string | null>(null);
  const liveFailureRef = useRef<Error | null>(null);
  const releaseSession = useCallback(() => {
    const id = sessionRef.current;
    sessionRef.current = null;
    if (id) void asrClient?.release(id).catch(() => undefined);
  }, [asrClient]);
  // Held in a ref so a caller passing fresh handler closures each render does
  // not restart the recording.
  const liveOptionsRef = useRef(options.live);
  liveOptionsRef.current = options.live;

  const releaseLiveCapture = useCallback(() => {
    liveRef.current?.cancel();
    liveRef.current = null;
    void tapRef.current?.close().catch(() => undefined);
    tapRef.current = null;
  }, []);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    transcriptionAbortRef.current?.abort();
    transcriptionAbortRef.current = null;
    releaseSession();
    stopRecorderSilently(recorderRef.current);
    recorderRef.current = null;
    chunksRef.current = [];
    startedAtRef.current = null;
    releaseLiveCapture();
    pausedRef.current = false;
    pausedAtRef.current = null;
    pausedDurationRef.current = 0;
    stopStream(streamRef.current);
    streamRef.current = null;
    setStatus("idle");
  }, [releaseLiveCapture, releaseSession]);

  useEffect(() => cancel, [cancel]);

  const start = useCallback(async () => {
    cancel();
    const generation = generationRef.current;
    liveFailureRef.current = null;
    setError(null);

    try {
      if (!asrClient) {
        throw new Error("ASR client is not configured");
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone recording is not supported");
      }
      if (typeof MediaRecorder === "undefined") {
        throw new Error("MediaRecorder is not supported");
      }

      setStatus("checkingPermission");
      const { sessionId } = await asrClient.prepare();
      if (generation !== generationRef.current) { void asrClient.release(sessionId).catch(() => undefined); return; }
      sessionRef.current = sessionId;
      await ensureMicrophoneAccess(getMicrophoneAccessBridge(), (status) => {
        if (generation === generationRef.current && status === "requestingPermission") {
          setStatus("requestingPermission");
        }
      });
      if (generation !== generationRef.current) return;
      setStatus("starting");
      let captureRequested = false;
      const acquireStream = async (): Promise<MediaStream> => {
        assertCurrentRecording(generation);
        captureRequested = true;
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, sampleRate: 16_000, echoCancellation: true, noiseSuppression: true }
          });
        } catch (mediaError) {
          if (isMicrophonePermissionDenial(mediaError)) throw new MicrophonePermissionError("denied");
          throw mediaError;
        }
        if (generation !== generationRef.current) {
          stopStream(stream);
          throw new DOMException("Recording cancelled", "AbortError");
        }
        streamRef.current = stream;
        return stream;
      };
      let captureStarted = false;
      const live = liveOptionsRef.current;
      if (live) {
        // Try the native streaming path first in either account or BYOK mode.
        // If its handshake or session fails, the MediaRecorder copy remains
        // intact and finishAndTranscribe performs the existing full HTTP pass.
        const streamed = createStreamLiveTranscriber(() => asrClient.openStream(sessionId), {
          sampleRate: PCM_TAP_SAMPLE_RATE,
          onLine: (line) => { if (generation === generationRef.current) liveOptionsRef.current?.onLine(line); },
          onError: (liveError) => {
            if (generation !== generationRef.current) return;
            liveFailureRef.current = liveError;
            if (liveRef.current !== streamed) return;
            streamed.cancel();
            liveRef.current = null;
          }
        });
        liveRef.current = streamed;
        const tapStarting = createPcmTap(acquireStream, {
          onError: (tapError) => {
            if (generation !== generationRef.current) return;
            liveFailureRef.current = tapError;
            streamed.cancel();
            if (liveRef.current === streamed) liveRef.current = null;
          },
          sampleRate: PCM_TAP_SAMPLE_RATE,
          // Read through the ref so a failed stream stops receiving PCM while
          // the complete MediaRecorder copy remains available for HTTP fallback.
          onSamples: (samples) => {
            if (generation === generationRef.current && captureStarted) liveRef.current?.push(samples);
          },
          onLevel: (level) => {
            if (generation === generationRef.current && !pausedRef.current) liveOptionsRef.current?.onLevel?.(level);
          }
        }).then(async (tap) => {
          if (generation !== generationRef.current) { await tap.close().catch(() => undefined); return; }
          tapRef.current = tap;
        }).catch((caught: unknown) => {
          if (generation !== generationRef.current) return;
          if (captureRequested && !streamRef.current) throw caught;
          liveFailureRef.current = caught instanceof Error ? caught : new Error(String(caught));
          streamed.cancel();
          if (liveRef.current === streamed) liveRef.current = null;
        });
        // Start both captures together so a successful realtime pass includes the opening speech.
        await tapStarting;
      }
      if (generation !== generationRef.current) return;
      const stream = streamRef.current ?? await acquireStream();
      assertCurrentRecording(generation);
      const recorder = new MediaRecorder(stream, pickRecorderOptions());
      const chunks: Blob[] = [];
      chunksRef.current = chunks;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.start();
      captureStarted = true;
      startedAtRef.current = Date.now();
      pausedRef.current = false;
      setStatus("recording");
    } catch (caught) {
      if (generation !== generationRef.current) return;
      releaseSession();
      const nextError = caught instanceof Error ? caught : new Error(String(caught));
      stopRecorderSilently(recorderRef.current);
      recorderRef.current = null;
      chunksRef.current = [];
      startedAtRef.current = null;
      releaseLiveCapture();
      stopStream(streamRef.current);
      streamRef.current = null;
      setError(nextError);
      setStatus("error");
      throw nextError;
    }
  }, [asrClient, cancel, releaseLiveCapture, releaseSession]);

  const pause = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    recorder.pause();
    tapRef.current?.setPaused(true);
    pausedAtRef.current = Date.now();
    pausedRef.current = true;
    setStatus("paused");
  }, []);

  const resume = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== "paused") return;
    recorder.resume();
    tapRef.current?.setPaused(false);
    if (pausedAtRef.current !== null) pausedDurationRef.current += Date.now() - pausedAtRef.current;
    pausedAtRef.current = null;
    pausedRef.current = false;
    setStatus("recording");
  }, []);

  const finishAndTranscribe = useCallback(async (transcribeOptions: AsrTranscribeOptions = {}) => {
    if (!asrClient) {
      throw new Error("ASR client is not configured");
    }

    const recorder = recorderRef.current;
    if (!recorder) {
      throw new Error("No active recording");
    }

    const generation = generationRef.current;
    try {
      setStatus("transcribing");
      const { recording: blob, durationMs, liveText, liveError, sessionId } = await stopCapture(recorder);
      // The recording is already complete at this point. Notify the caller
      // before size checks and encoding so it can keep the audio visible even
      // when the final ASR request will be rejected.
      transcribeOptions.onRecordingReady?.(blob, blob.type || "audio/webm", durationMs);
      assertCurrentRecording(generation);
      const controller = new AbortController();
      transcriptionAbortRef.current = controller;
      const result = await transcribeRecording(asrClient, blob, durationMs, {
        signal: controller.signal,
        sessionId, liveText, liveError, diarization: transcribeOptions.diarization,
        emptyAudioMessage: options.emptyAudioMessage
      });
      assertCurrentRecording(generation);
      transcriptionAbortRef.current = null;
      releaseSession();
      chunksRef.current = [];
      setStatus("idle");
      return result;
    } catch (caught) {
      if (generation !== generationRef.current) throw caught;
      const nextError = caught instanceof Error ? caught : new Error(String(caught));
      setError(nextError);
      setStatus("error");
      releaseSession();
      releaseLiveCapture();
      stopStream(streamRef.current);
      streamRef.current = null;
      throw nextError;
    }
  }, [asrClient, options.emptyAudioMessage, releaseLiveCapture, releaseSession]);

  /**
   * Stops the microphone and returns the recording without transcribing it.
   *
   * Transcribing a long interview takes minutes. A caller that has to hand the
   * recording on straight away — so the user is not left waiting — stops here
   * and runs {@link transcribeRecording} itself, somewhere that outlives the
   * card this recorder belongs to.
   */
  const stop = useCallback(async (): Promise<AsrStoppedRecording> => {
    const recorder = recorderRef.current;
    if (!recorder) throw new Error("No active recording");
    const generation = generationRef.current;
    try {
      setStatus("transcribing");
      const stopped = await stopCapture(recorder);
      sessionRef.current = null; // The handover owns this snapshot until HTTP transcription completes.
      chunksRef.current = [];
      setStatus("idle");
      return stopped;
    } catch (caught) {
      if (generation !== generationRef.current) throw caught;
      const nextError = caught instanceof Error ? caught : new Error(String(caught));
      setError(nextError);
      setStatus("error");
      releaseSession();
      releaseLiveCapture();
      stopStream(streamRef.current);
      streamRef.current = null;
      throw nextError;
    }
  }, [releaseLiveCapture, releaseSession]);

  /** Ends capture and the live pass, leaving the recording in hand. */
  async function stopCapture(recorder: MediaRecorder): Promise<AsrStoppedRecording> {
    const generation = generationRef.current;
    const sessionId = sessionRef.current;
    const stream = streamRef.current;
    const tap = tapRef.current;
    const live = liveRef.current;
    const durationMs = startedAtRef.current !== null
      ? Math.max(0, (pausedAtRef.current ?? Date.now()) - startedAtRef.current - pausedDurationRef.current) : undefined;
    recorderRef.current = null;
    // Stop both captures now; waiting for MediaRecorder.onstop first captures extra realtime-only audio.
    const tapClosing = tap?.close().then(() => undefined, (error: unknown) =>
      error instanceof Error ? error : new Error(String(error)));
    const blob = await stopRecorder(recorder, chunksRef.current);
    const tapError = await tapClosing;
    assertCurrentRecording(generation);
    if (tapError) {
      liveFailureRef.current = tapError;
      live?.cancel();
    }
    tapRef.current = null;
    stopStream(stream);
    streamRef.current = null;
    startedAtRef.current = null;
    pausedRef.current = false;
    const liveResult = await live?.finish();
    assertCurrentRecording(generation);
    liveRef.current = null;
    return {
      recording: blob,
      recordingMimeType: blob.type || "audio/webm",
      durationMs,
      ...(sessionId ? { sessionId } : {}),
      ...(liveFailureRef.current ? { liveError: liveFailureRef.current } : {}),
      ...(liveResult?.text ? { liveText: liveResult.text } : {})
    };
  }

  function assertCurrentRecording(generation: number) {
    if (generation !== generationRef.current) throw new DOMException("Recording cancelled", "AbortError");
  }

  return {
    status,
    error,
    isRecording: status === "recording" || status === "paused",
    isTranscribing: status === "transcribing",
    isStarting: status === "checkingPermission" || status === "requestingPermission" || status === "starting",
    start,
    pause,
    resume,
    cancel,
    stop,
    finishAndTranscribe
  };
}

export async function ensureMicrophoneAccess(
  bridge?: Partial<MicrophoneAccessBridge>,
  onTransition?: (status: "requestingPermission") => void
): Promise<MicrophoneAccessStatus> {
  if (!bridge?.getMicrophoneAccessStatus || !bridge.requestMicrophoneAccess) {
    return "granted";
  }

  const currentStatus = normalizeMicrophoneAccessStatus(await bridge.getMicrophoneAccessStatus());
  if (currentStatus === "granted") {
    return "granted";
  }
  if (currentStatus === "restricted" || currentStatus === "unsupported") {
    throw new MicrophonePermissionError(currentStatus);
  }

  onTransition?.("requestingPermission");
  const requestedStatus = normalizeMicrophoneAccessStatus(await bridge.requestMicrophoneAccess());
  if (requestedStatus === "granted") {
    return "granted";
  }
  // Windows/Linux prompt via getUserMedia; leave not-determined so the recorder can continue.
  if (requestedStatus === "not-determined") {
    return "not-determined";
  }

  throw new MicrophonePermissionError(requestedStatus);
}

/**
 * Detects browser/OS denials from getUserMedia that should surface as a microphone-permission toast.
 *
 * @param error The rejection from getUserMedia.
 * @returns True when the user (or OS policy) blocked microphone access.
 */
export function isMicrophonePermissionDenial(error: unknown): boolean {
  if (!(error instanceof DOMException) && !(error instanceof Error)) {
    return false;
  }
  const name = error.name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return true;
  }
  return /permission|not allowed|denied/i.test(error.message);
}

export async function blobToAudioBase64(blob: Blob, emptyAudioMessage = EMPTY_AUDIO_ERROR_MESSAGE): Promise<EncodedAudio> {
  if (blob.size <= 0) {
    throw Object.assign(new Error(emptyAudioMessage), { code: "empty_audio" });
  }

  const dataUrl = await readBlobAsDataUrl(blob);
  const encoded = parseAudioDataUrl(dataUrl, blob.type);
  if (!encoded.audioBase64.trim()) {
    throw Object.assign(new Error(emptyAudioMessage), { code: "empty_audio" });
  }
  return encoded;
}

/** True when the ASR model returned text in either its aggregate or segmented result. */
export function hasTranscribedSpeech(result: Pick<AsrTranscriptionResponse, "text" | "segments">): boolean {
  return Boolean(result.text.trim() || result.segments?.some((segment) => segment.text.trim()));
}

export function mergeVoiceTranscript(current: string, transcript: string): string {
  const next = transcript.trim();
  if (!next) return current;
  return current ? `${current}${current.endsWith("\n") ? "" : "\n"}${next}` : next;
}

/**
 * Picks a recording format supported by the browser.
 *
 * The bitrate is pinned rather than left to the browser: a whole transcription
 * has to travel as one inline payload, and the browser default is high enough
 * that an interview would blow past {@link ASR_MAX_AUDIO_BYTES} after a few
 * minutes. Splitting the audio is not an alternative — speaker numbering
 * restarts per transcription, so a split recording loses its diarization.
 *
 * @returns The MediaRecorder init options.
 */
function pickRecorderOptions(): MediaRecorderOptions {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
  return {
    ...(mimeType ? { mimeType } : {}),
    audioBitsPerSecond: ASR_AUDIO_BITS_PER_SECOND
  };
}

/**
 * Reports how much recording time is left before the payload ceiling.
 *
 * @param elapsedMs Recording time so far.
 * @returns Remaining milliseconds, floored at zero.
 */
export function asrRecordingTimeRemainingMs(elapsedMs: number): number {
  return Math.max(0, ASR_MAX_RECORDING_MS - elapsedMs);
}

/**
 * Reads the microphone-permission bridge exposed by the Electron preload.
 *
 * @returns The currently available permission bridge; undefined when debugging in a plain browser.
 */
function getMicrophoneAccessBridge(): MicrophoneAccessBridge | undefined {
  const bridge = typeof window === "undefined" ? undefined : window.memmy;
  if (
    typeof bridge?.getMicrophoneAccessStatus === "function"
    && typeof bridge.requestMicrophoneAccess === "function"
  ) {
    return {
      getMicrophoneAccessStatus: bridge.getMicrophoneAccessStatus,
      requestMicrophoneAccess: bridge.requestMicrophoneAccess
    };
  }
  return undefined;
}

/**
 * Normalizes the microphone-permission status passed in from outside.
 *
 * @param status The permission status returned by the preload or a test double.
 * @returns A stable permission status used internally by the hook.
 */
function normalizeMicrophoneAccessStatus(status: unknown): MicrophoneAccessStatus {
  if (
    status === "not-determined"
    || status === "granted"
    || status === "denied"
    || status === "restricted"
    || status === "unsupported"
  ) {
    return status;
  }
  return "unsupported";
}

/**
 * Stops recording and produces a Blob.
 *
 * @param recorder The current MediaRecorder.
 * @param chunks The audio chunks collected so far.
 * @returns The complete recording Blob.
 */
function stopRecorder(recorder: MediaRecorder, chunks: Blob[]): Promise<Blob> {
  return new Promise((resolve) => {
    const mimeType = recorder.mimeType || chunks[0]?.type || "audio/webm";
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: mimeType }));
    };
    if (recorder.state === "inactive") {
      resolve(new Blob(chunks, { type: mimeType }));
      return;
    }
    requestRecorderData(recorder);
    recorder.stop();
  });
}

/**
 * Actively flushes the browser recording buffer.
 *
 * @param recorder The current MediaRecorder.
 */
function requestRecorderData(recorder: MediaRecorder): void {
  if (recorder.state === "inactive") return;
  try {
    recorder.requestData();
  } catch {
    // Some browsers reject requestData around stop; the subsequent empty-Blob check surfaces a readable error.
  }
}

/**
 * Silently stops recording.
 *
 * @param recorder The current MediaRecorder.
 */
function stopRecorderSilently(recorder: MediaRecorder | null): void {
  if (!recorder || recorder.state === "inactive") return;
  try {
    recorder.stop();
  } catch {
    // Do not expose browser stop exceptions to the page when canceling a recording.
  }
}

/**
 * Releases the microphone media stream.
 *
 * @param stream The current media stream.
 */
function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) {
    track.stop();
  }
}

/**
 * Parses the audio data URL produced by FileReader.
 *
 * @param dataUrl The data URL output by FileReader.
 * @param fallbackMimeType The MIME type carried by the Blob itself.
 * @returns The base64 audio and MIME type.
 */
function parseAudioDataUrl(dataUrl: string, fallbackMimeType: string): EncodedAudio {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) {
    return {
      audioBase64: "",
      mimeType: fallbackMimeType || "audio/webm"
    };
  }

  const header = dataUrl.slice(0, commaIndex);
  const mimeType = header.startsWith("data:") ? header.slice("data:".length).split(";")[0] : "";
  return {
    audioBase64: dataUrl.slice(commaIndex + 1),
    mimeType: mimeType || fallbackMimeType || "audio/webm"
  };
}

/**
 * Reads a Blob as a data URL.
 *
 * @param blob The browser recording Blob.
 * @returns The data URL.
 */
function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read audio blob"));
    reader.readAsDataURL(blob);
  });
}
