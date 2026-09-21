import { useCallback, useEffect, useRef, useState } from "react";
import { ASR_MAX_AUDIO_BYTES, type AsrTranscriptionResponse } from "@memmy/local-api-contracts";
import type { AsrClient } from "../api/asr-client.js";
import { formatMessage, type MessageKey, zhCNMessages } from "../i18n/messages.js";
import {
  createChunkedLiveTranscriber,
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
  finishAndTranscribe(options?: AsrTranscribeOptions): Promise<AsrRecordingTranscription>;
}

/** A finished recording together with its transcript. */
export interface AsrRecordingTranscription extends AsrTranscriptionResponse {
  /** The audio as captured, for callers that have to keep or upload the original. */
  recording: Blob;
  recordingMimeType: string;
  durationMs: number | undefined;
}

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
    onError?(error: Error): void;
  };
}

/** The live stream is best-effort; a timeout must not read like a lost recording. */
export function isLiveAsrTimeout(error: Error): boolean {
  return /\btime(?:out|d out)\b/i.test(error.message);
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
  // Held in a ref so a caller passing fresh handler closures each render does
  // not restart the recording.
  const liveOptionsRef = useRef(options.live);
  liveOptionsRef.current = options.live;

  const releaseLiveCapture = useCallback(() => {
    liveRef.current?.cancel();
    liveRef.current = null;
    void tapRef.current?.close();
    tapRef.current = null;
  }, []);

  const cancel = useCallback(() => {
    stopRecorderSilently(recorderRef.current);
    recorderRef.current = null;
    chunksRef.current = [];
    startedAtRef.current = null;
    releaseLiveCapture();
    pausedRef.current = false;
    stopStream(streamRef.current);
    streamRef.current = null;
    setStatus("idle");
  }, [releaseLiveCapture]);

  useEffect(() => cancel, [cancel]);

  const start = useCallback(async () => {
    cancel();
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
      await ensureMicrophoneAccess(getMicrophoneAccessBridge(), (status) => {
        if (status === "requestingPermission") {
          setStatus("requestingPermission");
        }
      });
      setStatus("starting");
      let stream: MediaStream;
      try {
        // Mono at speech sample rate: a stereo track doubles the payload for no
        // recognition benefit, and diarization requires a single channel.
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, sampleRate: 16_000, echoCancellation: true, noiseSuppression: true }
        });
      } catch (mediaError) {
        if (isMicrophonePermissionDenial(mediaError)) {
          throw new MicrophonePermissionError("denied");
        }
        throw mediaError;
      }
      const recorder = new MediaRecorder(stream, pickRecorderOptions());
      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.start();
      startedAtRef.current = Date.now();
      pausedRef.current = false;
      const live = liveOptionsRef.current;
      if (live) {
        // The streaming relay is the path that shows words while they are
        // still being spoken. It is only reachable in account mode; when the
        // relay refuses the connection the segmented HTTP path takes over for
        // this recording so the panel is never simply blank.
        const streamed = createStreamLiveTranscriber(() => asrClient.openStream(), {
          sampleRate: PCM_TAP_SAMPLE_RATE,
          onLine: (line) => liveOptionsRef.current?.onLine(line),
          onError: (liveError) => {
            liveOptionsRef.current?.onError?.(liveError);
            if (liveRef.current !== streamed) return;
            const fallback = createChunkedLiveTranscriber(asrClient, {
              sampleRate: PCM_TAP_SAMPLE_RATE,
              onLine: (line) => liveOptionsRef.current?.onLine(line),
              onError: (segmentError) => liveOptionsRef.current?.onError?.(segmentError)
            });
            liveRef.current = fallback;
          }
        });
        const transcriber = streamed;
        liveRef.current = transcriber;
        tapRef.current = createPcmTap(stream, {
          sampleRate: PCM_TAP_SAMPLE_RATE,
          // Read through the ref, not the captured binding: when the stream
          // falls back to segmented HTTP mid-recording the ref is swapped, and
          // the audio has to follow it or the fallback never hears anything.
          onSamples: (samples) => {
            if (!pausedRef.current) liveRef.current?.push(samples);
          },
          onLevel: (level) => {
            if (!pausedRef.current) liveOptionsRef.current?.onLevel?.(level);
          }
        });
      }
      setStatus("recording");
    } catch (caught) {
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
  }, [asrClient, cancel, releaseLiveCapture]);

  const pause = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    recorder.pause();
    // The tap keeps delivering blocks while paused; dropping them here keeps
    // the paused stretch out of both the waveform and the live segments.
    pausedRef.current = true;
    setStatus("paused");
  }, []);

  const resume = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== "paused") return;
    recorder.resume();
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

    try {
      setStatus("transcribing");
      const durationMs = startedAtRef.current ? Math.max(0, Date.now() - startedAtRef.current) : undefined;
      const blob = await stopRecorder(recorder, chunksRef.current);
      recorderRef.current = null;
      // Close the tap before the final pass so no further live segments are
      // started, but let the tail of what was already captured finish: those
      // lines are what the user is reading while the diarized pass runs.
      await tapRef.current?.close();
      tapRef.current = null;
      const live = liveRef.current;
      liveRef.current = null;
      await live?.finish();
      pausedRef.current = false;
      stopStream(streamRef.current);
      streamRef.current = null;
      startedAtRef.current = null;
      if (blob.size > ASR_MAX_AUDIO_BYTES) {
        // Fail here with the recording still in hand rather than letting the
        // gateway reject the payload after a long upload.
        throw new Error(formatMessage(zhCNMessages["asr.error.audioTooLarge"]));
      }
      const encoded = await blobToAudioBase64(blob, options.emptyAudioMessage);
      const result = await asrClient.transcribe({
        audioBase64: encoded.audioBase64,
        mimeType: encoded.mimeType,
        durationMs,
        ...(transcribeOptions.diarization ? { diarization: true } : {})
      });
      chunksRef.current = [];
      setStatus("idle");
      // The recording travels back with the transcript: it is one of the
      // deliverables, and callers cannot re-derive it once the chunks are gone.
      return { ...result, recording: blob, recordingMimeType: encoded.mimeType, durationMs };
    } catch (caught) {
      const nextError = caught instanceof Error ? caught : new Error(String(caught));
      setError(nextError);
      setStatus("error");
      releaseLiveCapture();
      stopStream(streamRef.current);
      streamRef.current = null;
      throw nextError;
    }
  }, [asrClient, options.emptyAudioMessage, releaseLiveCapture]);

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
    throw new Error(emptyAudioMessage);
  }

  const dataUrl = await readBlobAsDataUrl(blob);
  const encoded = parseAudioDataUrl(dataUrl, blob.type);
  if (!encoded.audioBase64.trim()) {
    throw new Error(emptyAudioMessage);
  }
  return encoded;
}

export function mergeVoiceTranscript(current: string, transcript: string): string {
  const next = transcript.trim();
  if (!next) return current;
  const existing = current.trim();
  return existing ? `${existing}\n${next}` : next;
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
