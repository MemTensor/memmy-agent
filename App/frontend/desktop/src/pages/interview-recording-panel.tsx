/**
 * Side panel for an interview recording.
 *
 * While the microphone is open it shows transcript lines as they come back, so
 * the user can tell the recording is being heard. Once the recording is
 * finished it switches to the diarized transcript and lets the user play the
 * audio back against it.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, Pause, Play, Square } from "lucide-react";
import type { AsrTranscriptSegment } from "@memmy/local-api-contracts";
import type { AsrLiveLine } from "../lib/asr-live-transcription.js";
import { useTranslation } from "../i18n/use-translation.js";
import { SidebarResizeHandle, useResizableSidebar } from "./sidebar-resize.js";

/** Shared with the workspace preview so both panels reopen at the same width. */
const RECORDING_PANEL_WIDTH_STORAGE_KEY = "memmy.interviewRecordingPanel.width";

/** The finished transcript of a recording. */
export interface RecordingPanelTranscript {
  text: string;
  /** Speaker turns, when the upstream model separated speakers. */
  segments: AsrTranscriptSegment[];
}

/** Everything the panel needs to render, published by the recording card. */
export interface RecordingPanelSession {
  title: string;
  status: "recording" | "paused" | "transcribing" | "done";
  elapsedMs: number;
  /** Provisional lines from the in-progress recording, ordered by offset. */
  lines: AsrLiveLine[];
  transcript: RecordingPanelTranscript | null;
  /** Object URL of the finished recording, for playback. */
  audioUrl: string | null;
  onPause(): void;
  onResume(): void;
  onFinish(): void;
  onClose(): void;
}

export interface InterviewRecordingPanelProps {
  session: RecordingPanelSession;
  onWidthChange?: (width: number) => void;
  toolbarEnd?: ReactNode;
  /** Measured inline size of the row this pane shares with the chat. */
  sharedRowWidth?: number | null;
  /** Space the shared row always keeps for the chat beside this pane. */
  sharedRowReservedWidth?: number;
}

/**
 * Renders the interview recording panel.
 *
 * @param props The live session and panel chrome.
 * @returns The panel.
 */
export function InterviewRecordingPanel(props: InterviewRecordingPanelProps): ReactNode {
  const { t } = useTranslation();
  const session = props.session;
  const recording = session.status === "recording" || session.status === "paused";
  const resize = useResizableSidebar({
    storageKey: RECORDING_PANEL_WIDTH_STORAGE_KEY,
    defaultWidth: 520,
    minWidth: 360,
    maxWidth: 760,
    resizeDirection: -1,
    availableWidth: props.sharedRowWidth ?? null,
    reservedPrimaryWidth: props.sharedRowReservedWidth
  });

  useEffect(() => {
    props.onWidthChange?.(resize.appliedWidth);
  }, [resize.appliedWidth, props.onWidthChange]);

  return (
    <>
      <SidebarResizeHandle
        label={t("workspaceArtifact.resize")}
        width={resize.appliedWidth}
        minWidth={resize.appliedMinWidth}
        maxWidth={resize.appliedMaxWidth}
        isResizing={resize.isResizing}
        onResizeStart={resize.beginResize}
        onResizeBy={resize.resizeBy}
      />
      <aside
        className="workspace-artifact-preview-pane workspace-artifact-preview-pane--lifted"
        style={resize.sidebarStyle}
        aria-label={session.title}
      >
      <header className="workspace-artifact-preview-toolbar">
        <button
          type="button"
          className="workspace-artifact-file-browser__toggle"
          aria-label={t("common.close")}
          title={t("common.close")}
          onClick={session.onClose}
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <p className="recording-panel__heading">{session.title}</p>
        <div className="workspace-artifact-preview-toolbar__actions">
          {recording ? (
            <>
              <button type="button" className="recording-panel__action" onClick={() => (session.status === "paused" ? session.onResume() : session.onPause())}>
                {session.status === "paused" ? <Play size={13} aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}
                <span>{session.status === "paused" ? t("plugin.ui.audio.resume") : t("plugin.ui.audio.pause")}</span>
              </button>
              <button type="button" className="recording-panel__action recording-panel__action--primary" onClick={session.onFinish}>
                <Square size={12} aria-hidden="true" />
                <span>{t("plugin.ui.audio.stop")}</span>
              </button>
            </>
          ) : null}
          {props.toolbarEnd}
        </div>
      </header>

      <div className="recording-panel__body">
        {recording ? (
          <div className="recording-panel__status" role="status">
            <span className="recording-panel__pulse" aria-hidden="true" />
            <span>{session.status === "paused" ? t("plugin.ui.audio.paused") : t("plugin.ui.audio.recording")}</span>
            <span className="recording-panel__status-time">{formatClock(session.elapsedMs)}</span>
          </div>
        ) : null}

        {session.audioUrl ? <RecordingPlayer src={session.audioUrl} /> : null}

        {session.transcript ? (
          <>
            <p className="recording-panel__section">{t("plugin.ui.audio.transcript")}</p>
            <TranscriptTurns transcript={session.transcript} />
          </>
        ) : (
          <LiveLines lines={session.lines} pending={session.status === "transcribing"} pendingLabel={t("plugin.ui.audio.transcribing")} />
        )}
      </div>
      </aside>
    </>
  );
}

/** Transcript lines from the in-progress recording. */
function LiveLines(props: { lines: AsrLiveLine[]; pending: boolean; pendingLabel: string }): ReactNode {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [props.lines.length]);

  return (
    <div className="recording-panel__lines">
      {props.lines.map((line) => (
        <p key={line.startMs} className="recording-panel__line">
          <span className="recording-panel__line-time">{formatClock(line.startMs)}</span>
          <span>{line.text}</span>
        </p>
      ))}
      {props.lines.length === 0 || props.pending ? (
        <p className="recording-panel__line recording-panel__line--pending">
          <span className="recording-panel__line-time">{formatClock(props.lines.at(-1)?.endMs ?? 0)}</span>
          <span>{props.pending ? props.pendingLabel : "…"}</span>
        </p>
      ) : null}
      <div ref={bottomRef} />
    </div>
  );
}

/** The finished transcript, grouped into speaker turns. */
function TranscriptTurns(props: { transcript: RecordingPanelTranscript }): ReactNode {
  const { t } = useTranslation();
  const turns = useMemo(() => groupSpeakerTurns(props.transcript.segments), [props.transcript.segments]);

  if (turns.length === 0) {
    return <p className="recording-panel__flat-text">{props.transcript.text}</p>;
  }

  return (
    <div className="recording-panel__turns">
      {turns.map((turn, index) => (
        <div key={`${turn.speakerId ?? "?"}:${turn.startMs ?? index}`} className="recording-panel__turn">
          <div className="recording-panel__turn-head">
            <span className="recording-panel__speaker-badge" data-speaker={(turn.speakerId ?? 0) % 6}>
              {(turn.speakerId ?? 0) + 1}
            </span>
            <span className="recording-panel__speaker-name">
              {t("plugin.ui.audio.speakerLabel", { index: (turn.speakerId ?? 0) + 1 })}
            </span>
            {turn.startMs === undefined ? null : (
              <span className="recording-panel__turn-time">{formatClock(turn.startMs)}</span>
            )}
          </div>
          <p className="recording-panel__turn-text">{turn.text}</p>
        </div>
      ))}
    </div>
  );
}

/** Playback control for the finished recording. */
function RecordingPlayer(props: { src: string }): ReactNode {
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

/** One speaker's uninterrupted stretch of the transcript. */
export interface SpeakerTurn {
  speakerId: number | undefined;
  startMs: number | undefined;
  text: string;
}

/**
 * Merges consecutive segments from the same speaker into one turn.
 *
 * Upstream returns a segment per sentence, which reads as a wall of repeated
 * speaker labels. Grouping keeps one label per stretch of speech.
 *
 * @param segments Transcript segments in order.
 * @returns Speaker turns, or an empty list when no segment carries a speaker.
 */
export function groupSpeakerTurns(segments: readonly AsrTranscriptSegment[]): SpeakerTurn[] {
  if (!segments.some((segment) => segment.speakerId !== undefined)) return [];
  const turns: SpeakerTurn[] = [];
  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    const last = turns.at(-1);
    if (last && last.speakerId === segment.speakerId) {
      last.text = `${last.text}${text}`;
      continue;
    }
    turns.push({ speakerId: segment.speakerId, startMs: segment.startMs, text });
  }
  return turns;
}

/**
 * Formats an offset as the mm:ss clock the panel shows.
 *
 * @param ms Offset in milliseconds.
 * @returns The clock text, growing to h:mm:ss past an hour.
 */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${String(minutes).padStart(2, "0")}:${seconds}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${seconds}`;
}
