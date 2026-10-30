/**
 * The recording entry in the conversation top bar, and the page it opens.
 *
 * The task panel offers a recording button beside its browser button. It opens
 * the recording page as a tab alongside file previews. The page starts on the
 * recording list, and from there the user either starts a new recording or
 * uploads one they already have. A finished recording becomes a row in that
 * list, and a row can be sent into the
 * conversation either as a summary task or as material for the current one.
 *
 * The composer opens a compact recorder; the top-bar icon opens the list.
 * They share one recording session. Sending a recording is an explicit action
 * on its row. Agent-requested recording cards remain separate inputs.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Check, MoreHorizontal, Pencil, Mic, Pause, Play, Plus, RotateCw, Sparkles, Square, Trash2, Upload, X } from "lucide-react";
import type { AsrTranscriptSegment } from "@memmy/local-api-contracts";
import type { AsrClient } from "../api/asr-client.js";
import type { UploadAgentMediaInput, UploadedAgentMedia } from "../api/memmy-agent-client.js";
import type { RecordingSidebarStatus } from "../state/app-actions.js";
import type { I18nContextValue } from "../i18n/i18n-provider.js";
import { useTranslation } from "../i18n/use-translation.js";
import { enUSMessages, zhCNMessages } from "../i18n/messages.js";
import { mergeLiveLines, type AsrLiveLine } from "../lib/asr-live-transcription.js";
import type { RecordingPanelTranscript } from "./interview-recording-panel.js";
import { formatClock, RecordingPlayer, TranscriptTurns } from "./interview-recording-panel.js";
import { blobToAudioBase64, isLiveAsrTimeout, useAsrRecorder } from "./asr-recorder.js";
import { pushWaveformLevel } from "../lib/audio-pcm-tap.js";
import { persistRecording } from "../lib/recording-deliverables.js";
import { removeRecordingArchiveEntry, saveRecordingArchiveEntry, useRecordingArchive } from "../lib/recording-archive.js";
import { handOverRecording } from "../lib/recording-handover.js";
import { usePluginTranscriptions } from "../app/plugin-ui-context.js";
import { RecordingWaveform, WAVE_BARS } from "./recording-waveform.js";

/**
 * Where a finished recording is sent.
 *
 * `summarize` opens a new task with the transcript attached, which is what the
 * design's 总结 does; `attach` adds it to the conversation already on screen,
 * which is what 添加到会话 does.
 */
export type RecordingDelivery = "summarize" | "attach";

/** Account recordings are available only to an authenticated account session. */
export function canUseAccountRecording(userMode: string | undefined, userId: string | null): boolean {
  return userMode === "account" && Boolean(userId?.trim());
}

/** A captured recording, including one whose transcription is still pending. */
export interface RecordingArchiveEntry {
  id: string;
  /** Shown as the row title. */
  title: string;
  /** ISO timestamp of when the recording finished. */
  recordedAt: string;
  durationMs: number;
  /** Distinct speakers the transcription separated. */
  speakerCount: number;
  transcript: RecordingPanelTranscript;
  /** Object URL of the audio, when it was captured here and can be played back. */
  audioUrl: string | null;
  /** Durable audio path; gateway playback URLs are renewed when reopened. */
  audioPath?: string;
  sessionKey?: string;
  files?: UploadedAgentMedia[];
  /** The plugin acknowledged these files as diagnostic materials. */
  collected?: boolean;
  /**
   * The recording was staged into the diagnosis upload card before it was
   * transcribed, so the card already lists it and delivers its transcript.
   * Staging the transcript file again would list the same interview twice.
   */
  handedOver?: boolean;
  /** The row can exist before ASR has finished, or when ASR failed. */
  status?: "transcribing" | "ready" | "failed";}

/** Everything the recording page renders. */
export interface RecordingEntrySession {
  /** Which of the page's three views is showing. */
  view: "list" | "live" | "transcript";
  status: "idle" | "starting" | "recording" | "paused" | "transcribing";
  elapsedMs: number;
  lines: AsrLiveLine[];
  levels?: number[];
  /** The recording captured in this page, once it has been transcribed. */
  live: RecordingArchiveEntry | null;
  /** Captured recordings in this session, newest first. */
  recordings: RecordingArchiveEntry[];
  /** The archive row opened for reading, when one is. */
  opened: RecordingArchiveEntry | null;
  /** Files kept for the recording that just finished. */
  deliverables: UploadedAgentMedia[];
  error: string | null;
  start(): void;
  pause(): void;
  resume(): void;
  finish(): void;
  /** Returns from the live or transcript view to 录音列表. */
  back(): void;
  /** Reopens the in-progress recorder after returning to the list. */
  showLive(): void;
  /** Opens one archive row for reading. */
  open(entry: RecordingArchiveEntry): void;
  /** Transcribes an audio file the user already has. */
  upload(file: File): void;
  /**
   * Transcribes a row again after its first attempt failed.
   *
   * The audio is kept on exactly this assumption, so a transient ASR failure
   * does not cost the user a recording.
   */
  retry?(entry: RecordingArchiveEntry): void;
  /** Row ids whose transcription is being tried again, so the row can show it. */
  retrying?: ReadonlySet<string>;
  /** Sends a recording's transcript into the conversation. */
  deliver(entry: RecordingArchiveEntry, mode: RecordingDelivery): void;
  /** Forgets the recording that just finished, ready for the next one. */
  reset(): void;
  rename?(entry: RecordingArchiveEntry, title: string): void;
  /** Delete this recording's local files, then remove its list entry. */
  remove?(entry: RecordingArchiveEntry): Promise<boolean>;
}

/** Keep the latest recording visible in the sidebar after the microphone stops. */
export function sidebarRecordingStatus(session: Pick<RecordingEntrySession, "status" | "live">): RecordingSidebarStatus {
  if (session.status === "recording" || session.status === "paused" || session.status === "starting") return session.status;
  if (session.status === "transcribing" || session.live?.status === "transcribing") return "transcribing";
  if (session.live?.status === "failed") return "failed";
  if (session.live?.status === "ready") return "ready";
  return "idle";
}

/** The sidebar row opens the recording tab; its separate transport button controls capture. */
export function applySidebarRecordingAction(
  session: Pick<RecordingEntrySession, "status" | "start" | "pause" | "resume" | "finish" | "showLive">,
  action: "open" | "control" | "finish" | null
): void {
  if (action === "finish") {
    if (session.status === "recording" || session.status === "paused") session.finish();
    return;
  }
  if (action !== "control") return;
  if (session.status === "recording") {
    session.showLive();
    session.pause();
  } else if (session.status === "paused") {
    session.showLive();
    session.resume();
  } else if (session.status === "idle") {
    session.start();
  }
}

export interface RecordingEntryController {
  open: boolean;
  compactOpen: boolean;
  toggleCompact(): void;
  closeCompact(): void;
  toggle(): void;
  close(): void;
  session: RecordingEntrySession;
  archive(entry: RecordingArchiveEntry): void;
}

/** Sends a transcript into the conversation, however the host wires that up. */
export type RecordingDeliverFn = (transcript: File, mode: RecordingDelivery) => void;

/**
 * Translator, taken from the page.
 *
 * The transcript file is written outside React, and its speaker labels are
 * user-visible, so the active language arrives as an argument.
 */
export type Translate = I18nContextValue["t"];

/**
 * Drives the top-bar recording page.
 *
 * @param asrClient Transcription client; recording is unavailable without one.
 * @param uploadFiles Host upload sink, so the recording and transcript are kept.
 * @param deliver Sends a finished transcript into the conversation.
 * @returns Open state and the session the page renders.
 */
export function useRecordingEntry(
  asrClient: AsrClient | undefined,
  uploadFiles?: (files: UploadAgentMediaInput[]) => Promise<UploadedAgentMedia[]>,
  deliver?: RecordingDeliverFn,
  archiveOptions?: {
    scope: string; sessionKey?: string; onArchived?(entry: RecordingArchiveEntry): void; resolveAudio(entry: RecordingArchiveEntry): Promise<string | null>;
    deleteFiles?(paths: string[]): Promise<void>; onRemoved?(entry: RecordingArchiveEntry): void;
    /** The recording was stored before transcription, so it can be staged for the diagnosis card now. */
    onHandedOver?(recording: { audio: UploadedAgentMedia; transcriptName: string }): void;
  },
  recordingAllowed = true
): RecordingEntryController {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  const [levels, setLevels] = useState<number[]>([]);
  const [view, setView] = useState<RecordingEntrySession["view"]>("list");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [lines, setLines] = useState<AsrLiveLine[]>([]);
  const [live, setLive] = useState<RecordingArchiveEntry | null>(null);
  const [recordings, setRecordings] = useState<RecordingArchiveEntry[]>([]);
  const archived = useRecordingArchive(archiveOptions?.scope);
  const recordingOrigin = useRef<{ sessionKey?: string } | null>(null);
  const archive = useCallback((entry: RecordingArchiveEntry) => {
    if (archiveOptions?.scope) saveRecordingArchiveEntry(archiveOptions.scope, entry);
    else setRecordings((current) => [entry, ...current.filter((row) => row.id !== entry.id)]);
  }, [archiveOptions?.scope]);
  const transcriptionJobs = usePluginTranscriptions();
  const jobStates = transcriptionJobs?.transcriptions;
  const allRecordings = useMemo(() => [...recordings.filter((row) => !archived.some((entry) => entry.id === row.id
    || (entry.audioPath && entry.audioPath === row.audioPath))), ...archived]
    // A handed-over recording is transcribed by a page-level job; its row
    // follows that job, including the retries it makes on its own.
    .map((row) => {
      const job = row.status !== "ready" && row.audioPath ? jobStates?.get(row.audioPath) : undefined;
      if (job?.status === "transcribing") return { ...row, status: "transcribing" as const };
      if (job?.status === "failed" || job?.status === "skipped") return { ...row, status: "failed" as const };
      // Saved mid-transcription and the app has since restarted: nothing is
      // transcribing it any more, so offer the row's retry instead of a
      // spinner that never ends.
      if (!job && row.status === "transcribing" && row.audioPath && archived.includes(row)) return { ...row, status: "failed" as const };
      return row;
    })
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)), [recordings, archived, jobStates]);
  const [opened, setOpened] = useState<RecordingArchiveEntry | null>(null);
  const lastScope = useRef(archiveOptions?.scope);
  useEffect(() => {
    if (lastScope.current === archiveOptions?.scope) return;
    lastScope.current = archiveOptions?.scope;
    setRecordings([]); setLive(null); setOpened(null);
  }, [archiveOptions?.scope]);
  const [deliverables, setDeliverables] = useState<UploadedAgentMedia[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [finishPending, setFinishPending] = useState(false);
  /** Rows whose transcription is being tried again, by row id. */
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(() => new Set());
  // Guards a second click before React has re-rendered with the row marked.
  const retryingRef = useRef<Set<string>>(new Set());
  const removingRef = useRef<Set<string>>(new Set());
  /**
   * Reads back the audio of a row that only has a path, for a retry.
   *
   * Gateway playback URLs are bearer capabilities and are not kept in the
   * archive, so the bytes come from the stored file rather than a stale URL.
   *
   * @param entry The failed row to re-transcribe.
   * @returns The recording's audio, ready to encode.
   */
  const resolveArchivedAudio = useCallback(async (entry: RecordingArchiveEntry): Promise<Blob> => {
    const url = entry.audioPath && archiveOptions ? await archiveOptions.resolveAudio(entry) : null;
    if (!url) throw new Error(t("recording.page.retryUnavailable"));
    const response = await fetch(url);
    if (!response.ok) throw new Error(t("recording.page.retryUnavailable"));
    return response.blob();
  }, [archiveOptions, t]);
  const startInFlight = useRef(false);
  const finishInFlight = useRef(false);
  // The transcription request outlives the click that starts it. Keeping the
  // view in a ref lets its completion preserve a deliberate return to the
  // recording list instead of unexpectedly navigating back into the transcript.
  const viewRef = useRef<RecordingEntrySession["view"]>(view);
  viewRef.current = view;
  const recorder = useAsrRecorder(asrClient, {
    live: {
      onLevel: (level) => setLevels((current) => pushWaveformLevel(current, level, WAVE_BARS)),
      onLine: (line) => setLines((current) => mergeLiveLines(current, line)),
      // Same reasoning as the plugin's recording card: a failed live segment
      // or a streaming connection that never opens must not look like nothing
      // happened. Only the first message is kept, so a doomed fallback that
      // keeps retrying every few seconds does not overwrite it with a repeat.
      onError: (liveError) => setError((current) => current ?? (isLiveAsrTimeout(liveError) ? t("plugin.ui.audio.liveTimeout") : liveError.message))
    }
  });

  useEffect(() => {
    if (recorder.status !== "recording") return;
    const timer = window.setInterval(() => setElapsedMs((current) => current + 1_000), 1_000);
    return () => window.clearInterval(timer);
  }, [recorder.status]);

  // Object URLs outlive the render that made them, so they are revoked when the
  // page goes away rather than left for the tab to collect.
  const audioUrlsRef = useRef<string[]>([]);
  useEffect(() => () => {
    for (const url of audioUrlsRef.current) URL.revokeObjectURL(url);
  }, []);

  /**
   * Stores the recording now and lets a page-level job transcribe it.
   *
   * Used when the conversation has a diagnosis to feed: the recording is
   * staged on the upload card the moment it stops, and the row here follows
   * the job until the transcript lands.
   */
  const handOver = useCallback(async (jobs: NonNullable<typeof transcriptionJobs>, sink: NonNullable<typeof uploadFiles>) => {
    const id = `rec-${Date.now()}`;
    const stopped = await recorder.stop();
    const recordedAt = new Date().toISOString();
    const title = `${t("recording.page.defaultTitle")} ${formatRecordingTitleTimestamp(recordedAt)}`;
    const durationMs = stopped.durationMs ?? elapsedMs;
    const localUrl = URL.createObjectURL(stopped.recording);
    audioUrlsRef.current.push(localUrl);
    const pending = buildEntry({ id, transcript: { text: "", segments: [] }, durationMs, audioUrl: localUrl,
      status: "transcribing", title, recordedAt });
    setLive(pending);
    setRecordings((current) => [pending, ...current.filter((row) => row.id !== id)]);
    viewRef.current = "list";
    setView("list");
    const { audio, job, transcriptName } = await handOverRecording({
      stopped, asrClient: asrClient!, uploadFiles: sink, startTranscription: jobs.startTranscription, t, diarization: true,
      emptyAudioMessage: t("home.asrEmptyAudio")
    }).catch((caught: unknown) => {
      // The audio is still in hand as a local URL, so the row's own retry
      // can transcribe it once the user asks.
      setRecordings((current) => current.map((row) => row.id === id ? { ...row, status: "failed" } : row));
      setLive((current) => current?.id === id ? { ...current, status: "failed" } : current);
      throw caught;
    });
    setRecordings((current) => current.map((row) => row.id === id ? { ...row, audioPath: audio.path } : row));
    archiveOptions?.onHandedOver?.({ audio, transcriptName });
    // The microphone is free again; the next interview need not wait for this
    // one's transcript.
    finishInFlight.current = false;
    const result = await job.wait();
    if (!result) {
      setRecordings((current) => current.map((row) => row.id === id ? { ...row, status: "failed" } : row));
      setLive((current) => current?.id === id ? { ...current, status: "failed" } : current);
      return;
    }
    const transcript: RecordingPanelTranscript = { text: result.text, segments: result.segments };
    const keptFiles = [audio, result.transcriptFile].filter((file): file is UploadedAgentMedia => file !== undefined);
    const kept: RecordingArchiveEntry = {
      ...buildEntry({ id, transcript, durationMs, audioUrl: audio.url, title, recordedAt }),
      audioPath: audio.path, files: keptFiles, handedOver: true,
      ...((recordingOrigin.current ? recordingOrigin.current.sessionKey : archiveOptions?.sessionKey) ? { sessionKey: recordingOrigin.current ? recordingOrigin.current.sessionKey : archiveOptions?.sessionKey } : {})
    };
    setRecordings((current) => current.map((row) => row.id === id ? kept : row));
    setLive((current) => current?.id === id ? kept : current);
    setDeliverables(keptFiles);
    archive(kept);
    archiveOptions?.onArchived?.(kept);
  }, [archive, archiveOptions, asrClient, elapsedMs, recorder, t]);

  const finish = useCallback(() => {
    if (finishInFlight.current || !recorder.isRecording) return;
    finishInFlight.current = true;
    setFinishPending(true);
    setError(null);
    if (transcriptionJobs && uploadFiles && asrClient && archiveOptions?.sessionKey && archiveOptions.onHandedOver) {
      void handOver(transcriptionJobs, uploadFiles)
        .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : null))
        .finally(() => { finishInFlight.current = false; setFinishPending(false); });
      return;
    }
    void (async () => {
      const id = `rec-${Date.now()}`;
      const recordedAt = new Date().toISOString();
      const title = `${t("recording.page.defaultTitle")} ${formatRecordingTitleTimestamp(recordedAt)}`;
      let audioUrl: string | null = null;
      let transcriptionCompleted = false;
      try {
        const result = await recorder.finishAndTranscribe({
          diarization: true,
          onRecordingReady: (recording, _recordingMimeType, durationMs) => {
            audioUrl = URL.createObjectURL(recording);
            audioUrlsRef.current.push(audioUrl);
            const pending = buildEntry({
              id,
              transcript: { text: "", segments: [] },
              durationMs: durationMs ?? elapsedMs,
              audioUrl,
              status: "transcribing",
              title,
              recordedAt
            });
            setLive(pending);
            setRecordings((current) => [pending, ...current.filter((row) => row.id !== id)]);
          }
        });
        if (!audioUrl) {
          audioUrl = URL.createObjectURL(result.recording);
          audioUrlsRef.current.push(audioUrl);
        }
        const transcript: RecordingPanelTranscript = { text: result.text, segments: result.segments ?? [] };
        const entry = buildEntry({
          id,
          transcript,
          durationMs: result.durationMs ?? lastOffset(transcript.segments),
          audioUrl,
          title,
          recordedAt
        });
        setLive(entry);
        setRecordings((current) => current.some((row) => row.id === id)
          ? current.map((row) => row.id === id ? entry : row)
          : [entry, ...current]);
        transcriptionCompleted = true;
        if (viewRef.current === "live") setView("transcript");
        const files = await persistRecording(result, t, uploadFiles);
        const keptFiles = [files.audio, files.transcript].filter((item): item is UploadedAgentMedia => item !== undefined);
        setDeliverables(keptFiles);
        const kept = { ...entry, audioUrl: files.audio?.url ?? entry.audioUrl, files: keptFiles,
          ...(files.audio ? { audioPath: files.audio.path } : {}),
          ...((recordingOrigin.current ? recordingOrigin.current.sessionKey : archiveOptions?.sessionKey) ? { sessionKey: recordingOrigin.current ? recordingOrigin.current.sessionKey : archiveOptions?.sessionKey } : {}) };
        setLive(kept);
        archive(kept);
        archiveOptions?.onArchived?.(kept);
      } catch (caught) {
        // The recorder surfaces its own message through `recorder.error`, which
        // the page shows. Keep the stopped audio in the list so returning to
        // the page cannot make a recording disappear just because ASR failed.
        if (!transcriptionCompleted) {
          setRecordings((current) => current.map((row) => row.id === id ? { ...row, status: "failed" } : row));
          setLive((current) => current?.id === id ? { ...current, status: "failed" } : current);
        }
        setError(caught instanceof Error ? caught.message : null);
      } finally {
        finishInFlight.current = false;
        setFinishPending(false);
      }
    })();
  }, [elapsedMs, recorder, t, uploadFiles, archive, archiveOptions?.sessionKey, archiveOptions?.onArchived, archiveOptions?.onHandedOver, asrClient, handOver, transcriptionJobs]);

  const start = useCallback(() => {
    if (!recordingAllowed || !asrClient || startInFlight.current || finishInFlight.current || recorder.isRecording || recorder.isStarting || recorder.isTranscribing) return;
    recordingOrigin.current = { sessionKey: archiveOptions?.sessionKey };
    startInFlight.current = true;
    setOpen(true);
    setLevels([]);
    setError(null);
    setLive(null);
    setElapsedMs(0);
    setLines([]);
    setDeliverables([]);
    viewRef.current = "live";
    setView("live");
    void recorder.start().catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : null);
      viewRef.current = "list";
      setView("list");
    }).finally(() => { startInFlight.current = false; });
  }, [asrClient, recorder, recordingAllowed, archiveOptions?.sessionKey]);

  const upload = useCallback((file: File) => {
    if (!recordingAllowed) return;
    if (!asrClient) {
      setError(t("plugin.ui.audio.unavailable"));
      return;
    }
    setError(null);
    setLive(null);
    viewRef.current = "live";
    setView("live");
    void (async () => {
      try {
        // Uploading an existing recording is the design's other way in: the
        // lawyer recorded on their phone, so the file arrives instead of the
        // microphone being opened.
        const encoded = await blobToAudioBase64(file, t("home.asrEmptyAudio"));
        const result = await asrClient.transcribe({
          audioBase64: encoded.audioBase64,
          mimeType: encoded.mimeType,
          diarization: true
        });
        const transcript: RecordingPanelTranscript = { text: result.text, segments: result.segments ?? [] };
        const audioUrl = URL.createObjectURL(file);
        audioUrlsRef.current.push(audioUrl);
        const entry = buildEntry({
          id: `rec-${Date.now()}`,
          transcript,
          durationMs: lastOffset(transcript.segments),
          audioUrl,
          title: file.name.replace(/\.[^.]+$/, "")
        });
        setLive(entry);
        setRecordings((current) => [entry, ...current]);
        const files = await persistRecording({ ...result, recording: file, recordingMimeType: file.type, durationMs: lastOffset(transcript.segments) }, t, uploadFiles);
        const keptFiles = [files.audio, files.transcript].filter((item): item is UploadedAgentMedia => item !== undefined);
        const kept = { ...entry, audioUrl: files.audio?.url ?? audioUrl, files: keptFiles,
          ...(files.audio ? { audioPath: files.audio.path } : {}),
          ...(archiveOptions?.sessionKey ? { sessionKey: archiveOptions.sessionKey } : {}) };
        setLive(kept); setDeliverables(keptFiles); archive(kept); archiveOptions?.onArchived?.(kept);
        if (viewRef.current === "live") {
          viewRef.current = "transcript";
          setView("transcript");
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : null);
        viewRef.current = "list";
        setView("list");
      }
    })();
  }, [asrClient, t, uploadFiles, archive, archiveOptions?.sessionKey, archiveOptions?.onArchived, recordingAllowed]);

  const retry = useCallback((entry: RecordingArchiveEntry) => {
    if (!recordingAllowed) return;
    // A handed-over recording's job already owns its transcription and will
    // finish the row itself once an attempt succeeds.
    const job = entry.audioPath ? transcriptionJobs?.transcriptionJob(entry.audioPath) : undefined;
    if (job?.state.status === "failed") {
      setError(null);
      job.retry();
      return;
    }
    if (!asrClient || retryingRef.current.has(entry.id)) {
      if (!asrClient) setError(t("plugin.ui.audio.unavailable"));
      return;
    }
    setError(null);
    // A row restored from storage is not in `recordings`, so the in-flight
    // status lives here rather than on the row: marking the row itself would
    // both miss archived rows and persist "transcribing" if the app closed.
    const start = () => retryingRef.current.add(entry.id);
    const finish = () => retryingRef.current.delete(entry.id);
    start();
    setRetrying((current) => new Set(current).add(entry.id));
    void (async () => {
      try {
        // Rows from this session still hold their Blob URL; ones restored from
        // the archive hold only a path, which has to be resolved back to audio.
        const audio = entry.audioUrl
          ? await (await fetch(entry.audioUrl)).blob()
          : await resolveArchivedAudio(entry);
        const encoded = await blobToAudioBase64(audio, t("home.asrEmptyAudio"));
        const result = await asrClient.transcribe({
          audioBase64: encoded.audioBase64,
          mimeType: encoded.mimeType,
          durationMs: entry.durationMs,
          diarization: true
        });
        const transcript: RecordingPanelTranscript = { text: result.text, segments: result.segments ?? [] };
        // ASR does not echo the duration back, so the row keeps the one the
        // recorder measured unless the new segments reach further.
        const lastSegmentMs = lastOffset(transcript.segments);
        const updated: RecordingArchiveEntry = {
          ...entry,
          transcript,
          durationMs: lastSegmentMs > 0 ? lastSegmentMs : entry.durationMs,
          speakerCount: Math.max(new Set(transcript.segments.map((segment) => segment.speakerId ?? 0)).size, 1),
          status: "ready"
        };
        archive(updated);
        setRecordings((current) => current.map((row) => row.id === entry.id ? updated : row));
        setLive((current) => current?.id === entry.id ? updated : current);
        setOpened((current) => current?.id === entry.id ? updated : current);
        archiveOptions?.onArchived?.(updated);
      } catch (caught) {
        // The row goes back to "failed" on its own, since it was never moved
        // out of that status. Only the message needs saying.
        setError(caught instanceof Error ? caught.message : null);
      } finally {
        finish();
        setRetrying((current) => {
          if (!current.has(entry.id)) return current;
          const next = new Set(current);
          next.delete(entry.id);
          return next;
        });
      }
    })();
  }, [archive, archiveOptions, asrClient, resolveArchivedAudio, t, transcriptionJobs, recordingAllowed]);

  const reset = useCallback(() => {    setLive(null);
    setElapsedMs(0);
    setLines([]);
    setDeliverables([]);
    setError(null);
    viewRef.current = "list";
    setView("list");
  }, []);

  const remove = useCallback(async (entry: RecordingArchiveEntry): Promise<boolean> => {
    if (entry.status === "transcribing" || retryingRef.current.has(entry.id) || removingRef.current.has(entry.id)) return false;
    removingRef.current.add(entry.id);
    setError(null);
    try {
      const paths = [...new Set([entry.audioPath, ...(entry.files ?? []).map((file) => file.path)]
        .filter((value): value is string => typeof value === "string" && Boolean(value)))];
      if (paths.length) {
        if (!archiveOptions?.deleteFiles) throw new Error(t("recording.page.deleteUnavailable"));
        await archiveOptions.deleteFiles(paths);
      }
      if (archiveOptions?.scope) removeRecordingArchiveEntry(archiveOptions.scope, entry.id);
      setRecordings((current) => current.filter((row) => row.id !== entry.id));
      setLive((current) => current?.id === entry.id ? null : current);
      setOpened((current) => current?.id === entry.id ? null : current);
      setDeliverables((current) => current.filter((file) => !paths.includes(file.path)));
      if (opened?.id === entry.id) { viewRef.current = "list"; setView("list"); }
      if (entry.audioUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(entry.audioUrl);
        audioUrlsRef.current = audioUrlsRef.current.filter((url) => url !== entry.audioUrl);
      }
      archiveOptions?.onRemoved?.(entry);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("recording.page.deleteFailed"));
      return false;
    } finally {
      removingRef.current.delete(entry.id);
    }
  }, [archiveOptions, opened?.id, t]);

  // A pane close changes visibility only. Reopening the list offers the active
  // recording row, so the microphone and any transcription remain reachable.
  const close = useCallback(() => {
    setOpen(false);
  }, []);

  const toggle = useCallback(() => {
    if (!open) {
      setOpened(null);
      viewRef.current = "list";
      setView("list");
    }
    setOpen(!open);
  }, [open]);

  const status: RecordingEntrySession["status"] = recorder.status === "recording"
    ? "recording"
    : recorder.status === "paused"
      ? "paused"
      : recorder.isStarting
        ? "starting"
      : recorder.isTranscribing || finishPending
        ? "transcribing"
        : "idle";

  const session = useMemo<RecordingEntrySession>(() => ({
    view,
    status,
    elapsedMs,
    lines,
    levels,
    live,
    recordings: allRecordings,
    opened,
    deliverables,
    error: !asrClient ? t("plugin.ui.audio.unavailable") : error ?? recorder.error?.message ?? null,
    start,
    pause: () => recorder.pause(),
    resume: () => recorder.resume(),
    finish,
    back: () => {
      setOpened(null);
      setError(null);
      viewRef.current = "list";
      setView("list");
    },
    showLive: () => {
      setOpened(null);
      viewRef.current = "live";
      setView("live");
    },
    open: (entry) => {
      setError(null);
      setOpened(entry);
      if (entry.audioPath && archiveOptions) {
        void archiveOptions.resolveAudio(entry).then((url) => {
          if (url) setOpened((current) => current?.id === entry.id ? { ...current, audioUrl: url } : current);
        }).catch(() => setError(t("recording.page.playbackUnavailable")));
      }
      viewRef.current = "transcript";
      setView("transcript");
    },
    upload,
    retry,
    retrying,
    remove,
    rename: (entry, title) => {
      const cleaned = title.trim().slice(0, 80);
      if (!cleaned || cleaned === entry.title) return;
      const updated = { ...entry, title: cleaned };
      archive(updated);
      setRecordings((current) => current.map((row) => row.id === entry.id ? updated : row));
      setLive((current) => current?.id === entry.id ? { ...current, title: cleaned } : current);
      setOpened((current) => current?.id === entry.id ? { ...current, title: cleaned } : current);
    },
    deliver: (entry, mode) => {
      // The file is written with the speaker labels the UI shows, so it reads
      // the same in the conversation as it did on the page.
      deliver?.(transcriptFile(entry, t), mode);
    },
    reset
  }), [
    asrClient, deliverables, elapsedMs, error, finish, lines, levels, live, opened, recorder, allRecordings, archiveOptions,
    reset, retry, retrying, remove, start, status, t, upload, deliver, view, archive
  ]);

  return {
    archive,
    open,
    compactOpen,
    toggleCompact: () => setCompactOpen((current) => !current),
    closeCompact: () => setCompactOpen(false),
    toggle,
    close,
    session
  };
}

/** Compact composer recorder; hiding it leaves the shared microphone running. */
export function RecordingEntryCard(props: {
  session: RecordingEntrySession;
  disabled?: boolean;
  onClose(): void;
  onOpenList(): void;
}): ReactNode {
  const { t } = useTranslation();
  const session = props.session;
  const recording = session.status === "recording" || session.status === "paused";
  const busy = session.status === "starting" || session.status === "transcribing";
  const levels = session.levels ?? [];
  return <div className={`recording-bar recording-bar--interview recording-entry-card${recording ? " recording-bar--live" : ""}`}>
    <span className="recording-bar__icon" aria-hidden="true"><Mic size={18} /></span>
    <p className="recording-bar__title">{recording
      ? t(session.status === "paused" ? "plugin.ui.audio.paused" : "plugin.ui.audio.recording")
      : t("recording.page.title")}</p>
    <span className="recording-bar__clock" role="timer" aria-label={t("plugin.ui.audio.elapsed")}>{formatClock(session.elapsedMs)}</span>
    <RecordingWaveform levels={levels} active={session.status === "recording"} idle={session.status === "idle"} />
    <div className="recording-bar__actions">
      {recording ? <>
        <button type="button" className="recording-bar__button" onClick={session.status === "paused" ? session.resume : session.pause}>
          {t(session.status === "paused" ? "plugin.ui.audio.resume" : "plugin.ui.audio.pause")}
        </button>
        <button type="button" className="recording-bar__button recording-bar__button--primary" onClick={session.finish}>{t("plugin.ui.audio.stop")}</button>
      </> : <button type="button" className="recording-bar__button recording-bar__button--primary"
        disabled={props.disabled || busy} onClick={session.start}>{t("plugin.ui.audio.start")}</button>}
      {session.live ? <button type="button" className="recording-bar__button" onClick={props.onOpenList}>{t("recording.page.list")}</button> : null}
      <button type="button" className="recording-bar__close" aria-label={t("plugin.ui.dismissCard")} onClick={props.onClose}><X size={16} /></button>
    </div>
    {session.status === "transcribing" ? <span className="recording-bar__note" role="status">{t("plugin.ui.audio.transcribing")}</span> : null}
    {session.error ? <span className="recording-bar__note recording-bar__note--warning" role="alert">{session.error}</span> : null}
  </div>;
}

/**
 * Renders the recording page.
 *
 * @param props The live session and the panel chrome it shares with the preview.
 * @returns The page.
 */
export function RecordingEntryPage(props: {
  session: RecordingEntrySession;
  onStart?: () => void;
  externalRecording?: { title: string; elapsedMs: number; status: string; onOpen(): void };
  uploadBlocked?: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const session = props.session;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const openMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!openMenuId) return;
    const closeOutside = (event: PointerEvent) => {
      if (!openMenuRef.current?.contains(event.target as Node)) setOpenMenuId(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenuId(null);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenuId]);
  const finishRename = (entry: RecordingArchiveEntry) => { session.rename?.(entry, renameValue); setRenaming(null); };
  const confirmDelete = async (entry: RecordingArchiveEntry) => {
    if (!session.remove || deleting) return;
    setDeleting(entry.id);
    try { if (await session.remove(entry)) setConfirmingDelete(null); }
    finally { setDeleting(null); }
  };
  // While ASR is pending, the active row above is the single source of truth.
  // Hide its archive copy until the final transcript replaces it, so returning
  // to the list never produces two rows for the same recording.
  const archiveRows = session.recordings.filter((row) => !(row.status === "transcribing" && session.status === "transcribing"));
  const failedCurrentRecording = session.live?.status === "failed";

  if (session.view === "live") return <LiveView session={session} />;
  const entry = session.opened ?? session.live;
  if (session.view === "transcript" && entry) return <TranscriptView session={session} entry={entry} />;

  return (
    <div className="recording-page">
      <header className="recording-page__bar">
        <h2 className="recording-page__title">{t("recording.page.list")}</h2>
        <div className="recording-page__controls">
          <button type="button" className="recording-panel__action" disabled={session.status !== "idle" || props.uploadBlocked || Boolean(props.externalRecording)} onClick={() => fileInputRef.current?.click()}>
            <Upload size={13} aria-hidden="true" />
            <span>{t("recording.page.upload")}</span>
          </button>
          <button
            type="button"
            className="recording-panel__action recording-panel__action--primary"
            disabled={session.status !== "idle" || Boolean(props.externalRecording)}
            onClick={props.onStart ?? session.start}
          >
            <Mic size={13} aria-hidden="true" />
            <span>{t("plugin.ui.audio.start")}</span>
          </button>
        </div>
      </header>
      <input
        ref={fileInputRef}
        className="sr-only"
        type="file"
        accept="audio/*"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) session.upload(file);
        }}
      />
      {session.error && !failedCurrentRecording ? <p className="recording-page__error" role="alert">{session.error}</p> : null}
      {props.externalRecording ? <ul className="recording-page__list"><li className="recording-page__list-row recording-page__list-row--active">
        <button type="button" className="recording-page__list-open" onClick={props.externalRecording.onOpen}>
          <span className="recording-page__list-icon"><Mic size={15} /></span>
          <span className="recording-page__list-body"><span className="recording-page__list-title">{props.externalRecording.title}</span>
            <span className="recording-page__list-meta">{t(props.externalRecording.status === "paused" ? "plugin.ui.audio.paused" : props.externalRecording.status === "transcribing" ? "plugin.ui.audio.transcribing" : "plugin.ui.audio.recording")} · {formatClock(props.externalRecording.elapsedMs)}</span>
          </span>
        </button>
      </li></ul> : null}
      {session.status !== "idle" ? (
        <ul className="recording-page__list" aria-label={t("recording.page.title")}>
          <li className="recording-page__list-row recording-page__list-row--active">
            <button type="button" className="recording-page__list-open" onClick={session.showLive}>
              <span className="recording-page__list-icon" aria-hidden="true"><Mic size={15} /></span>
              <span className="recording-page__list-body">
                <span className="recording-page__list-title">{t("recording.page.title")}</span>
                <span className="recording-page__list-meta">
                  <span>{session.status === "paused" ? t("plugin.ui.audio.paused") : session.status === "transcribing" ? t("plugin.ui.audio.transcribing") : t("plugin.ui.audio.recording")}</span>
                  <span>{t("recording.page.duration", { time: formatClock(session.elapsedMs) })}</span>
                </span>
              </span>
            </button>
            <div className="recording-page__list-actions">
              <button type="button" className="recording-page__list-action" onClick={session.showLive}>
                <ChevronRight size={13} aria-hidden="true" />
                <span>{t("recording.page.view")}</span>
              </button>
            </div>
          </li>
        </ul>
      ) : null}
      {session.status === "idle" && !props.externalRecording && archiveRows.length === 0 ? (
        <p className="recording-page__empty">{t("recording.page.hint")}</p>
      ) : archiveRows.length > 0 ? (
        <ul className="recording-page__list">
          {archiveRows.map((row) => {
            // A retry is in flight for this row, whether or not the row itself
            // carries the status (archived rows are not in `recordings`).
            const busy = session.retrying?.has(row.id) === true;
            const pending = row.status === "transcribing" || busy;
            const failed = row.status === "failed" && !busy;
            const recordedAt = formatRecordedAt(row.recordedAt);
            const displayTitle = recordingDisplayTitle(row);
            const titleContainsRecordedAt = displayTitle.endsWith(` ${formatRecordingTitleTimestamp(row.recordedAt)}`);
            return (
              <li key={row.id} className={`recording-page__list-row${!pending && !failed ? " recording-page__list-row--ready" : ""}`} data-busy={busy ? "true" : undefined}>
                <button type="button" className="recording-page__list-open" onClick={() => session.open(row)}>
                  <span className="recording-page__list-icon" aria-hidden="true"><Play size={15} /></span>
                  <span className="recording-page__list-body">
                    <span className="recording-page__list-title">{renaming === row.id ? renameValue : displayTitle}</span>
                    <span className="recording-page__list-meta">
                      {pending || failed || !titleContainsRecordedAt ? <span data-recording-status={busy ? "transcribing" : undefined}>
                        {pending ? t("plugin.ui.audio.transcribing") : failed ? t("recording.page.transcriptionFailed") : recordedAt}
                      </span> : null}
                      <span>{t("recording.page.duration", { time: formatClock(row.durationMs) })}</span>
                      {!pending && !failed ? <><span>{t("recording.page.speakers", { count: row.speakerCount })}</span><span>{t("recording.page.transcribed")}</span></> : null}
                    </span>
                  </span>
                </button>
                {renaming === row.id ? <div className="recording-page__rename">
                  <input autoFocus maxLength={80} aria-label={t("common.rename")} value={renameValue} onChange={(event) => setRenameValue(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") finishRename(row); if (event.key === "Escape") setRenaming(null); }} />
                  <button type="button" aria-label={t("plugin.ui.submit")} onClick={() => finishRename(row)}><Check size={14} /></button>
                  <button type="button" aria-label={t("common.close")} onClick={() => setRenaming(null)}><X size={14} /></button>
                </div> : null}
                {confirmingDelete === row.id && session.remove ? (
                  <div className="recording-page__delete-confirm">
                    <span>{t("recording.page.deleteLocalConfirm")}</span>
                    <button type="button" className="recording-page__delete-confirm-action" disabled={deleting === row.id}
                      onClick={() => void confirmDelete(row)}>{t("common.delete")}</button>
                    <button type="button" disabled={deleting === row.id} onClick={() => setConfirmingDelete(null)}>{t("recording.page.cancelDelete")}</button>
                  </div>
                ) : failed && (session.retry || session.remove) ? (
                  <div className="recording-page__list-actions">
                    {session.retry ? <button type="button" className="recording-page__list-action recording-page__list-action--retry" onClick={() => session.retry?.(row)}>
                      <RotateCw size={13} aria-hidden="true" />
                      <span>{t("recording.page.retry")}</span>
                    </button> : null}
                    {session.remove ? <div className="recording-page__more" ref={openMenuId === row.id ? openMenuRef : undefined}>
                      <button type="button" className="recording-page__list-action recording-page__more-trigger"
                        aria-label={`${t("recording.page.moreActions")} ${displayTitle}`} aria-haspopup="menu" aria-expanded={openMenuId === row.id}
                        onClick={() => setOpenMenuId((current) => current === row.id ? null : row.id)}><MoreHorizontal size={16} aria-hidden="true" /></button>
                      {openMenuId === row.id ? <div className="recording-page__more-menu" role="menu">
                        <button type="button" role="menuitem" onClick={() => { setOpenMenuId(null); setConfirmingDelete(row.id); }}>
                          <Trash2 size={14} aria-hidden="true" />{t("common.delete")}
                        </button>
                      </div> : null}
                    </div> : null}
                  </div>
                ) : null}
                {!pending && !failed && confirmingDelete !== row.id ? (
                  <div className="recording-page__list-actions">
                    <button type="button" className="recording-page__list-action" onClick={() => session.deliver(row, "attach")}>
                      <Plus size={13} aria-hidden="true" />
                      <span>{t("recording.page.addToChat")}</span>
                    </button>
                    <div className="recording-page__more" ref={openMenuId === row.id ? openMenuRef : undefined}>
                      <button type="button" className="recording-page__list-action recording-page__more-trigger"
                        aria-label={`${t("recording.page.moreActions")} ${displayTitle}`} aria-haspopup="menu" aria-expanded={openMenuId === row.id}
                        onClick={() => setOpenMenuId((current) => current === row.id ? null : row.id)}><MoreHorizontal size={16} aria-hidden="true" /></button>
                      {openMenuId === row.id ? <div className="recording-page__more-menu" role="menu">
                        <button type="button" role="menuitem" onClick={() => { setOpenMenuId(null); session.deliver(row, "summarize"); }}>
                          <Sparkles size={14} aria-hidden="true" />{t("recording.page.summarize")}
                        </button>
                        {session.rename ? <button type="button" role="menuitem" onClick={() => { setOpenMenuId(null); setRenaming(row.id); setRenameValue(displayTitle); }}>
                          <Pencil size={14} aria-hidden="true" />{t("common.rename")}
                        </button> : null}
                        {session.remove ? <button type="button" role="menuitem" onClick={() => { setOpenMenuId(null); setConfirmingDelete(row.id); }}>
                          <Trash2 size={14} aria-hidden="true" />{t("common.delete")}
                        </button> : null}
                      </div> : null}
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function LiveView(props: { session: RecordingEntrySession }): ReactNode {
  const { t } = useTranslation();
  const session = props.session;
  const recording = session.status === "recording" || session.status === "paused";
  const failed = session.live?.status === "failed";
  const completed = session.status === "idle" && session.live?.status === "ready";
  return (
    <div className="recording-page">
      <header className="recording-page__bar">
        <button type="button" className="recording-page__back" aria-label={t("recording.page.backToList")} onClick={session.back}>
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <h2 className="recording-page__title">{t("recording.page.title")}</h2>
        <div className="recording-page__controls">
          {recording ? (
            <>
              <button
                type="button"
                className="recording-panel__action"
                onClick={() => (session.status === "paused" ? session.resume() : session.pause())}
              >
                {session.status === "paused" ? <Play size={13} aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}
                <span>{session.status === "paused" ? t("plugin.ui.audio.resume") : t("plugin.ui.audio.pause")}</span>
              </button>
              <button type="button" className="recording-panel__action recording-panel__action--primary" onClick={session.finish}>
                <Square size={12} aria-hidden="true" />
                <span>{t("plugin.ui.audio.stop")}</span>
              </button>
            </>
          ) : null}
        </div>
      </header>
      <div className="recording-panel__status" role="status">
        {recording || session.status === "transcribing" ? <span className="recording-panel__pulse" aria-hidden="true" /> : null}
        <span>
          {failed ? t("recording.page.transcriptionFailed")
            : completed ? t("recording.page.transcribed")
            : session.status === "paused"
            ? t("plugin.ui.audio.paused")
            : session.status === "transcribing"
              ? t("plugin.ui.audio.transcribing")
              : session.status === "recording" || session.status === "starting"
                ? t("plugin.ui.audio.recording") : t("recording.page.title")}
        </span>
        <span className="recording-panel__status-time">{formatClock(session.elapsedMs)}</span>
      </div>
      <div className="recording-panel__lines">
        {session.lines.length === 0
          ? <p className="recording-panel__empty">{t("recording.page.listening")}</p>
          : session.lines.map((line) => (
            <p key={`${line.startMs}:${line.text}`} className="recording-panel__line">
              <span className="recording-panel__line-time">{formatClock(line.startMs)}</span>
              <span>{line.text}</span>
            </p>
          ))}
      </div>
      {session.error ? <p className="recording-page__error" role="alert">{session.error}</p> : null}
    </div>
  );
}

function TranscriptView(props: { session: RecordingEntrySession; entry: RecordingArchiveEntry }): ReactNode {
  const { t } = useTranslation();
  const [seek, setSeek] = useState<{ ms: number; sequence: number } | undefined>();
  const failed = props.entry.status === "failed";
  const pending = props.entry.status === "transcribing";
  const ready = !failed && !pending;
  return (
    <div className="recording-page">
      <header className="recording-page__bar">
        <button type="button" className="recording-page__back" aria-label={t("recording.page.backToList")} onClick={props.session.back}>
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <h2 className="recording-page__title">{recordingDisplayTitle(props.entry)}</h2>
        {ready || failed ? <div className="recording-page__controls">
          {ready ? <><button type="button" className="recording-panel__action" onClick={() => props.session.deliver(props.entry, "attach")}>
            <Plus size={13} aria-hidden="true" />
            <span>{t("recording.page.addToChat")}</span>
          </button>
          <button
            type="button"
            className="recording-panel__action recording-panel__action--primary"
            onClick={() => props.session.deliver(props.entry, "summarize")}
          >
            <Sparkles size={13} aria-hidden="true" />
            <span>{t("recording.page.summarize")}</span>
          </button></> : null}
          {failed && props.session.retry ? <button type="button" className="recording-panel__action recording-panel__action--primary"
            onClick={() => props.session.retry?.(props.entry)}>
            <RotateCw size={13} aria-hidden="true" /><span>{t("recording.page.retry")}</span>
          </button> : null}
        </div> : null}
      </header>
      {props.entry.audioUrl ? <RecordingPlayer src={props.entry.audioUrl} durationMs={props.entry.durationMs} seek={seek} /> : null}
      {!ready ? <div className="recording-page__transcription-state" role="status">
        {t(failed ? "recording.page.transcriptionFailed" : "plugin.ui.audio.transcribing")}
        {failed && props.session.live?.id === props.entry.id && props.session.error ? <details>
          <summary>{t("recording.page.errorDetails")}</summary>
          <p>{props.session.error}</p>
        </details> : null}
      </div> : null}
      {ready ? <p className="recording-panel__section">{t("plugin.ui.audio.transcript")}</p> : null}
      {ready ? <TranscriptTurns transcript={props.entry.transcript} onSeek={props.entry.audioUrl ? (ms) => setSeek((current) => ({ ms, sequence: (current?.sequence ?? 0) + 1 })) : undefined} /> : null}
    </div>
  );
}

/**
 * Builds an archive row from a finished transcription.
 *
 * @param input The transcription and how to label it.
 * @returns The row the list renders.
 */
function buildEntry(input: {
  id: string;
  title: string;
  recordedAt?: string;
  transcript: RecordingPanelTranscript;
  durationMs: number;
  audioUrl: string | null;
  status?: RecordingArchiveEntry["status"];
}): RecordingArchiveEntry {
  const speakers = new Set(input.transcript.segments.map((segment) => segment.speakerId ?? 0));
  return {
    id: input.id,
    title: input.title,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    durationMs: input.durationMs,
    speakerCount: input.status === "transcribing" ? 0 : Math.max(speakers.size, 1),
    transcript: input.transcript,
    audioUrl: input.audioUrl,
    status: input.status ?? "ready"
  };
}

/**
 * Renders a recording's transcript as the text file that gets sent.
 *
 * The file is rebuilt at send time rather than kept, so a row stays sendable
 * for as long as the page is open without holding a second copy of the text.
 *
 * @param entry The recording to send.
 * @returns A text file carrying the transcript.
 */
export function transcriptFile(entry: RecordingArchiveEntry, t: Translate): File {
  const lines = entry.transcript.segments.length === 0
    ? [entry.transcript.text]
    : entry.transcript.segments.map((segment) => {
      const at = segment.startMs === undefined ? "" : `[${formatClock(segment.startMs)}] `;
      const speaker = segment.speakerId === undefined
        ? ""
        : t("plugin.ui.audio.speaker", { index: segment.speakerId + 1 });
      return `${at}${speaker}${segment.text}`;
    });
  return new File([lines.join("\n")], `${recordingDisplayTitle(entry)}.txt`, { type: "text/plain" });
}

/** Give recordings saved before dated defaults a distinct label at read time. */
function recordingDisplayTitle(entry: Pick<RecordingArchiveEntry, "title" | "recordedAt">): string {
  if (entry.title !== zhCNMessages["recording.page.defaultTitle"]
    && entry.title !== enUSMessages["recording.page.defaultTitle"]) return entry.title;
  const stamp = formatRecordingTitleTimestamp(entry.recordedAt);
  return stamp ? `${entry.title} ${stamp}` : entry.title;
}

/**
 * Reads a duration off the last utterance.
 *
 * An uploaded recording has no `durationMs` — this client never recorded it —
 * and the last segment's offset is the only measure of its length the
 * transcription carries.
 *
 * @param segments Diarized utterances.
 * @returns The offset of the last utterance that reported one.
 */
function lastOffset(segments: readonly AsrTranscriptSegment[]): number {
  let end = 0;
  for (const segment of segments) {
    const at = segment.endMs ?? segment.startMs;
    if (at !== undefined && at > end) end = at;
  }
  return end;
}

/**
 * Formats a recorded-at stamp the way the list shows it.
 *
 * @param iso ISO timestamp.
 * @returns `YYYY-MM-DD HH:mm`, in the reader's own time zone.
 */
export function formatRecordedAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** Default titles include seconds so two recordings made in one minute remain distinct. */
export function formatRecordingTitleTimestamp(iso: string): string {
  const minute = formatRecordedAt(iso);
  if (!minute) return "";
  return `${minute}:${String(new Date(iso).getSeconds()).padStart(2, "0")}`;
}
