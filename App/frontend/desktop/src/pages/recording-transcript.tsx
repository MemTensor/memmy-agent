/** Shared recording playback, transcript rendering, and session types. */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Pause, Play } from "lucide-react";
import type { AsrTranscriptSegment } from "@memmy/local-api-contracts";
import type { AsrLiveLine } from "../lib/asr-live-transcription.js";
import { useTranslation } from "../i18n/use-translation.js";
import { repairWebmDuration } from "../lib/webm-duration.js";

/** The finished transcript of a recording. */
export interface RecordingPanelTranscript {
  text: string;
  /** Speaker turns, when the upstream model separated speakers. */
  segments: AsrTranscriptSegment[];
}

/** Everything the panel needs to render, published by the recording card. */
export interface RecordingPanelSession {
  title: string;
  status: "idle" | "starting" | "recording" | "paused" | "transcribing" | "done";
  elapsedMs: number;
  /** Provisional lines from the in-progress recording, ordered by offset. */
  lines: AsrLiveLine[];
  transcript: RecordingPanelTranscript | null;
  /** Object URL of the finished recording, for playback. */
  audioUrl: string | null;
  onStart?(): void;
  onPause(): void;
  onResume(): void;
  onFinish(): void;
  onClose(): void;
}

/** The finished transcript, grouped into speaker turns. */
export function TranscriptTurns(props: { transcript: RecordingPanelTranscript; onSeek?: (ms: number) => void }): ReactNode {
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
              <button type="button" className="recording-panel__turn-time" disabled={!props.onSeek} onClick={() => props.onSeek?.(turn.startMs!)}>{formatClock(turn.startMs)}</button>
            )}
          </div>
          <p className="recording-panel__turn-text">{turn.text}</p>
        </div>
      ))}
    </div>
  );
}

/** Playback control for the finished recording. */
export function RecordingPlayer(props: { src: string; durationMs?: number; seek?: { ms: number; sequence: number } }): ReactNode {
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const fallbackDurationMs = validDurationMs(props.durationMs);
  const [durationMs, setDurationMs] = useState(fallbackDurationMs);
  const [playbackSrc, setPlaybackSrc] = useState(props.src);
  const [repairRequest, setRepairRequest] = useState<{ src: string; durationMs: number } | null>(null);
  const repairAttempted = useRef(false);
  const scrubbing = useRef(false);
  const requestedSeek = useRef<number | null>(null);
  const restorePlayback = useRef<{ ms: number; playing: boolean } | null>(null);
  useEffect(() => {
    setPlaying(false); setCurrentMs(0); setDurationMs(fallbackDurationMs); setPlaybackSrc(props.src);
    setRepairRequest(null); repairAttempted.current = false; requestedSeek.current = null;
    restorePlayback.current = null; scrubbing.current = false;
  }, [props.src, fallbackDurationMs]);

  useEffect(() => {
    if (!repairRequest || repairRequest.src !== props.src) return;
    const abort = new AbortController();
    let disposed = false;
    let repairedUrl: string | undefined;
    void (async () => {
      const response = await fetch(repairRequest.src, { signal: abort.signal });
      if (!response.ok) return;
      const blob = await response.blob();
      const repaired = await repairWebmDuration(blob, repairRequest.durationMs);
      if (disposed || repaired === blob) return;
      const audio = audioRef.current;
      restorePlayback.current = { ms: requestedSeek.current ?? (audio?.currentTime ?? 0) * 1000, playing: audio ? !audio.paused : false };
      repairedUrl = URL.createObjectURL(repaired);
      setPlaybackSrc(repairedUrl);
    })().catch(() => { /* Keep the original playable source when it cannot be repaired. */ });
    return () => { disposed = true; abort.abort(); if (repairedUrl) URL.revokeObjectURL(repairedUrl); };
  }, [repairRequest, props.src]);

  const updateMediaDuration = (audio: HTMLAudioElement) => {
    const mediaDurationMs = validDurationMs(audio.duration * 1_000);
    if (!repairAttempted.current && fallbackDurationMs > 0 && mediaDurationMs < fallbackDurationMs * .5) {
      repairAttempted.current = true;
      setRepairRequest({ src: props.src, durationMs: fallbackDurationMs });
    }
    if (mediaDurationMs === 0) return;
    // MediaRecorder WebM metadata is sometimes finite but implausibly short.
    // Never let it shorten the independently measured capture duration; for
    // uploaded files it can still extend the transcript-derived fallback.
    setDurationMs(Math.max(fallbackDurationMs, mediaDurationMs));
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !props.seek) return;
    const nextMs = Math.min(Math.max(0, props.seek.ms), durationMs || props.seek.ms);
    audio.currentTime = nextMs / 1000;
    requestedSeek.current = nextMs;
    setCurrentMs(nextMs);
    void audio.play().catch(() => setPlaying(false));
  }, [props.seek]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const followPlayback = () => {
      const audio = audioRef.current;
      if (audio && !scrubbing.current && !audio.seeking) setCurrentMs(validCurrentTimeMs(audio.currentTime));
      frame = window.requestAnimationFrame(followPlayback);
    };
    frame = window.requestAnimationFrame(followPlayback);
    return () => window.cancelAnimationFrame(frame);
  }, [playing, props.src]);

  return (
    <div className="recording-panel__player">
      <audio
        ref={audioRef}
        src={playbackSrc}
        preload="metadata"
        onTimeUpdate={(event) => { if (!scrubbing.current && !event.currentTarget.seeking) setCurrentMs(validCurrentTimeMs(event.currentTarget.currentTime)); }}
        onSeeked={(event) => {
          const actual = validCurrentTimeMs(event.currentTarget.currentTime);
          if (requestedSeek.current != null && Math.abs(actual - requestedSeek.current) < 500) requestedSeek.current = null;
          if (!scrubbing.current) setCurrentMs(actual);
        }}
        // A MediaRecorder blob can report an unknown or provisional duration,
        // so metadata only extends the independently measured fallback.
        onLoadedMetadata={(event) => {
          updateMediaDuration(event.currentTarget);
          const restore = restorePlayback.current;
          if (restore) {
            restorePlayback.current = null;
            event.currentTarget.currentTime = restore.ms / 1000;
            setCurrentMs(restore.ms);
            if (restore.playing) void event.currentTarget.play().catch(() => setPlaying(false));
          }
        }}
        onDurationChange={(event) => updateMediaDuration(event.currentTarget)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={(event) => {
          // The independently measured capture duration can be slightly
          // longer than the playable media clock. Once the media has ended,
          // treat it as semantically complete instead of leaving the thumb a
          // few percent short of the end.
          const completedDurationMs = Math.max(
            durationMs,
            validDurationMs(event.currentTarget.duration * 1_000),
            validCurrentTimeMs(event.currentTarget.currentTime),
          );
          setDurationMs(completedDurationMs);
          setCurrentMs(completedDurationMs);
          setPlaying(false);
        }}
      />
      <button
        type="button"
        className="recording-panel__player-button"
        aria-label={playing ? t("common.pause") : t("common.play")}
        onClick={() => {
          const audio = audioRef.current;
          if (!audio) return;
          if (playing) audio.pause();
          else void audio.play().catch(() => setPlaying(false));
        }}
      >
        {playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
      </button>
      <span className="recording-panel__player-time">{formatClock(currentMs)}</span>
      <input
        type="range"
        className="recording-panel__player-scrubber"
        min={0}
        max={Math.max(durationMs, 1)}
        value={durationMs > 0 ? Math.min(Math.max(currentMs, 0), durationMs) : 0}
        disabled={durationMs <= 0}
        aria-label={t("plugin.ui.audio.seek")}
        style={{ "--recording-playback-progress": `${playbackProgress(currentMs, durationMs) * 100}%` } as CSSProperties}
        onPointerDown={() => { scrubbing.current = true; }}
        onPointerUp={() => { scrubbing.current = false; }}
        onPointerCancel={() => { scrubbing.current = false; }}
        onBlur={() => { scrubbing.current = false; }}
        onChange={(event) => {
          const audio = audioRef.current;
          const nextMs = Number(event.target.value);
          requestedSeek.current = nextMs;
          setCurrentMs(nextMs);
          if (audio) audio.currentTime = nextMs / 1_000;
        }}
      />
      <span className="recording-panel__player-time">{formatClock(durationMs)}</span>
    </div>
  );
}

/** A duration is usable only when it is a positive finite millisecond count. */
function validDurationMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Invalid media clocks must never leak NaN or Infinity into a range input. */
function validCurrentTimeMs(seconds: number): number {
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 0;
}

/** Keeps the painted track inside the same 0..100% bounds as the thumb. */
function playbackProgress(currentMs: number, durationMs: number): number {
  if (!Number.isFinite(currentMs) || !Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.min(1, Math.max(0, currentMs / durationMs));
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
