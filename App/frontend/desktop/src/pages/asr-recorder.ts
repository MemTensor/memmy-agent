import { useCallback, useEffect, useRef, useState } from "react";
import type { AsrTranscriptionResponse } from "@memmy/local-api-contracts";
import type { AsrClient } from "../api/asr-client.js";
import { formatMessage, zhCNMessages } from "../i18n/messages.js";

const EMPTY_AUDIO_ERROR_MESSAGE = formatMessage(zhCNMessages["asr.error.emptyAudio"]);
const MICROPHONE_PERMISSION_ERROR_MESSAGE = formatMessage(zhCNMessages["asr.error.microphonePermissionDenied"]);

export type AsrRecorderStatus = "idle" | "checkingPermission" | "requestingPermission" | "starting" | "recording" | "paused" | "transcribing" | "error";
export type MicrophoneAccessStatus = "not-determined" | "granted" | "denied" | "restricted" | "unsupported";

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
  finishAndTranscribe(): Promise<AsrTranscriptionResponse>;
}

export interface EncodedAudio {
  audioBase64: string;
  mimeType: string;
}

export interface AsrRecorderOptions {
  emptyAudioMessage?: string;
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

export function useAsrRecorder(asrClient?: AsrClient, options: AsrRecorderOptions = {}): AsrRecorder {
  const [status, setStatus] = useState<AsrRecorderStatus>("idle");
  const [error, setError] = useState<Error | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number | null>(null);

  const cancel = useCallback(() => {
    stopRecorderSilently(recorderRef.current);
    recorderRef.current = null;
    chunksRef.current = [];
    startedAtRef.current = null;
    stopStream(streamRef.current);
    streamRef.current = null;
    setStatus("idle");
  }, []);

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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
      setStatus("recording");
    } catch (caught) {
      const nextError = caught instanceof Error ? caught : new Error(String(caught));
      stopRecorderSilently(recorderRef.current);
      recorderRef.current = null;
      chunksRef.current = [];
      startedAtRef.current = null;
      stopStream(streamRef.current);
      streamRef.current = null;
      setError(nextError);
      setStatus("error");
      throw nextError;
    }
  }, [asrClient, cancel]);

  const pause = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    recorder.pause();
    setStatus("paused");
  }, []);

  const resume = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== "paused") return;
    recorder.resume();
    setStatus("recording");
  }, []);

  const finishAndTranscribe = useCallback(async () => {
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
      stopStream(streamRef.current);
      streamRef.current = null;
      startedAtRef.current = null;
      const encoded = await blobToAudioBase64(blob, options.emptyAudioMessage);
      const result = await asrClient.transcribe({
        audioBase64: encoded.audioBase64,
        mimeType: encoded.mimeType,
        durationMs
      });
      chunksRef.current = [];
      setStatus("idle");
      return result;
    } catch (caught) {
      const nextError = caught instanceof Error ? caught : new Error(String(caught));
      setError(nextError);
      setStatus("error");
      stopStream(streamRef.current);
      streamRef.current = null;
      throw nextError;
    }
  }, [asrClient, options.emptyAudioMessage]);

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

  throw new MicrophonePermissionError(requestedStatus);
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
 * @returns The MediaRecorder init options.
 */
function pickRecorderOptions(): MediaRecorderOptions {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
  return mimeType ? { mimeType } : {};
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
