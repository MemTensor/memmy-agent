/**
 * The recording entry in the conversation top bar, and the page it opens.
 *
 * The PoC asks for a button next to the conversation title that opens the
 * recording page in the side panel and closes it on a second click. The page is
 * the one the design calls 访谈录音: it opens on 录音列表, and from there the
 * user either records an interview or uploads one they already have. A finished
 * recording becomes a row in that list, and a row can be sent into the
 * conversation either as a summary task or as material for the current one.
 *
 * Recording itself is the same `useAsrRecorder` the plugin's recording card
 * uses. The card is still the path for a recording that has to reach the
 * diagnosis; this page is for the user who wants to capture an interview
 * without a card open.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, Mic, Pause, Play, Plus, Sparkles, Square, Upload } from "lucide-react";
import type { AsrTranscriptSegment } from "@memmy/local-api-contracts";
import type { AsrClient } from "../api/asr-client.js";
import type { UploadAgentMediaInput, UploadedAgentMedia } from "../api/memmy-agent-client.js";
import type { I18nContextValue } from "../i18n/i18n-provider.js";
import { useTranslation } from "../i18n/use-translation.js";
import { mergeLiveLines, type AsrLiveLine } from "../lib/asr-live-transcription.js";
import type { RecordingPanelTranscript } from "./interview-recording-panel.js";
import { formatClock, groupSpeakerTurns } from "./interview-recording-panel.js";
import { blobToAudioBase64, isLiveAsrTimeout, useAsrRecorder } from "./asr-recorder.js";
import { persistRecording } from "../lib/recording-deliverables.js";

/**
 * Where a finished recording is sent.
 *
 * `summarize` opens a new task with the transcript attached, which is what the
 * design's 总结 does; `attach` adds it to the conversation already on screen,
 * which is what 添加到会话 does.
 */
export type RecordingDelivery = "summarize" | "attach";

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
  /** The row can exist before ASR has finished, or when ASR failed. */
  status?: "transcribing" | "ready" | "failed";
}

/** Everything the recording page renders. */
export interface RecordingEntrySession {
  /** Which of the page's three views is showing. */
  view: "list" | "live" | "transcript";
  status: "idle" | "starting" | "recording" | "paused" | "transcribing";
  elapsedMs: number;
  lines: AsrLiveLine[];
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
  /** Sends a recording's transcript into the conversation. */
  deliver(entry: RecordingArchiveEntry, mode: RecordingDelivery): void;
  /** Forgets the recording that just finished, ready for the next one. */
  reset(): void;
}

export interface RecordingEntryController {
  open: boolean;
  toggle(): void;
  close(): void;
  session: RecordingEntrySession;
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
  deliver?: RecordingDeliverFn
): RecordingEntryController {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<RecordingEntrySession["view"]>("list");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [lines, setLines] = useState<AsrLiveLine[]>([]);
  const [live, setLive] = useState<RecordingArchiveEntry | null>(null);
  const [recordings, setRecordings] = useState<RecordingArchiveEntry[]>([]);
  const [opened, setOpened] = useState<RecordingArchiveEntry | null>(null);
  const [deliverables, setDeliverables] = useState<UploadedAgentMedia[]>([]);
  const [error, setError] = useState<string | null>(null);
  // The transcription request outlives the click that starts it. Keeping the
  // view in a ref lets its completion preserve a deliberate return to the
  // recording list instead of unexpectedly navigating back into the transcript.
  const viewRef = useRef<RecordingEntrySession["view"]>(view);
  viewRef.current = view;
  const recorder = useAsrRecorder(asrClient, {
    live: {
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

  const finish = useCallback(() => {
    setError(null);
    void (async () => {
      const id = `rec-${Date.now()}`;
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
              title: t("recording.page.defaultTitle")
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
          title: t("recording.page.defaultTitle")
        });
        setLive(entry);
        setRecordings((current) => current.some((row) => row.id === id)
          ? current.map((row) => row.id === id ? entry : row)
          : [entry, ...current]);
        transcriptionCompleted = true;
        if (viewRef.current === "live") setView("transcript");
        const files = await persistRecording(result, t, uploadFiles);
        setDeliverables([files.audio, files.transcript].filter((item): item is UploadedAgentMedia => item !== undefined));
      } catch (caught) {
        // The recorder surfaces its own message through `recorder.error`, which
        // the page shows. Keep the stopped audio in the list so returning to
        // the page cannot make a recording disappear just because ASR failed.
        if (!transcriptionCompleted) {
          setRecordings((current) => current.map((row) => row.id === id ? { ...row, status: "failed" } : row));
          setLive((current) => current?.id === id ? { ...current, status: "failed" } : current);
        }
        setError(caught instanceof Error ? caught.message : null);
      }
    })();
  }, [elapsedMs, recorder, t, uploadFiles]);

  const start = useCallback(() => {
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
    });
  }, [recorder]);

  const upload = useCallback((file: File) => {
    if (!asrClient) {
      setError(t("plugin.ui.audio.unavailable"));
      return;
    }
    setError(null);
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
  }, [asrClient, t]);

  const reset = useCallback(() => {
    setLive(null);
    setElapsedMs(0);
    setLines([]);
    setDeliverables([]);
    setError(null);
    viewRef.current = "list";
    setView("list");
  }, []);

  // Closing the page while the microphone is open would leave it recording with
  // no way back to it, so closing also stops the recording.
  const close = useCallback(() => {
    if (recorder.isRecording) recorder.cancel();
    setOpen(false);
  }, [recorder]);

  const status: RecordingEntrySession["status"] = recorder.status === "recording"
    ? "recording"
    : recorder.status === "paused"
      ? "paused"
      : recorder.isStarting
        ? "starting"
      : recorder.isTranscribing
        ? "transcribing"
        : "idle";

  const session = useMemo<RecordingEntrySession>(() => ({
    view,
    status,
    elapsedMs,
    lines,
    live,
    recordings,
    opened,
    deliverables,
    error: !asrClient ? t("plugin.ui.audio.unavailable") : error ?? recorder.error?.message ?? null,
    start,
    pause: () => recorder.pause(),
    resume: () => recorder.resume(),
    finish,
    back: () => {
      setOpened(null);
      viewRef.current = "list";
      setView("list");
    },
    showLive: () => {
      setOpened(null);
      viewRef.current = "live";
      setView("live");
    },
    open: (entry) => {
      setOpened(entry);
      viewRef.current = "transcript";
      setView("transcript");
    },
    upload,
    deliver: (entry, mode) => {
      // The file is written with the speaker labels the UI shows, so it reads
      // the same in the conversation as it did on the page.
      deliver?.(transcriptFile(entry, t), mode);
    },
    reset
  }), [
    asrClient, deliverables, elapsedMs, error, finish, lines, live, opened, recorder, recordings,
    reset, start, status, t, upload, deliver, view
  ]);

  return {
    open,
    toggle: () => setOpen((current) => !current),
    close,
    session
  };
}

/**
 * Renders the recording page.
 *
 * @param props The live session and the panel chrome it shares with the preview.
 * @returns The page.
 */
export function RecordingEntryPage(props: { session: RecordingEntrySession }): ReactNode {
  const { t } = useTranslation();
  const session = props.session;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // While ASR is pending, the active row above is the single source of truth.
  // Hide its archive copy until the final transcript replaces it, so returning
  // to the list never produces two rows for the same recording.
  const archiveRows = session.recordings.filter((row) => !(row.status === "transcribing" && session.status === "transcribing"));

  if (session.view === "live") return <LiveView session={session} />;
  const entry = session.opened ?? session.live;
  if (session.view === "transcript" && entry) return <TranscriptView session={session} entry={entry} />;

  return (
    <div className="recording-page">
      <header className="recording-page__bar">
        <div className="recording-page__title">
          <span>{t("recording.page.list")}</span>
        </div>
        <div className="recording-page__controls">
          <button type="button" className="recording-panel__action" disabled={session.status !== "idle"} onClick={() => fileInputRef.current?.click()}>
            <Upload size={13} aria-hidden="true" />
            <span>{t("recording.page.upload")}</span>
          </button>
          <button
            type="button"
            className="recording-panel__action recording-panel__action--primary"
            disabled={session.status !== "idle"}
            onClick={session.start}
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
      {session.error ? <p className="recording-page__error" role="alert">{session.error}</p> : null}
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
                <Play size={13} aria-hidden="true" />
                <span>{t("plugin.ui.audio.resume")}</span>
              </button>
            </div>
          </li>
        </ul>
      ) : null}
      {session.status === "idle" && archiveRows.length === 0 ? (
        <p className="recording-page__hint">{t("recording.page.hint")}</p>
      ) : archiveRows.length > 0 ? (
        <ul className="recording-page__list">
          {archiveRows.map((row) => {
            const pending = row.status === "transcribing";
            const failed = row.status === "failed";
            return (
              <li key={row.id} className="recording-page__list-row">
                <button type="button" className="recording-page__list-open" onClick={() => session.open(row)}>
                  <span className="recording-page__list-icon" aria-hidden="true"><Mic size={15} /></span>
                  <span className="recording-page__list-body">
                    <span className="recording-page__list-title">{row.title}</span>
                    <span className="recording-page__list-meta">
                      <span>{pending ? t("plugin.ui.audio.transcribing") : failed ? t("recording.page.transcriptionFailed") : formatRecordedAt(row.recordedAt)}</span>
                      <span>{t("recording.page.duration", { time: formatClock(row.durationMs) })}</span>
                      {!pending && !failed ? <><span>{t("recording.page.speakers", { count: row.speakerCount })}</span><span>{t("recording.page.transcribed")}</span></> : null}
                    </span>
                  </span>
                </button>
                {!pending && !failed ? (
                  <div className="recording-page__list-actions">
                    <button type="button" className="recording-page__list-action" onClick={() => session.deliver(row, "summarize")}>
                      <Sparkles size={13} aria-hidden="true" />
                      <span>{t("recording.page.summarize")}</span>
                    </button>
                    <button type="button" className="recording-page__list-action" onClick={() => session.deliver(row, "attach")}>
                      <Plus size={13} aria-hidden="true" />
                      <span>{t("recording.page.addToChat")}</span>
                    </button>
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
  return (
    <div className="recording-page">
      <header className="recording-page__bar">
        <button type="button" className="recording-page__back" aria-label={t("recording.page.backToList")} onClick={session.back}>
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <div className="recording-page__title"><span>{t("recording.page.title")}</span></div>
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
        <span className="recording-panel__pulse" aria-hidden="true" />
        <span>
          {session.status === "paused"
            ? t("plugin.ui.audio.paused")
            : session.status === "transcribing"
              ? t("plugin.ui.audio.transcribing")
              : t("plugin.ui.audio.recording")}
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
  return (
    <div className="recording-page">
      <header className="recording-page__bar">
        <button type="button" className="recording-page__back" aria-label={t("recording.page.backToList")} onClick={props.session.back}>
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <div className="recording-page__title"><span>{t("recording.page.title")}</span></div>
        <div className="recording-page__controls">
          <button
            type="button"
            className="recording-panel__action recording-panel__action--primary"
            onClick={() => props.session.deliver(props.entry, "summarize")}
          >
            <Sparkles size={13} aria-hidden="true" />
            <span>{t("recording.page.summarize")}</span>
          </button>
        </div>
      </header>
      {props.entry.audioUrl ? <RecordingPlayback src={props.entry.audioUrl} /> : null}
      <p className="recording-panel__section">{t("plugin.ui.audio.transcript")}</p>
      <TranscriptTurns transcript={props.entry.transcript} />
      <div className="recording-page__footer">
        <button type="button" className="recording-panel__action" onClick={() => props.session.deliver(props.entry, "attach")}>
          <Plus size={13} aria-hidden="true" />
          <span>{t("recording.page.addToChat")}</span>
        </button>
        <button type="button" className="recording-panel__action" onClick={props.session.reset}>
          {t("recording.page.newRecording")}
        </button>
      </div>
      {props.session.deliverables.length > 0 ? (
        <div className="recording-page__deliverables">
          <p className="recording-panel__section">{t("recording.page.deliverables")}</p>
          <ul>
            {props.session.deliverables.map((item) => (
              <li key={item.path}>
                <Upload size={13} aria-hidden="true" />
                <span title={item.name}>{item.name}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function TranscriptTurns(props: { transcript: RecordingPanelTranscript }): ReactNode {
  const { t } = useTranslation();
  const turns = useMemo(() => groupSpeakerTurns(props.transcript.segments), [props.transcript.segments]);
  if (turns.length === 0) return <p className="recording-panel__flat-text">{props.transcript.text}</p>;
  return (
    <div className="recording-panel__turns">
      {turns.map((turn, index) => (
        <div key={`${turn.speakerId ?? "?"}:${turn.startMs ?? index}`} className="recording-panel__turn">
          <div className="recording-panel__turn-head">
            <span className="recording-panel__speaker-badge" data-speaker={(turn.speakerId ?? 0) % 6}>
              {(turn.speakerId ?? 0) + 1}
            </span>
            <span className="recording-panel__speaker-name">{t("plugin.ui.audio.speakerLabel", { index: (turn.speakerId ?? 0) + 1 })}</span>
            {turn.startMs === undefined ? null : <span className="recording-panel__turn-time">{formatClock(turn.startMs)}</span>}
          </div>
          <p className="recording-panel__turn-text">{turn.text}</p>
        </div>
      ))}
    </div>
  );
}

/** Playback control for a finished recording; mirrors the recording panel's. */
function RecordingPlayback(props: { src: string }): ReactNode {
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  return (
    <div className="recording-panel__player">
      <audio
        ref={audioRef}
        src={props.src}
        preload="metadata"
        onTimeUpdate={(event) => setCurrentMs(event.currentTarget.currentTime * 1_000)}
        // A MediaRecorder blob often reports an unknown duration until it has
        // been read through once, so the metadata value is only trusted when
        // it is finite.
        onLoadedMetadata={(event) => {
          const seconds = event.currentTarget.duration;
          if (Number.isFinite(seconds)) setDurationMs(seconds * 1_000);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
      <button
        type="button"
        className="recording-panel__player-button"
        aria-label={playing ? t("common.pause") : t("common.play")}
        onClick={() => {
          const audio = audioRef.current;
          if (!audio) return;
          if (playing) audio.pause();
          else void audio.play();
        }}
      >
        {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
      </button>
      <span className="recording-panel__player-time">{formatClock(currentMs)}</span>
      <input
        type="range"
        className="recording-panel__player-scrubber"
        min={0}
        max={Math.max(durationMs, 1)}
        value={Math.min(currentMs, durationMs)}
        aria-label={t("plugin.ui.audio.seek")}
        onChange={(event) => {
          const audio = audioRef.current;
          const nextMs = Number(event.target.value);
          setCurrentMs(nextMs);
          if (audio) audio.currentTime = nextMs / 1_000;
        }}
      />
      <span className="recording-panel__player-time">{formatClock(durationMs)}</span>
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
  transcript: RecordingPanelTranscript;
  durationMs: number;
  audioUrl: string | null;
  status?: RecordingArchiveEntry["status"];
}): RecordingArchiveEntry {
  const speakers = new Set(input.transcript.segments.map((segment) => segment.speakerId ?? 0));
  return {
    id: input.id,
    title: input.title,
    recordedAt: new Date().toISOString(),
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
  return new File([lines.join("\n")], `${entry.title}.txt`, { type: "text/plain" });
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
