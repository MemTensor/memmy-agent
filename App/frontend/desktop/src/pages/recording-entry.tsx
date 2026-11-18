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
import { createPortal } from "react-dom";
import { ChevronLeft, FileText, Loader2, MessageSquareShare, MoreHorizontal, Pencil, Mic, Pause, Play, RotateCw, Square, Trash2, Upload, X } from "lucide-react";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { Tooltip } from "../components/tooltip.js";
import { SearchField } from "../components/search-field.js";
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
import { persistRecording, persistRecordingAudio } from "../lib/recording-deliverables.js";
import { removeRecordingArchiveEntry, saveRecordingArchiveEntry, useRecordingArchive } from "../lib/recording-archive.js";
import { handOverRecording } from "../lib/recording-handover.js";
import { usePluginTranscriptions } from "../app/plugin-ui-context.js";
import { RecordingWaveform, WAVE_BARS } from "./recording-waveform.js";

/**
 * Where a finished recording is sent.
 *
 * `summarize` sends a summary request with the transcript attached;
 * `attach` stages it in the conversation already on screen,
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
  status?: "transcribing" | "ready" | "failed";
  transcriptionError?: string;
}

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

/**
 * Sends a transcript into the conversation, however the host wires that up.
 *
 * A persisted transcript is supplied separately so the conversation composer
 * can reuse its workspace path instead of uploading an identical cache copy.
 * The generated File remains the fallback for legacy rows and failed saves.
 */
export type RecordingDeliverFn = (
  transcript: File,
  mode: RecordingDelivery,
  persistedTranscript?: UploadedAgentMedia
) => void;

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
  const [finishPending, setFinishPending] = useState(false);
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
      if (job?.status === "failed") return { ...row, status: "failed" as const, transcriptionError: job.message };
      if (job?.status === "skipped") return { ...row, status: "failed" as const };
      // Saved mid-transcription and the app has since restarted: nothing is
      // transcribing it any more, so offer the row's retry instead of a
      // spinner that never ends.
      if (!job && row.status === "transcribing" && row.audioPath && archived.includes(row)
        && !(finishPending && row.id === live?.id)) return { ...row, status: "failed" as const };
      return row;
    })
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)), [recordings, archived, jobStates, finishPending, live?.id]);
  const [opened, setOpened] = useState<RecordingArchiveEntry | null>(null);
  const lastScope = useRef(archiveOptions?.scope);
  useEffect(() => {
    if (lastScope.current === archiveOptions?.scope) return;
    lastScope.current = archiveOptions?.scope;
    setRecordings([]); setLive(null); setOpened(null);
  }, [archiveOptions?.scope]);
  const [deliverables, setDeliverables] = useState<UploadedAgentMedia[]>([]);
  const [error, setError] = useState<string | null>(null);
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
    archive({ ...pending, audioPath: audio.path, files: [audio] });
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
      let pendingEntry: RecordingArchiveEntry | undefined;
      let storedAudio: UploadedAgentMedia | undefined;
      let audioPersistence: Promise<void> | undefined;
      let transcriptionCompleted = false;
      try {
        const result = await recorder.finishAndTranscribe({
          diarization: true,
          onRecordingReady: (recording, recordingMimeType, durationMs) => {
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
            pendingEntry = pending;
            setLive(pending);
            setRecordings((current) => [pending, ...current.filter((row) => row.id !== id)]);
            audioPersistence = persistRecordingAudio({ recording, recordingMimeType, transcribedAt: recordedAt }, t, uploadFiles)
              .then((audio) => {
                if (!audio || !pendingEntry) return;
                storedAudio = audio;
                pendingEntry = { ...pendingEntry, audioPath: audio.path, files: [audio] };
                archive(pendingEntry);
                setRecordings((current) => current.map((row) => row.id === id ? { ...row, audioPath: audio.path, files: [audio] } : row));
                setLive((current) => current?.id === id ? { ...current, audioPath: audio.path, files: [audio] } : current);
              }).catch(() => { /* The blob remains playable; successful transcription retries persistence below. */ });
          }
        });
        await audioPersistence;
        if (!audioUrl) {
          audioUrl = URL.createObjectURL(result.recording);
          audioUrlsRef.current.push(audioUrl);
        }
        const transcript: RecordingPanelTranscript = { text: result.text, segments: result.segments ?? [] };
        const entry: RecordingArchiveEntry = { ...buildEntry({
          id,
          transcript,
          durationMs: result.durationMs ?? lastOffset(transcript.segments),
          audioUrl,
          title,
          recordedAt
        }), ...(storedAudio ? { audioPath: storedAudio.path, files: [storedAudio] } : {}) };
        setLive(entry);
        if (storedAudio) archive(entry);
        setRecordings((current) => current.some((row) => row.id === id)
          ? current.map((row) => row.id === id ? entry : row)
          : [entry, ...current]);
        transcriptionCompleted = true;
        if (viewRef.current === "live") setView("transcript");
        const files = await persistRecording(result, t, uploadFiles, storedAudio);
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
          await audioPersistence;
          const transcriptionError = caught instanceof Error ? caught.message : t("recording.page.transcriptionFailed");
          if (pendingEntry) archive({ ...pendingEntry, status: "failed", transcriptionError });
          setRecordings((current) => current.map((row) => row.id === id ? { ...row, status: "failed", transcriptionError } : row));
          setLive((current) => current?.id === id ? { ...current, status: "failed", transcriptionError } : current);
          if (audioUrl && viewRef.current === "live") setView("transcript");
        }
        // Once a file exists, its row owns the ASR failure rather than the list header.
        setError(!audioUrl || transcriptionCompleted ? caught instanceof Error ? caught.message : null : null);
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
          status: "ready",
          transcriptionError: undefined
        };
        archive(updated);
        setRecordings((current) => current.map((row) => row.id === entry.id ? updated : row));
        setLive((current) => current?.id === entry.id ? updated : current);
        setOpened((current) => current?.id === entry.id ? updated : current);
        archiveOptions?.onArchived?.(updated);
      } catch (caught) {
        const failed: RecordingArchiveEntry = { ...entry, status: "failed",
          transcriptionError: caught instanceof Error ? caught.message : t("recording.page.transcriptionFailed") };
        archive(failed);
        setRecordings((current) => current.map((row) => row.id === entry.id ? failed : row));
        setLive((current) => current?.id === entry.id ? failed : current);
        setOpened((current) => current?.id === entry.id ? failed : current);
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
    opened: opened ? { ...(allRecordings.find((row) => row.id === opened.id) ?? opened),
      audioUrl: opened.audioUrl ?? allRecordings.find((row) => row.id === opened.id)?.audioUrl ?? null } : null,
    deliverables,
    error: !asrClient ? t("plugin.ui.audio.unavailable") : error ?? (status !== "idle" ? recorder.error?.message : null) ?? null,
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
      // the same in the conversation as it did on the page. Prefer the copy
      // already kept in the recordings folder; the generated File is the
      // fallback for legacy rows or a transcript whose save failed.
      const persistedTranscript = entry.files?.find((file) => file.kind === "file" && file.mime === "text/plain");
      deliver?.(transcriptFile(entry, t), mode, persistedTranscript);
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
  // The failed recording keeps its own status and retry in the recording list.
  // A newly opened idle composer card must not repeat that old ASR error.
  const previousTranscriptionFailed = session.status === "idle" && session.live?.status === "failed";
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
    {session.error && !previousTranscriptionFailed
      ? <span className="recording-bar__note recording-bar__note--warning" role="alert">{session.error}</span> : null}
  </div>;
}

/**
 * Renders the recording page.
 *
 * @param props The live session and the panel chrome it shares with the preview.
 * @returns The page.
 */
function recordingButtonLabelHidden(button: HTMLElement): boolean {
  const label = button.querySelector("span");
  return Boolean(label && window.getComputedStyle(label).display === "none");
}

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
  const [searchQuery, setSearchQuery] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const openMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!openMenuId) return;
    const closeOutside = (event: PointerEvent) => {
      if (!openMenuRef.current?.contains(event.target as Node)) {
        setOpenMenuId(null);
      }
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
  const archiveRows = session.recordings;
  // Once the pending file has an archive row, that row owns its progress.
  const showActiveRow = session.status !== "idle" && !(session.status === "transcribing"
    && archiveRows.some((row) => row.status === "transcribing" && (!session.live || row.id === session.live.id)));
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  const filteredRows = archiveRows.filter((row) => recordingDisplayTitle(row).toLocaleLowerCase().includes(normalizedQuery));
  const failedCurrentRecording = session.live?.status === "failed";
  const listEmpty = session.status === "idle" && !props.externalRecording && archiveRows.length === 0;

  if (session.view === "live") return <LiveView session={session} />;
  const entry = session.opened ?? session.live;
  if (session.view === "transcript" && entry) return <TranscriptView session={session} entry={entry} />;

  return (
    <div className="recording-page">
      <header className="recording-page__bar recording-page__bar--list">
        <h2 className="recording-page__title">{t("recording.page.list")}</h2>
      </header>
      {!listEmpty ? <div className="recording-page__list-toolbar">
          <SearchField className="recording-page__search" value={searchQuery} label={t("recording.page.search")}
            onChange={(value) => { setSearchQuery(value); setOpenMenuId(null); }} />
          <Tooltip content={t("recording.page.upload")} shouldShow={recordingButtonLabelHidden}><button type="button" className="recording-page__toolbar-action"
            aria-label={t("recording.page.upload")}
            disabled={session.status !== "idle" || props.uploadBlocked || Boolean(props.externalRecording)}
            onClick={() => fileInputRef.current?.click()}>
            <Upload size={16} aria-hidden="true" /><span>{t("recording.page.upload")}</span>
          </button></Tooltip>
          <Tooltip content={t("plugin.ui.audio.start")} shouldShow={recordingButtonLabelHidden}><button type="button" className="recording-page__toolbar-action recording-page__toolbar-action--start"
            aria-label={t("plugin.ui.audio.start")}
            disabled={session.status !== "idle" || Boolean(props.externalRecording)} onClick={props.onStart ?? session.start}>
            <Mic size={16} aria-hidden="true" /><span>{t("plugin.ui.audio.start")}</span>
          </button></Tooltip>
        </div> : null}
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
      {listEmpty ? (
        <div className="recording-page__empty">
          <div className="recording-page__empty-icon" aria-hidden="true"><Mic size={40} strokeWidth={1.5} /></div>
          <h3>{t("recording.page.emptyTitle")}</h3>
          <p>{t("recording.page.hint")}</p>
          <div className="recording-page__empty-actions">
            <button type="button" className="recording-panel__action recording-panel__action--primary" onClick={props.onStart ?? session.start}>
              <Mic size={14} aria-hidden="true" />{t("plugin.ui.audio.start")}
            </button>
            <button type="button" className="recording-panel__action" disabled={props.uploadBlocked} onClick={() => fileInputRef.current?.click()}>
              <Upload size={14} aria-hidden="true" />{t("recording.page.upload")}
            </button>
          </div>
        </div>
      ) : (
        <ul className="recording-page__list recording-page__list--table">
          <li className="recording-page__table-head" aria-hidden="true">
            <span>{t("recording.page.name")}</span><span>{t("recording.page.durationLabel")}</span>
          </li>
          {props.externalRecording ? <RecordingActiveRow title={props.externalRecording.title}
            status={props.externalRecording.status} elapsedMs={props.externalRecording.elapsedMs} onOpen={props.externalRecording.onOpen} /> : null}
          {showActiveRow ? <RecordingActiveRow title={session.status === "transcribing" && session.live ? recordingDisplayTitle(session.live) : t("recording.page.title")}
            status={session.status} elapsedMs={session.elapsedMs} onOpen={session.showLive}
            onPause={session.pause} onResume={session.resume} onFinish={session.finish} /> : null}
          {filteredRows.map((row) => {
            // A retry is in flight for this row, whether or not the row itself
            // carries the status (archived rows are not in `recordings`).
            const busy = session.retrying?.has(row.id) === true;
            const pending = row.status === "transcribing" || busy;
            const failed = row.status === "failed" && !busy;
            const displayTitle = recordingDisplayTitle(row);
            const body = <span className="recording-page__list-body">
              <span className="recording-page__list-name">
                {renaming === row.id ? <RecordingNameEditor title={displayTitle}
                  onSave={(name) => { session.rename?.(row, name); setRenaming(null); }} onCancel={() => setRenaming(null)} />
                  : <span className="recording-page__list-title">{displayTitle}</span>}
                {pending || failed ? <span className="recording-page__list-status" data-recording-status={pending ? "transcribing" : "failed"}>
                  {pending ? t("plugin.ui.audio.transcribing") : t("recording.page.transcriptionFailed")}
                </span> : null}
              </span>
              <span className="recording-page__list-meta">{formatClock(row.durationMs)}</span>
            </span>;
            return (
              <li key={row.id} className={`recording-page__list-row recording-page__list-row--table${!pending && !failed ? " recording-page__list-row--ready" : ""}`} data-busy={busy ? "true" : undefined}>
                {renaming === row.id ? <div className="recording-page__list-open">{body}</div>
                  : <button type="button" className="recording-page__list-open" title={displayTitle} onClick={() => session.open(row)}>{body}</button>}
                {failed && (session.retry || session.remove || session.rename) ? (
                  <div className="recording-page__list-actions">
                    {session.retry ? <button type="button" className="recording-page__list-action recording-page__list-action--retry"
                      aria-label={t("recording.page.retry")} title={t("recording.page.retry")} onClick={() => session.retry?.(row)}>
                      <RotateCw size={13} aria-hidden="true" />
                    </button> : null}
                    {session.remove || session.rename ? <div className="recording-page__more" ref={openMenuId === row.id ? openMenuRef : undefined}>
                      <button type="button" className="recording-page__list-action recording-page__more-trigger"
                        aria-label={`${t("recording.page.moreActions")} ${displayTitle}`} aria-haspopup="menu" aria-expanded={openMenuId === row.id}
                        onClick={() => setOpenMenuId((current) => current === row.id ? null : row.id)}><MoreHorizontal size={16} aria-hidden="true" /></button>
                      {openMenuId === row.id ? <div className="recording-page__more-menu" role="menu">
                        {session.rename ? <button type="button" role="menuitem" onClick={() => { setOpenMenuId(null); setRenaming(row.id); }}>
                          <Pencil size={16} aria-hidden="true" />{t("common.rename")}
                        </button> : null}
                        {session.remove ? <button type="button" role="menuitem" onClick={() => { setOpenMenuId(null); setConfirmingDelete(row.id); }}>
                          <Trash2 size={16} aria-hidden="true" />{t("common.delete")}
                        </button> : null}
                      </div> : null}
                    </div> : null}
                  </div>
                ) : null}
                {!pending && !failed ? (
                  <div className="recording-page__list-actions">
                    <Tooltip content={t("recording.page.summarize")}><button type="button" className="recording-page__list-action recording-page__summary-action" aria-label={t("recording.page.summarize")}
                      onClick={() => session.deliver(row, "summarize")}>
                      <FileText size={16} aria-hidden="true" />
                    </button></Tooltip>
                    <div className="recording-page__more" ref={openMenuId === row.id ? openMenuRef : undefined}>
                      <button type="button" className="recording-page__list-action recording-page__more-trigger"
                        aria-label={`${t("recording.page.moreActions")} ${displayTitle}`} aria-haspopup="menu" aria-expanded={openMenuId === row.id}
                        onClick={() => setOpenMenuId((current) => current === row.id ? null : row.id)}><MoreHorizontal size={16} aria-hidden="true" /></button>
                      {openMenuId === row.id ? <div className="recording-page__more-menu" role="menu">
                        <button type="button" role="menuitem" onClick={() => { setOpenMenuId(null); session.deliver(row, "attach"); }}>
                          <MessageSquareShare size={16} aria-hidden="true" />{t("recording.page.addToChat")}
                        </button>
                        {session.rename ? <button type="button" role="menuitem" onClick={() => { setOpenMenuId(null); setRenaming(row.id); }}>
                          <Pencil size={16} aria-hidden="true" />{t("common.rename")}
                        </button> : null}
                        {session.remove ? <button type="button" role="menuitem" onClick={() => { setOpenMenuId(null); setConfirmingDelete(row.id); }}>
                          <Trash2 size={16} aria-hidden="true" />{t("common.delete")}
                        </button> : null}
                      </div> : null}
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {!listEmpty && !showActiveRow && !props.externalRecording && archiveRows.length > 0 && filteredRows.length === 0
        ? <p className="recording-page__search-empty" role="status">{t("recording.page.noSearchResults")}</p> : null}
      {confirmingDelete && session.recordings.find((row) => row.id === confirmingDelete) ? <RecordingDeleteDialog
        entry={session.recordings.find((row) => row.id === confirmingDelete)!} session={session} onClose={() => setConfirmingDelete(null)} /> : null}
    </div>
  );
}

function RecordingNameEditor(props: { title: string; onSave(name: string): void; onCancel(): void }): ReactNode {
  const { t } = useTranslation();
  const [name, setName] = useState(props.title);
  const settled = useRef(false);
  const save = () => {
    if (settled.current) return;
    settled.current = true;
    if (name.trim()) props.onSave(name.trim()); else props.onCancel();
  };
  const cancel = () => { settled.current = true; props.onCancel(); };
  return <span className="recording-name-editor" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) save();
  }}>
    <input autoFocus aria-label={t("common.rename")} value={name} maxLength={80}
      onFocus={(event) => event.currentTarget.select()} onChange={(event) => setName(event.target.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") { event.preventDefault(); save(); }
        if (event.key === "Escape") { event.stopPropagation(); cancel(); }
      }} />
    <button type="button" aria-label={t("recording.page.cancelDelete")} onClick={cancel}><X size={16} aria-hidden="true" /></button>
  </span>;
}

function RecordingActiveRow(props: { title: string; status: string; elapsedMs: number; onOpen(): void; onPause?(): void; onResume?(): void; onFinish?(): void }): ReactNode {
  const { t } = useTranslation();
  return <li className="recording-page__list-row recording-page__list-row--table recording-page__list-row--active">
    <button type="button" className="recording-page__list-open" onClick={props.onOpen}>
      <span className="recording-page__list-body">
        <span className="recording-page__list-name"><span className="recording-page__name-heading"><span className="recording-page__list-title">{props.title}</span>
          {props.status === "recording" || props.status === "paused" ? <span className={`recording-page__activity app-frame-recording-wave${props.status === "recording" ? " app-frame-recording-wave--live" : ""}`} aria-hidden="true">
            <span /><span /><span /><span /><span />
          </span> : null}
        </span>
          <span className="recording-page__list-status">{t(props.status === "paused" ? "plugin.ui.audio.paused"
            : props.status === "transcribing" ? "plugin.ui.audio.transcribing" : "plugin.ui.audio.recording")}</span>
        </span>
        <span className="recording-page__list-meta">{formatClock(props.elapsedMs)}</span>
      </span>
    </button>
    {(props.status === "recording" || props.status === "paused") && props.onFinish ? <div className="recording-page__list-actions">
      <Tooltip content={t(props.status === "paused" ? "plugin.ui.audio.resume" : "plugin.ui.audio.pause")}>
        <button type="button" className="recording-page__list-action recording-page__list-action--pause"
          aria-label={t(props.status === "paused" ? "plugin.ui.audio.resume" : "plugin.ui.audio.pause")}
          onClick={props.status === "paused" ? props.onResume : props.onPause}>
          {props.status === "paused" ? <Play size={16} aria-hidden="true" />
            : <span className="app-frame-recording-pause-glyph" aria-hidden="true"><span /><span /></span>}
        </button>
      </Tooltip>
      <Tooltip content={t("plugin.ui.audio.stop")}><button type="button" className="recording-page__list-action recording-page__list-action--stop"
        aria-label={t("plugin.ui.audio.stop")} onClick={props.onFinish}><span className="app-frame-recording-stop-glyph" aria-hidden="true" /></button></Tooltip>
    </div> : null}
  </li>;
}

function RecordingDeleteDialog(props: { entry: RecordingArchiveEntry; session: RecordingEntrySession; onClose(): void }): ReactNode {
  const { t } = useTranslation();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const remove = async () => {
    if (!props.session.remove || inFlight.current) return;
    inFlight.current = true;
    setDeleting(true);
    setError(null);
    try {
      if (await props.session.remove(props.entry)) props.onClose();
      else setError(t("recording.page.deleteFailed"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("recording.page.deleteFailed"));
    } finally {
      inFlight.current = false;
      setDeleting(false);
    }
  };
  return createPortal(<ConfirmDialog open title={t("recording.page.deleteTitle")}
    message={<>{t("recording.page.deleteLocalConfirm")}{error ? <p role="alert">{error}</p> : null}</>}
    cancelLabel={t("recording.page.cancelDelete")} closeLabel={t("common.close")}
    confirmLabel={t("common.delete")} confirmVariant="danger" confirmDisabled={deleting}
    onCancel={() => { if (!inFlight.current) props.onClose(); }} onConfirm={() => void remove()} />, document.body);
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
      </header>
      <div className="recording-live" data-status={session.status}>
      <div className="recording-panel__status recording-live__status" role="status">
        {session.status === "recording" ? <span className="recording-panel__pulse" aria-hidden="true" /> : null}
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
      {recording ? <>
        <div className="recording-live__actions">
            <button type="button" className="recording-page__toolbar-action" aria-label={t(session.status === "paused" ? "plugin.ui.audio.resume" : "plugin.ui.audio.pause")}
              onClick={() => (session.status === "paused" ? session.resume() : session.pause())}>
              {session.status === "paused" ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}
              <span>{t(session.status === "paused" ? "plugin.ui.audio.resume" : "plugin.ui.audio.pause")}</span>
            </button>
            <button type="button" className="recording-page__toolbar-action recording-page__toolbar-action--start" aria-label={t("plugin.ui.audio.stop")} onClick={session.finish}>
              <Square size={16} aria-hidden="true" />
              <span>{t("plugin.ui.audio.stop")}</span>
            </button>
        </div>
      </> : null}
      </div>
      <div className="recording-page__transcript-tabs">
        <h3 className="recording-page__transcript-heading">{t("recording.page.transcriptTitle")}</h3>
      </div>
      <div className="recording-panel__lines">
        {session.lines.length === 0
          ? recording || session.status === "starting" ? <p className="recording-panel__empty">{t(session.status === "paused" ? "plugin.ui.audio.paused" : "recording.page.listening")}</p> : null
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

function RecordingDetailsMenu(props: { entry: RecordingArchiveEntry; session: RecordingEntrySession; allowAttach: boolean; onRename(): void }): ReactNode {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); triggerRef.current?.focus(); }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  return <div className="recording-page__more" ref={ref}>
    <button ref={triggerRef} type="button" className="thread-preview__action"
      aria-label={t("recording.page.moreActions")} title={t("recording.page.moreActions")}
      aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <MoreHorizontal size={16} aria-hidden="true" />
    </button>
    {open ? <div className="recording-page__more-menu" role="menu">
      {props.allowAttach ? <button type="button" role="menuitem" onClick={() => { setOpen(false); props.session.deliver(props.entry, "attach"); }}>
        <MessageSquareShare size={16} aria-hidden="true" />{t("recording.page.addToChat")}
      </button> : null}
      {props.session.rename ? <button type="button" role="menuitem" onClick={() => { setOpen(false); props.onRename(); }}>
        <Pencil size={16} aria-hidden="true" />{t("common.rename")}
      </button> : null}
      {props.session.remove ? <button type="button" role="menuitem" disabled={props.entry.status === "transcribing"}
        onClick={() => { setOpen(false); setConfirmingDelete(true); }}>
        <Trash2 size={16} aria-hidden="true" />{t("common.delete")}
      </button> : null}
    </div> : null}
    {confirmingDelete ? <RecordingDeleteDialog entry={props.entry} session={props.session} onClose={() => setConfirmingDelete(false)} /> : null}
  </div>;
}

function TranscriptView(props: { session: RecordingEntrySession; entry: RecordingArchiveEntry }): ReactNode {
  const { t } = useTranslation();
  const [seek, setSeek] = useState<{ ms: number; sequence: number } | undefined>();
  const [renaming, setRenaming] = useState(false);
  const pending = props.entry.status === "transcribing" || props.session.retrying?.has(props.entry.id) === true;
  const failed = props.entry.status === "failed" && !pending;
  const ready = !failed && !pending;
  return (
    <div className="recording-page">
      <header className="recording-page__bar recording-page__bar--detail">
        <button type="button" className="recording-page__back" aria-label={t("recording.page.backToList")} onClick={props.session.back}>
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        {renaming ? <div className="recording-page__title"><RecordingNameEditor title={recordingDisplayTitle(props.entry)}
          onSave={(name) => { props.session.rename?.(props.entry, name); setRenaming(false); }} onCancel={() => setRenaming(false)} /></div>
          : <h2 className="recording-page__title" title={recordingDisplayTitle(props.entry)}>{recordingDisplayTitle(props.entry)}</h2>}
        {ready || failed || props.session.rename || props.session.remove ? <div className="thread-preview__actions">
          {ready ? <>
            <Tooltip content={t("recording.page.summarize")}><button type="button" className="thread-preview__action recording-page__summary-action" aria-label={t("recording.page.summarize")}
              onClick={() => props.session.deliver(props.entry, "summarize")}><FileText size={16} aria-hidden="true" /></button></Tooltip>
          </> : null}
          {failed && props.session.retry ? <button type="button" className="thread-preview__action" aria-label={t("recording.page.retry")}
            title={t("recording.page.retry")} onClick={() => props.session.retry?.(props.entry)}>
            <RotateCw size={16} aria-hidden="true" />
          </button> : null}
          {ready || props.session.rename || props.session.remove
            ? <RecordingDetailsMenu entry={props.entry} session={props.session} allowAttach={ready} onRename={() => setRenaming(true)} /> : null}
        </div> : null}
      </header>
      {props.entry.audioUrl ? <RecordingPlayer src={props.entry.audioUrl} durationMs={props.entry.durationMs} seek={seek} /> : null}
      <div className="recording-page__transcript-tabs">
        <h3 className="recording-page__transcript-heading">{t("recording.page.transcriptTitle")}</h3>
      </div>
      {!ready ? <div className={`recording-page__transcription-state${pending ? " recording-page__transcription-state--pending" : ""}`} role="status">
        <span className="recording-page__transcription-label">{pending ? <Loader2 size={16} className="recording-page__transcribing-spinner" aria-hidden="true" /> : null}
          {failed ? props.entry.transcriptionError || (props.session.live?.id === props.entry.id ? props.session.error : null)
            || t("recording.page.transcriptionFailed") : t("plugin.ui.audio.transcribing")}</span>
      </div> : null}
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
