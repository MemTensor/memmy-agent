import type { EventCaptureSubscription, CaptureCheckpoint, CaptureRange } from "./event-capture-source.js";
import { CaptureCoverageGaps } from "./coverage-gaps.js";
import { persistedCheckpoint, type PersistedCheckpoint } from "./recorder-checkpoint.js";
import { CONTINUOUS_RECORDER_CAPABILITY, rotateRecorderOutput } from "./recorder-rotation.js";
import type { HistoryPlatformDriver, HistoryPermissions, HistoryPermission } from "./platform-driver.js";
import { collectorGate, CollectorBusyError } from "./collector-gate.js";
import { historyPermissionsReady } from "./platform-driver.js";
import { isMacNativeRuntimeSupported } from "../../computer-use/mac-native-runtime-support.js";
import {
  ObservationSettingsStore,
} from "./settings-store.js";
import {
  DEFAULT_OBSERVATION_SETTINGS,
  evaluateObservation,
  parseObservationSettings,
  type ObservationSettings,
} from "./observation-settings.js";
import {
  applicationsFromMarkdown,
  applyNarrative,
  compactEventEvidence,
  isNarrated,
  writeSegmentNarrative,
  type WeChatNameMap,
} from "./summary-writer.js";
import type { LLMRuntimeResolver } from "../../../utils/llm-runtime.js";
import { discoverMemmyOutputLanguage, type MemmyOutputLanguage } from "../../../memmy-memory/discovery.js";
import {
  alignedId,
  SIX_HOUR_MS,
  isLocalSixHourWindow,
  isSixHourWindowClosed,
  isCompletedCapturedSummary,
  rollupCoveredHistoryIds,
  sixHourWindowStart,
  buildSixHourSummary,
  instantFromId,
  type SummaryInput,
} from "./rollup.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApplicationIconReader } from "../mac/application-icon.js";
import { isPersonalWeChatHistorySupported } from "../platform.js";
import { isWindows11, listWindowsApplications } from "../win/win11.js";
import { HistoryMemoryAdapter, type HistoryEvidence, type HistorySkillGroup } from "../memory-adapter.js";
import { historyEvidenceSummary } from "../memory-evidence-summary.js";
import { isCaptureInterruptionRecord, renderSummary } from "./summarize-history.js";
import { writeWorkflowCandidate } from "../../computer-use/extract-workflow-candidate.js";
import { WeChatHistoryConsentStore, defaultWeChatConsentFile } from "../mac/wechat-consent.js";
import { WeChatMessageBatchReader, WeChatReaderError } from "../mac/wechat-message-batch.js";
import { appendWeChatMessagesToHistory } from "../mac/wechat-history-ingest.js";
import { physicalRuntimeAsset } from "../mac/native-helper.js";
import { resolveMacWeChatPython } from "../mac/wechat-python.js";
import { resolveWindowsWeChatPython } from "../win/python-runtime.js";
import { buildBrowserAuthoritySnapshot, writeBrowserAuthority, type BrowserFocusObservation } from "../browser-privacy.js";
import { appendBrowserHistoryEvent, prepareBrowserHistoryEvent,
  type BrowserHistoryCaptureIntent, type BrowserHistoryTrustedContext } from "../browser-semantic-history.js";
import { connectBrowserHistoryBridge } from "../browser-history-bridge.js";

/** The authority sidecar is a recording too: excluded page identity never goes to disk. */
export function filterHistoryAuthorityObservations(settings: ObservationSettings,
  observations: readonly BrowserFocusObservation[]): BrowserFocusObservation[] {
  return observations.map((entry) => {
    const allowed = evaluateObservation(settings, {
      bundleId: entry.browser === "edge" ? "win32.msedge" : "win32.chrome",
      browser: true, url: entry.url,
    }).observe;
    return allowed ? { ...entry, title: "" }
      : { ...entry, mode: "unknown", title: "", url: "" };
  });
}

export type ComputerHistorySourceType = "captured" | "rollup" | "imported" | "demo_fixture";

export interface WeChatReaderPreparation {
  ready: boolean;
  appPath: string | null;
  error: string | null;
}

/** Where a Mac connection step failed (path, check or call, errno), as the helper reported it. */
function weChatFailureDetail(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length || entries.length > 8
    || entries.some(([key, field]) => !/^[a-z_]{1,32}$/u.test(key) || typeof field !== "string" || field.length > 4096)) return;
  return Object.fromEntries(entries) as Record<string, string>;
}

export interface ComputerHistoryReplayPlan {
  sourcePath: string;
  sourceHash: string;
  status: "ready" | "not_replayable";
  steps: string[];
  variables: string[];
}

export interface ComputerHistoryEntry {
  id: string;
  title: string;
  /** One-paragraph account of the window, shown in the timeline. */
  description: string | null;
  /** Bundle identifiers seen during the window. */
  applications: string[];
  /** Which summary layer this entry belongs to, when it is one. */
  summaryWindow: "10min" | "6h" | null;
  /** Exact ten-minute sources verifiable from metadata or citations; empty when unknown. */
  coveredHistoryIds: string[];
  /** Memory Skill IDs explicitly linked by the optional History adapter. */
  skillMemoryIds?: string[];
  /** ID of the synced observation in the separate Memory service, when available. */
  memoryId?: string;
  /** Whether this entry's raw events are exempt from the retention window. */
  pinned: boolean;
  /** The raw event stream this summary was written from, while it still exists. */
  eventStreamPath: string | null;
  sourceType: ComputerHistorySourceType;
  createdAt: string;
  markdown: string;
  filePath: string;
  /** Whether the readable account covers the latest available source version. */
  summaryStatus?: "ready" | "pending";
  replayPlan?: ComputerHistoryReplayPlan | null;
}

export interface ComputerHistoryWorkflow {
  id: string;
  title: string;
  createdAt: string;
  markdown: string;
  filePath: string;
  sourceHistoryId: string | null;
}

export interface ComputerHistorySnapshot {
  memorySync?: { lastSyncedAt: string | null; error: string | null; skillError?: string | null };
  observation: {
    state: ObservationState;
    startedAt: string | null;
    segmentId: string | null;
    segmentStartedAt: string | null;
    error: string | null;
    /** Why the last summary kept its mechanical wording, if it did. */
    narrationError: string | null;
    narrationErrorCategory?: "quota_exhausted" | null;
    modelSource?: "account" | "byok" | null;
    permissions?: HistoryPermissions;
    captureHealth?: ComputerHistoryCaptureHealth;
  };

  histories: ComputerHistoryEntry[];
  workflows: ComputerHistoryWorkflow[];
  wechat?: {
    enabled: boolean;
    connection: "disabled" | "unavailable" | "needs_setup" | "connecting" | "connected" | "error";
    phase: string | null;
    error: string | null;
  };
  privacy: {
    screenshots: false;
    audio: false;
    rawRetentionHours: 48;
    /** Where the readable summaries live. */
    markdownDirectory: string;
    /** Where the raw per-segment event streams live, for direct inspection. */
    eventStreamDirectory: string;
  };
}

export interface ComputerHistoryCaptureHealth {
  status: "starting" | "healthy" | "degraded" | "reconnecting" | "inactive";
  lastEventAt: string | null;
  lastHeartbeatAt: string | null;
  issues: Array<{ code: string; count: number }>;
  limitations: string[];
}

export interface ComputerHistoryMatch {
  history: ComputerHistoryEntry;
  score: number;
  matchedTerms: string[];
}



// Observation is a continuous stream sliced into segments, not a set of named
// recordings, so a segment carries no title or starting URL: it is simply the
// window of time it covers.
interface SegmentState {
  child: ChildProcessWithoutNullStreams | null;
  id: string;
  directory: string;
  startedAt: string;
  eventsFile: string;
  metadataFile: string;
  historyFile: string;
  output: string;
  stoppedByUser: boolean;
  recorderStartedAtByte?: number;
}

interface RecorderFence {
  complete: boolean;
  rangeEvaluated: boolean;
  through: string;
  watermark?: PersistedCheckpoint["watermark"];
  issues?: string[];
}

/**
 * `paused` keeps the current segment open but stops writing to it, so the user
 * can step away from recording without losing the arc they were in the middle
 * of. `stopped` records nothing while every completed segment stays searchable.
 */
export type ObservationState = "running" | "paused" | "stopped" | "stopping" | "failed";

const SEGMENT_DURATION_MS = 10 * 60 * 1000;
const RECORDER_RECONNECT_DELAYS_MS = [500, 1_500, 5_000] as const;
const RECORDER_RECONNECT_STABLE_MS = 60_000;
const RECORDER_EXIT_DRAIN_MS = 1_000;
const SEGMENTS_DIRECTORY_NAME = "segments";
// Enough of a stream that a summary of it says something.
const LIVE_NARRATION_MIN_BYTES = 4_000;
const CAPTURE_HEARTBEAT_TIMEOUT_MS = 60_000;
const CAPTURE_ISSUE_RECOVERY_MS = 30_000;
const RECORDER_HEALTH_PREFIX = "[recorder-health] ";
const CAPTURE_ISSUE_CODES = new Set([
  "observer_unavailable", "observer_notifications_unavailable", "ax_snapshot_budget_exceeded",
  "ax_snapshot_failed",
  "enrichment_backlog", "helper_parse_error", "event_processing_error", "input_monitoring_unavailable",
]);

interface RetainedSegmentEvidence {
  version: 1;
  segmentId: string;
  rawBytes: number;
  rawMtimeMs: number;
  rawSha256: string;
  evidenceSha256: string;
  evidence: string;
}

function parsedRawRecords(raw: string): { records: Parameters<typeof renderSummary>[0]["records"]; malformedLines: number[] } {
  const records: Parameters<typeof renderSummary>[0]["records"] = [];
  const malformedLines: number[] = [];
  raw.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const record = JSON.parse(line);
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("invalid record");
      records.push(record);
    } catch { malformedLines.push(index + 1); }
  });
  return { records, malformedLines };
}

function completeRawEvidence(raw: Buffer): string {
  const text = raw.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(raw) || (text.length > 0 && !text.endsWith("\n"))) {
    throw new Error("Computer History raw evidence is incomplete; retaining the event stream");
  }
  // The retention compactor rejects every malformed record rather than silently
  // treating a truncated line as a complete source version.
  return compactEventEvidence(text.split("\n"), { purpose: "retention" });
}
// How many preceding windows the model is shown, so it can relate this one to them.
const PRIOR_SUMMARY_COUNT = 2;
// Reads retry every poll; only this many failures in a row ask the user to reconnect.
const WECHAT_READ_FAILURES_BEFORE_ERROR = 4;
// The saved keys no longer open the databases, so retrying cannot recover.
const WECHAT_KEY_FAILURES = new Set(["database_key_rejected", "database_key_missing", "invalid_database_key"]);
// A pinned segment keeps its raw events past the retention window.
const PIN_MARKER = ".pinned";

// Six-hour rollups reuse completed ten-minute summaries, but are narrated only
// after the whole local window closes.


interface MarkdownEntry {
  id: string;
  title: string;
  description: string | null;
  applications: string[];
  summaryWindow: "10min" | "6h" | null;
  coveredHistoryIds: string[];
  pinned: boolean;
  createdAt: string;
  markdown: string;
  filePath: string;
}

const MAX_MARKDOWN_BYTES = 512 * 1024;
const MAX_LOG_CHARS = 24_000;
const RAW_RETENTION_MS = 48 * 60 * 60 * 1000;

// Codex writes its Skysight summaries as `<utc>-<4 random chars>-10min-memory-summary.md`
// (or `-6h-`). Copies of those were dropped into the history directory during
// earlier experiments, where they are indistinguishable from Memmy's own
// captures. Memmy names its own segments `<segment id>-10min-summary.md`, with
// no random component and no "memory-", so the two cannot collide.
const CODEX_SKYSIGHT_FILE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[A-Za-z]{4}-(?:10min|6h)-memory-summary$/;

/**
 * When a segment's window started.
 *
 * Reads the recorded start time rather than trusting the directory's mtime:
 * writing a pin marker, or any other touch, would otherwise reset the clock and
 * silently grant the segment another full retention window.
 */
function segmentAgeMs(directory: string): number {
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, "metadata.json"), "utf8"));
    const startedAt = Date.parse(metadata?.startedAt ?? "");
    if (!Number.isNaN(startedAt)) return startedAt;
  } catch {
    // Recordings from before segments carried metadata fall back to mtime.
  }
  return fs.statSync(directory).mtimeMs;
}

export function isCodexSkysightCopy(historyId: string): boolean {
  return CODEX_SKYSIGHT_FILE.test(historyId);
}

/**
 * The moment a summary is about, in order of how well each source knows it.
 *
 * The id carries the start of the window it covers and never changes; imported
 * context carries `captured_at`; only a summary with neither is dated by its
 * file, which is a guess and the reason this exists.
 */
function entryInstant(id: string, markdown: string, modifiedAt: Date): string {
  const fromId = instantFromId(id);
  if (fromId) return fromId.toISOString();
  const captured = readFrontmatterValue(markdown, "captured_at");
  if (captured) {
    const parsed = new Date(captured);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return modifiedAt.toISOString();
}

/** Whether this summary is one the machine produced and the model must write. */
interface CachedEntry {
  mtimeMs: number;
  size: number;
  entry: MarkdownEntry;
}

/**
 * The snapshot as the desktop client receives it: every summary without its
 * markdown body.
 *
 * The timeline renders a title, a description and applications, never the
 * body, yet the body was most of every response — and the client asks for one
 * every 1.5 seconds while recording, from a history that is never trimmed.
 * The agent tools read the service in process and still see everything.
 */
export function clientSnapshot(snapshot: ComputerHistorySnapshot): ComputerHistorySnapshot {
  return {
    ...snapshot,
    histories: snapshot.histories.map((entry) => {
      const sent: Partial<ComputerHistoryEntry> = { ...entry };
      delete sent.markdown;
      return sent as ComputerHistoryEntry;
    }),
  };
}

function isMachineSummary(sourceType: ComputerHistorySourceType): boolean {
  return sourceType === "captured" || sourceType === "rollup";
}

/**
 * Whether a segment recorded anything the user did.
 *
 * Every segment opens with a `recording_started` event, so a segment in which
 * nothing was observed — the Mac locked overnight, or every application
 * excluded — is never empty. Summarizing it anyway wrote "no activity" into
 * the timeline every ten minutes for as long as nobody was there.
 */
function rawHasEvidence(text: string): boolean {
  return text.split("\n").some((line) => {
    if (!line.trim()) return false;
    try {
      const record = JSON.parse(line);
      if (!record || typeof record !== "object" || Array.isArray(record)) return false;
      return isCaptureInterruptionRecord(record) || (record.recordType === "human_event"
        && typeof record.eventType === "string" && record.eventType.length > 0
        && !["recording_started", "recording_stopped", "recording_checkpoint"].includes(record.eventType));
    } catch { return false; }
  });
}

// A failed recorder may have no activity to describe. Its failure evidence
// must still be searchable and checkpointed before raw retention expires.
function segmentHasActivity(eventsFile: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(eventsFile, "utf8");
  } catch {
    return false;
  }
  return rawHasEvidence(text);
}

function lastRecordedEvent(raw: string): Record<string, unknown> | null {
  for (const line of raw.trimEnd().split("\n").reverse()) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.recordType === "human_event") return record;
    } catch { return null; }
  }
  return null;
}

function recordingEnded(raw: string): boolean {
  return lastRecordedEvent(raw)?.eventType === "recording_stopped";
}

function recorderUserStopReason(file: string, startedAtByte: number): string | null {
  try {
    const raw = fs.readFileSync(file);
    if (raw.length <= startedAtByte) return null;
    const last = lastRecordedEvent(raw.subarray(startedAtByte).toString("utf8"));
    const details = last?.details as { reason?: unknown } | undefined;
    const reason = String(details?.reason);
    return last?.eventType === "recording_stopped"
      && ["stop_hotkey", "user_stop", "user_interrupt"].includes(reason) ? reason : null;
  } catch { return null; }
}

function isHistoryStreamDisconnect(message: string): boolean {
  return /(?:^|\n)Memmy (?:Computer (?:History stream disconnected unexpectedly|Use\.app closed the History connection)|Windows History stream disconnected unexpectedly)\.(?:\r?$)/m.test(message);
}

/** Whether the summary on disk has already been written by the model. */
function isSummaryWritten(file: string): boolean {
  try {
    return isNarrated(fs.readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

function boundedInterval(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

export class ComputerHistoryDemoService {
  private readonly eventSubscriptions = new Set<string>();
  private eventCaptureIntent: "running" | "paused" | "stopped" | null = null;
  private eventCaptureBootstrap: "paused" | "stopped" | null = null;
  private eventCaptureOperation: Promise<unknown> = Promise.resolve();
  get eventCaptureActive(): boolean { return this.eventSubscriptions.size > 0; }

  /** Share the existing authorized stream, including across ten-minute rotations. */
  acquireEventCapture(): Promise<EventCaptureSubscription> {
    return this.serializeEventCapture(async () => {
      if (this.shuttingDown) throw new ComputerHistoryApiError(409, "capture_shutting_down");
      if (this.recorderTransition) await this.recorderTransition;
      const prior = this.eventCaptureIntent ?? (this.observationState === "running" ? "running" : this.observationState === "paused" ? "paused" : "stopped");
      if (this.observationState !== "running") {
        this.eventCaptureBootstrap = prior === "running" ? null : prior;
        try {
          await this.startObservationWithPermissions(this.observationState === "paused", true);
          if ((this.observationState as ObservationState) !== "running") throw new ComputerHistoryApiError(403, "capture_permission_required");
        } finally { this.eventCaptureBootstrap = null; }
      }
      if (this.shuttingDown || this.observationState !== "running" || !this.segment?.child) throw new ComputerHistoryApiError(503, "capture_not_running");
      this.eventCaptureIntent ??= prior;
      this.saveRecordingIntent(this.eventCaptureIntent);
      const id = crypto.randomUUID(); this.eventSubscriptions.add(id);
      let released = false;
      return {
        checkpoint: range => this.eventCheckpoint(() => released, range),
        release: () => this.serializeEventCapture(async () => {
          if (released) return; released = true; this.eventSubscriptions.delete(id);
          if (this.eventSubscriptions.size) return;
          const intent = this.eventCaptureIntent; this.eventCaptureIntent = null;
          if (intent === "running" || this.shuttingDown) return;
          if (intent === "paused" && this.observationState === "running") await this.pauseObservation();
          else if (this.observationState !== "stopped") await this.stopObservation();
        })
      };
    });
  }
  private serializeEventCapture<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.eventCaptureOperation.catch(() => undefined).then(operation);
    this.eventCaptureOperation = next; return next;
  }
  private historyLease: (() => void) | null = null;
  private async eventCheckpoint(released: () => boolean, range?: CaptureRange, attempt = 0,
    through = range?.through ?? new Date().toISOString()): Promise<CaptureCheckpoint> {
    if (range && (!Number.isFinite(Date.parse(range.from)) || !Number.isFinite(Date.parse(through)) || Date.parse(through) < Date.parse(range.from))) throw new Error("capture_invalid_range");
    if (this.recorderTransition) await this.recorderTransition;
    const segment = this.segment;
    const child = segment?.child;
    const streams: CaptureCheckpoint["streams"] = [];
    if (fs.existsSync(this.segmentsDirectory)) for (const entry of fs.readdirSync(this.segmentsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const file = path.join(this.segmentsDirectory, entry.name, "events.jsonl");
      try { const stat = fs.lstatSync(file); if (stat.isFile() && !stat.isSymbolicLink()) streams.push({ id: entry.name, file, size: stat.size }); } catch { /* A rotated empty segment is not a stream. */ }
    }
    const fence: RecorderFence = child ? await this.checkpointRecorder(child, range, through) : { complete: false, rangeEvaluated: false, through };
    // Rotation may begin after the preflight above, while the old writer is
    // acknowledging this fence. Its detached child is not a stopped lease.
    // Wait for the transition and fence the replacement writer, retaining the
    // original cutoff and any coverage gaps. Bound retries if writers churn.
    if (this.recorderTransition || this.segment !== segment || this.segment?.child !== child) {
      if (this.recorderTransition) await this.recorderTransition;
      if (attempt < 2 && !released() && !this.shuttingDown
        && this.observationState === "running" && this.segment?.child) {
        return this.eventCheckpoint(released, range, attempt + 1, through);
      }
    }
    if (fence.watermark && segment) {
      // Use the position captured by the writer at the native marker, not a later stat.
      // A post-marker observation may be written before stdout delivers the acknowledgement.
      const stream = streams.find(value => value.file === segment.eventsFile);
      try {
        const stat = fs.lstatSync(segment.eventsFile);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size < fence.watermark.bytes) throw new Error();
        if (stream) stream.size = fence.watermark.bytes;
        else streams.push({ id: segment.id, file: segment.eventsFile, size: fence.watermark.bytes });
      } catch { fence.complete = false; fence.watermark = undefined; }
    } else {
      // Legacy recorders have no byte watermark; retain their existing snapshot behavior.
      streams.length = 0;
      if (fs.existsSync(this.segmentsDirectory)) for (const entry of fs.readdirSync(this.segmentsDirectory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const file = path.join(this.segmentsDirectory, entry.name, "events.jsonl");
        try { const stat = fs.lstatSync(file); if (stat.isFile() && !stat.isSymbolicLink()) streams.push({ id: entry.name, file, size: stat.size }); } catch { /* A rotated empty segment is not a stream. */ }
      }
    }
    const health = this.captureHealth();
    const rangeEvaluated = fence.rangeEvaluated;
    const issues = [...new Set([
      ...(range ? this.captureCoverageGaps.within(Date.parse(range.from), Date.parse(fence.through)) : []),
      ...(!rangeEvaluated ? health.issues.map(issue => issue.code) : []),
    ])];
    const heartbeat = this.captureLastHeartbeatAt && Date.parse(this.captureLastHeartbeatAt);
    if (range && rangeEvaluated && heartbeat && heartbeat + CAPTURE_HEARTBEAT_TIMEOUT_MS < Date.parse(fence.through)) issues.push("heartbeat_missing");
    // Coverage errors describe an unreadable foreground window or a restarting
    // UIA provider, not the lifetime of the shared collector. Ending the lease
    // here would turn a recoverable snapshot error into a real recording stop.
    const current = this.segment?.child;
    const boundaryConfirmed = current === child && (fence.complete || (!!fence.watermark && !fence.issues?.includes("native_checkpoint_incomplete")));
    return { streams: streams.sort((a, b) => a.id.localeCompare(b.id)),
      running: !released() && this.observationState === "running" && !this.shuttingDown && !!current
        && current.exitCode === null && current.signalCode === null,
      rangeEvaluated,
      boundaryConfirmed,
      complete: fence.complete && current === child && issues.length === 0 && !fence.issues?.length
        && (rangeEvaluated || (this.captureObserverReadyAt > 0 && health.status === "healthy")),
      limitations: [...health.limitations,
        ...[...new Set([...issues, ...(fence.issues ?? [])])].map(code => `Capture coverage is incomplete (${code}).`),
        ...(!rangeEvaluated && this.captureObserverReadyAt === 0 ? ["The accessibility observer is still starting; no readable window has been confirmed yet."] : []),
        ...(!boundaryConfirmed ? ["The native-to-disk checkpoint could not be confirmed; the fragment may omit pending observations."] : [])] };
  }
  private readonly captureCoverageGaps = new CaptureCoverageGaps();
  private readonly captureCheckpoints = new WeakMap<ChildProcessWithoutNullStreams, Map<string, Promise<RecorderFence>>>();
  private checkpointRecorder(child: ChildProcessWithoutNullStreams, range?: CaptureRange, through = new Date().toISOString()): Promise<RecorderFence> {
    let requests = this.captureCheckpoints.get(child);
    if (!requests) { requests = new Map(); this.captureCheckpoints.set(child, requests); }
    const key = range ? `${range.from}/${range.through ?? "live"}` : "latest";
    const existing = requests.get(key); if (existing) return existing;
    const id = crypto.randomUUID();
    const request = new Promise<RecorderFence>(resolve => {
      let buffered = "", done = false;
      const finish = (complete: boolean, rangeEvaluated = false, durable?: PersistedCheckpoint) => {
        if (done) return; done = true; clearTimeout(timer);
        child.stdout.off("data", onData); child.off("exit", failed); child.off("error", failed);
        resolve({ complete, rangeEvaluated, through, ...(durable ? { watermark: durable.watermark, issues: durable.issues } : {}) });
      };
      const failed = () => finish(false);
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        if (buffered.length > 32_768) buffered = buffered.slice(-16_384);
        let end: number;
        while ((end = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
          if (!line.startsWith("[recorder-checkpoint] ")) continue;
          try {
            const result = JSON.parse(line.slice(22));
            if (result.id !== id) continue;
            if (result.watermark !== undefined) {
              const durable = persistedCheckpoint.parse(result);
              if (range && durable.through !== through) return failed();
              finish(durable.complete, durable.rangeEvaluated, durable);
            } else finish(result.complete === true, result.rangeEvaluated === true);
          } catch { /* Only the requested checkpoint is accepted. */ }
        }
      };
      const timer = setTimeout(failed, 12_000); timer.unref();
      child.stdout.on("data", onData); child.once("exit", failed); child.once("error", failed);
      if (!child.stdin.writable || child.exitCode !== null || child.signalCode !== null) return failed();
      child.stdin.write(`${JSON.stringify({ kind: "checkpoint", id, ...(range ? { ...range, through } : {}) })}\n`, error => { if (error) failed(); });
    });
    requests.set(key, request);
    void request.finally(() => { if (requests!.get(key) === request) requests!.delete(key); });
    return request;
  }

  private readonly recorderScript: string;
  private readonly historyDirectory: string;
  private readonly recordingDirectory: string;
  private readonly workflowDirectory: string;
  // Windows only: current extension metadata corroborates native window proof.
  private readonly browserAuthorityPath: string;
  private browserAuthorityTimer: ReturnType<typeof setInterval> | null = null;
  private browserAuthorityEnabled = false;
  private browserAuthoritySuspended = true;
  private browserAuthorityCleared = false;
  private publishBrowserAuthority: (() => void) | null = null;
  private readonly browserEventIds = new Set<string>();
  private browserHistoryBridge: ReturnType<typeof connectBrowserHistoryBridge> | null = null;
  private readonly liveSummaryIntervalMs: number;
  private segment: SegmentState | null = null;
  private readonly recorderSegments = new WeakMap<ChildProcessWithoutNullStreams, SegmentState>();
  private readonly continuousRecorderChildren = new WeakSet<ChildProcessWithoutNullStreams>();
  private observationState: ObservationState = "stopped";
  private observationStartedAt: string | null = null;
  private observationError: string | null = null;
  private rotationTimer: ReturnType<typeof setTimeout> | null = null;
  private recorderTransition: Promise<void> | null = null;
  private readonly recorderChildren = new Set<ChildProcessWithoutNullStreams>();
  private readonly recorderExits = new Map<ChildProcessWithoutNullStreams, Promise<void>>();
  private recorderReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private recorderReconnectVersion = 0;
  private recorderReconnectAttempts = 0;
  private recorderStableSince: number | null = null;
  private recorderExitDrain: { child: ChildProcessWithoutNullStreams; cancel: () => void } | null = null;
  private captureObserverStartedAt: number | null = null;
  private captureLastEventAt: string | null = null;
  private captureLastHeartbeatAt: string | null = null;
  // Older Windows recorders report written events without native heartbeats.
  // Once this run proves heartbeat support, preserve that expectation across
  // segment rotations rather than treating new event output as liveness.
  private captureHeartbeatSupported = false;
  private captureObserverReadyAt = 0;
  private captureSnapshotReadyAt = 0;
  private captureInputReadyAt = 0;
  private captureHealthGeneration = 0;
  private readonly captureHealthDrainingChildren = new Set<ChildProcessWithoutNullStreams>();
  private readonly captureIssues = new Map<string, { count: number; lastAt: number; active: boolean }>();
  private readonly observationSettings: ObservationSettingsStore;
  private readonly platformDriver?: HistoryPlatformDriver;
  private readonly memoryAdapter: HistoryMemoryAdapter;
  private readonly skillGroupCache = new Map<string, { revision: string; group: HistorySkillGroup | null }>();
  private readonly applicationIcons: ApplicationIconReader;
  private llmRuntime: LLMRuntimeResolver | null = null;
  private readonly summaryLanguage: () => MemmyOutputLanguage | undefined;
  /** Coalesce only an active pass, so failures remain eligible for retry. */
  private backfill: Promise<number> | null = null;
  private summaryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  /** A deletion or a newer input invalidates every older model response. */
  private readonly summaryVersions = new Map<string, number>();
  private readonly summaryJobs = new Map<string, {
    version: number;
    runtime: LLMRuntimeResolver;
    language: MemmyOutputLanguage | undefined;
    promise: Promise<boolean>;
  }>();
  private narrationError: string | null = null;
  private narrationErrorCategory: "quota_exhausted" | null = null;
  private modelSource: "account" | "byok" | null = null;
  /** Coalesce open-segment narration without suppressing later input versions. */
  private readonly narratedOpenSegments = new Set<string>();
  private readonly markdownCache = new Map<string, Map<string, CachedEntry>>();
  private permissions: HistoryPermissions | undefined;
  private readonly permissionReader: (request?: HistoryPermission) => Promise<HistoryPermissions>;
  private permissionStartVersion = 0;
  private permissionStarts = 0;

  get recorderBusy(): boolean {
    return this.permissionStarts > 0 || !!this.recorderTransition || this.recorderChildren.size > 0
      || this.observationState === "running" || this.observationState === "stopping";
  }

  private readonly weChatConsent: WeChatHistoryConsentStore;
  private weChatPollTimer: ReturnType<typeof setInterval> | null = null;
  private weChatPollInFlight = false;
  private weChatPollGeneration = 0;
  private weChatReadFailures = 0;
  private weChatError: string | null = null;
  private weChatConnectionChild: ChildProcessWithoutNullStreams | null = null;
  private weChatPhase: string | null = null;
  private weChatPreparation: Promise<WeChatReaderPreparation> | null = null;
  private weChatPreparationChild: ChildProcessWithoutNullStreams | null = null;
  private restorationAttempted = false;

  private get recordingIntentFile(): string {
    return path.join(this.historyDirectory, "recording-intent.json");
  }

  private get segmentsDirectory(): string {
    return path.join(this.recordingDirectory, SEGMENTS_DIRECTORY_NAME);
  }
  private liveSummaryTimer: ReturnType<typeof setInterval> | null = null;
  private liveSummarySignature: string | null = null;
  private currentRawCache: { signature: string; history: ComputerHistoryEntry; raw: string } | null = null;
  private readonly retentionCache = new Map<string, { signature: string; checkpoint: RetainedSegmentEvidence }>();

  constructor(input: {
    /**
     * The recorder entry point. Tests pass a stand-in: the real one listens to
     * the keyboard and mouse, and a test that forgets to stop it leaves it
     * running long after the suite has finished.
     */
    recorderScript?: string;
    platformDriver?: HistoryPlatformDriver;
    historyDirectory?: string;
    recordingDirectory?: string;
    workflowDirectory?: string;
    observationSettingsFile?: string;
    weChatConsentFile?: string;
    permissionReader?: (request?: HistoryPermission) => Promise<HistoryPermissions>;
    /** Read at request and commit time so App language changes need no recorder restart. */
    summaryLanguage?: () => MemmyOutputLanguage | undefined;
  } = {}) {
    this.recorderScript = input.recorderScript ?? "";
    this.platformDriver = input.platformDriver;
    const memmyHome = process.env.MEMMY_HOME?.trim() || path.join(os.homedir(), ".memmy");
    this.historyDirectory = path.resolve(input.historyDirectory
      ?? path.join(memmyHome, "computer-history", "histories"));
    this.recordingDirectory = path.resolve(input.recordingDirectory
      ?? path.join(memmyHome, "computer-history", "recordings"));
    this.workflowDirectory = path.resolve(input.workflowDirectory
      ?? path.join(memmyHome, "computer-history", "workflows"));
    this.browserAuthorityPath = path.join(path.dirname(this.historyDirectory), "browser-authority.json");
    this.observationSettings = new ObservationSettingsStore(input.observationSettingsFile);
    this.permissionReader = input.permissionReader ?? (async (request) => this.platformDriver?.readPermissions(request)
      ?? { supported: false, accessibility: false, inputMonitoring: false });
    this.weChatConsent = new WeChatHistoryConsentStore(input.weChatConsentFile ?? defaultWeChatConsentFile());
    this.applicationIcons = new ApplicationIconReader();
    this.summaryLanguage = input.summaryLanguage ?? discoverMemmyOutputLanguage;
    this.liveSummaryIntervalMs = boundedInterval(
      process.env.MEMMY_COMPUTER_HISTORY_LIVE_SUMMARY_INTERVAL_MS,
      60_000,
      15_000,
      10 * 60_000,
    );
    this.memoryAdapter = new HistoryMemoryAdapter({
      historyDirectory: this.historyDirectory,
      enabled: () => true,
      listEvidence: () => this.memoryEvidence(),
      listSkillGroups: () => this.memorySkillGroups(),
      onSkillCandidate: (group, skillId, previousSkillId) => this.updateSkillGroupLinks(group, skillId, previousSkillId),
    });
    // Windows requires window-bound native privacy proof. Extension focus can
    // corroborate it or veto a mismatch; it cannot authorize an unknown window.
    if (process.platform === "win32") {
      this.browserAuthorityEnabled = true;
      this.startBrowserAuthorityPublisher();
    }
    // DOM semantics use the same History consent on both platforms and need no Agent claim.
    void import("../../../core/agent-runtime/tools/external-browser-bridge.js").then(({ externalBrowserBridge }) => {
      if (this.shuttingDown) return;
      this.browserHistoryBridge = connectBrowserHistoryBridge(this, externalBrowserBridge);
    }).catch(() => { /* A missing browser connection must not interrupt native History recording. */ });
  }

  /** Clear page identity immediately, including while an async stop is draining. */
  private clearBrowserAuthority(): void {
    if (!this.browserAuthorityEnabled || this.browserAuthorityCleared) return;
    try {
      writeBrowserAuthority(this.browserAuthorityPath, { version: 2, updatedAt: Date.now(), browsers: {} });
      this.browserAuthorityCleared = true;
    } catch {
      // A failed replacement must not leave a previously authorized URL alive.
      try { fs.rmSync(this.browserAuthorityPath, { force: true }); this.browserAuthorityCleared = true; } catch { /* Unreadable authority cannot authorize native-unknown capture. */ }
    }
  }

  /** Passive browser observation follows the ordinary History switch, independent of Agent chats. */
  getBrowserCaptureIntent(): BrowserHistoryCaptureIntent {
    const disabled = { enabled: false, generation: null, settings: null, captureText: false } as const;
    if (this.shuttingDown || this.browserAuthoritySuspended || this.recorderTransition
      || this.observationState !== "running" || !this.segment) return disabled;
    try {
      // Capture cannot use the settings store's UI-friendly fallback on a missing/corrupt file.
      const settings = parseObservationSettings(JSON.parse(fs.readFileSync(this.observationSettings.filePath, "utf8")));
      const policy = crypto.createHash("sha256").update(JSON.stringify(settings)).digest("hex").slice(0, 20);
      return { enabled: true, generation: `${this.segment.id}:${this.captureHealthGeneration}:${policy}`,
        settings, captureText: true };
    } catch { return disabled; }
  }

  /** The bridge supplies browser-owned context; DOM messages supply observations only. */
  ingestBrowserSemanticEvent(payload: unknown, context: BrowserHistoryTrustedContext): boolean {
    const intent = this.getBrowserCaptureIntent();
    const segment = this.segment;
    const prepared = prepareBrowserHistoryEvent(payload, context, intent);
    if (!prepared || !segment || this.browserEventIds.has(prepared.deduplicationKey)) return false;
    // Validation and commit are synchronous, so Stop/Pause/policy transitions cannot interleave.
    appendBrowserHistoryEvent(segment.eventsFile, prepared);
    this.browserEventIds.add(prepared.deduplicationKey);
    if (this.browserEventIds.size > 4096) this.browserEventIds.delete(this.browserEventIds.values().next().value!);
    // Like native events, the live narration notices the grown event file on
    // its next check; invalidating here would discard a narration in progress.
    if (!this.captureLastEventAt || prepared.event.timestamp > this.captureLastEventAt) this.captureLastEventAt = prepared.event.timestamp;
    return true;
  }

  // This sidecar obeys the same recording intent and strict policy as raw
  // capture. UI settings reads can default for display, but capture must never
  // treat a missing/corrupt policy as permission to store every focused URL.
  private startBrowserAuthorityPublisher(): void {
    this.clearBrowserAuthority();
    void (async () => {
      const { externalBrowserBridge } = await import("../../../core/agent-runtime/tools/external-browser-bridge.js");
      const publish = () => {
        if (this.shuttingDown || this.browserAuthoritySuspended || this.observationState !== "running") {
          this.clearBrowserAuthority();
          return;
        }
        try {
          const settings = parseObservationSettings(JSON.parse(fs.readFileSync(this.observationSettings.filePath, "utf8")));
          const connected = externalBrowserBridge.listConnected?.() ?? [];
          writeBrowserAuthority(this.browserAuthorityPath,
            buildBrowserAuthoritySnapshot(connected, filterHistoryAuthorityObservations(settings,
              externalBrowserBridge.listHistoryFocusObservations())));
          this.browserAuthorityCleared = false;
        } catch { this.clearBrowserAuthority(); }
      };
      if (this.shuttingDown) return;
      this.publishBrowserAuthority = publish;
      publish();
      this.browserAuthorityTimer = setInterval(publish, 1_000);
      this.browserAuthorityTimer.unref?.();
    })().catch(() => { this.clearBrowserAuthority(); });
  }

  /** Restore only a recording explicitly left on before the previous exit. */
  async restoreObservationOnLaunch(): Promise<void> {
    if (this.restorationAttempted || this.shuttingDown) return;
    this.restorationAttempted = true;
    let intent: "running" | "paused" | "stopped" = "stopped";
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.recordingIntentFile, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const state = (parsed as { state?: unknown }).state;
        if (state === "running" || state === "paused") intent = state;
      }
    } catch { /* Missing or damaged intent fails closed. */ }
    if (intent === "paused") {
      this.historyLease?.(); this.historyLease = null;
      this.observationState = "paused";
      return;
    }
    if (intent !== "running") return;
    try { await this.startObservationWithPermissions(); }
    catch (error) { this.failObservation(error instanceof Error ? error.message : String(error)); }
  }

  private saveRecordingIntent(state: "running" | "paused" | "stopped"): void {
    if (state === "running" && this.eventCaptureBootstrap) state = this.eventCaptureBootstrap;
    fs.mkdirSync(this.historyDirectory, { recursive: true });
    // A failed pause/stop write must still revoke the previous running intent.
    if (state !== "running") fs.rmSync(this.recordingIntentFile, { force: true });
    const temporary = `${this.recordingIntentFile}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ state }), { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, this.recordingIntentFile);
    } finally { fs.rmSync(temporary, { force: true }); }
  }

  private get weChatStateDirectory(): string {
    return path.dirname(this.weChatConsent.filePath);
  }

  private get weChatNamesFile(): string {
    return path.join(this.weChatStateDirectory, "names.json");
  }

  // The freshest display names the reader resolved. Persisted privately on each
  // poll so a summary can repair a chat or sender that was captured before
  // WeChat had synced its contact metadata. Returns true when it changed.
  private persistWeChatNames(names: unknown): boolean {
    if (!names || typeof names !== "object" || Array.isArray(names)) return false;
    try {
      const serialized = `${JSON.stringify(names)}\n`;
      let previous: string | null = null;
      try { previous = fs.readFileSync(this.weChatNamesFile, "utf8"); } catch { /* first write */ }
      if (previous === serialized) return false;
      fs.mkdirSync(this.weChatStateDirectory, { recursive: true, mode: 0o700 });
      atomicWriteText(this.weChatNamesFile, serialized);
      return true;
    } catch {
      // Best effort: names self-heal on the next poll and the frozen capture
      // remains a correct fallback.
      return false;
    }
  }

  private weChatNameMap(): WeChatNameMap | undefined {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.weChatNamesFile, "utf8"));
    } catch {
      return undefined;
    }
    if (!raw || typeof raw !== "object") return undefined;
    const source = raw as { chats?: unknown; people?: unknown };
    const map: WeChatNameMap = {};
    if (source.chats && typeof source.chats === "object") {
      const chats: NonNullable<WeChatNameMap["chats"]> = {};
      for (const [key, value] of Object.entries(source.chats as Record<string, unknown>)) {
        if (value && typeof value === "object") {
          const entry = value as { display?: unknown; kind?: unknown };
          chats[key] = {
            display: typeof entry.display === "string" ? entry.display : null,
            kind: typeof entry.kind === "string" ? entry.kind : null,
          };
        }
      }
      if (Object.keys(chats).length) map.chats = chats;
    }
    if (source.people && typeof source.people === "object") {
      const people: NonNullable<WeChatNameMap["people"]> = {};
      for (const [key, value] of Object.entries(source.people as Record<string, unknown>)) {
        people[key] = typeof value === "string" ? value : null;
      }
      if (Object.keys(people).length) map.people = people;
    }
    return map.chats || map.people ? map : undefined;
  }

  private get weChatPermissionApp(): string {
    return path.join(this.weChatStateDirectory, "connection-helper", "Memmy WeChat Reader.app");
  }

  /** Prepare and check the actual reader identity without consent, login or quitting WeChat. */
  prepareWeChatReader(): Promise<WeChatReaderPreparation> {
    this.assertPersonalWeChatHistorySupported();
    if (process.platform !== "darwin") throw new ComputerHistoryApiError(400, "WeChat reader preparation requires macOS");
    if (this.shuttingDown) throw new ComputerHistoryApiError(409, "Desktop is shutting down");
    if (this.weChatConnectionChild) throw new ComputerHistoryApiError(409, "WeChat connection is busy");
    if (this.weChatPreparation) return this.weChatPreparation;
    const helper = physicalRuntimeAsset(moduleFile("wechat/connect.py"));
    const python = resolveMacWeChatPython();
    if (!python) {
      this.saveWeChatFailure("python_unavailable", "reader_permission_check");
      return Promise.resolve({ ready: false, appPath: null, error: "python_unavailable" });
    }
    this.weChatPreparation = new Promise<WeChatReaderPreparation>((resolve) => {
      const child = spawn(python, ["-B", helper, "--state", this.weChatStateDirectory, "--prepare-only"],
        { stdio: ["pipe", "pipe", "pipe"] });
      this.weChatPreparationChild = child;
      child.stdin.end();
      child.stderr.resume();
      let stdout = "";
      let settled = false;
      const finish = (value: WeChatReaderPreparation) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.weChatPreparationChild === child) this.weChatPreparationChild = null;
        resolve(value);
      };
      const unavailable = () => {
        if (settled) return;
        this.saveWeChatFailure("wechat_permission_helper_unavailable", "reader_permission_check");
        finish({ ready: false, appPath: null, error: "wechat_permission_helper_unavailable" });
      };
      const timer = setTimeout(() => { child.kill("SIGINT"); unavailable(); }, 90_000);
      timer.unref?.();
      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString("utf8");
        if (stdout.length > 16_384) { child.kill("SIGINT"); unavailable(); }
      });
      child.once("error", unavailable);
      child.once("close", (code, signal) => {
        if (code !== 0 || signal) { unavailable(); return; }
        try {
          const result: unknown = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
          if (!result || typeof result !== "object") { unavailable(); return; }
          const value = result as Record<string, unknown>;
          // Only the managed, fixed app path can be exposed or subsequently revealed.
          if (typeof value.ready !== "boolean"
            || (value.appPath !== null && value.appPath !== this.weChatPermissionApp)
            || (value.error !== null && (typeof value.error !== "string" || !/^[a-z_]{1,128}$/u.test(value.error)))
            || (value.ready && (value.appPath !== this.weChatPermissionApp || value.error !== null))) {
            unavailable(); return;
          }
          const response = { ready: value.ready, appPath: value.appPath as string | null, error: value.error as string | null };
          if (response.error) this.saveWeChatFailure(response.error, "reader_permission_check");
          finish(response);
        } catch { unavailable(); }
      });
    }).finally(() => { this.weChatPreparation = null; });
    return this.weChatPreparation;
  }

  /** Keep the latest failure and where it happened; never key manifests or reader stdout. */
  private saveWeChatFailure(category: string, phase: string | null, detail?: unknown): void {
    if (!/^[a-zA-Z_][a-zA-Z_:0-9-]{0,127}$/u.test(category)) return;
    let failureDetail: Record<string, string | number> | undefined = weChatFailureDetail(detail);
    if (category === "wechat_private_storage_source_changed") {
      const diagnostics: Record<string, string | number> = {};
      if (detail && typeof detail === "object") {
        const value = detail as Record<string, unknown>;
        if (value.kind === "file" || value.kind === "directory" || value.kind === "entry") diagnostics.kind = value.kind;
        if (["cache", "database", "other"].includes(value.area as string)) diagnostics.area = value.area as string;
        if (typeof value.pathHash === "string" && /^[a-f0-9]{16}$/u.test(value.pathHash)) diagnostics.pathHash = value.pathHash;
        if (typeof value.fields === "string" && /^(?:size|dev|ino|mtime_ns|ctime_ns)(?:,(?:size|dev|ino|mtime_ns|ctime_ns)){0,4}$/u.test(value.fields)) diagnostics.fields = value.fields;
        for (const key of ["attempts", "elapsedMs"] as const) {
          if (typeof value[key] === "number" && Number.isSafeInteger(value[key]) && value[key] >= 0) diagnostics[key] = value[key];
        }
      }
      failureDetail = Object.keys(diagnostics).length ? diagnostics : undefined;
    }
    const file = path.join(this.weChatStateDirectory, "last-connection-error.json");
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      const directory = this.weChatStateDirectory;
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const info = fs.lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) return;
      // Windows privacy comes from the NTFS ACL set up with consent; POSIX owner and mode bits do not apply.
      if (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077))) return;
      fs.writeFileSync(temporary, JSON.stringify({ category, phase, failedAt: new Date().toISOString(),
        ...(failureDetail ? { detail: failureDetail } : {}) }), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
    } catch { /* Diagnostics must not change connection or consent behavior. */ }
    finally { fs.rmSync(temporary, { force: true }); }
  }

  private weixinKeyHelper(): string {
    return physicalRuntimeAsset(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "win", "weixin_keys.py"));
  }

  private weChatReader(consentId = this.weChatConsent.read().consentId): WeChatMessageBatchReader | null {
    const directory = this.weChatStateDirectory;
    const keyFile = path.join(directory, "keys.json");
    const cursorFile = path.join(directory, "cursor.json");
    const accountFile = path.join(directory, "account.json");
    const library = process.platform === "win32" ? "builtin" : this.weChatSqlcipherLibrary;
    const required = [keyFile, accountFile];
    if (library !== "builtin") required.push(library);
    if (!required.every((file) => fs.existsSync(file))) return null;
    const windowsPython = process.platform === "win32" ? resolveWindowsWeChatPython() : null;
    const python = process.platform === "win32" ? windowsPython?.executable : resolveMacWeChatPython();
    if (!python) return null;
    try {
      const account = JSON.parse(fs.readFileSync(accountFile, "utf8")) as Record<string, unknown>;
      if (typeof account.databaseRoot !== "string" || path.basename(account.databaseRoot) !== "db_storage") return null;
      if (account.consentId !== undefined && account.consentId !== consentId) return null;
      if (account.baselineSince !== undefined
        && (typeof account.baselineSince !== "number" || !Number.isSafeInteger(account.baselineSince)
          || account.baselineSince < 0)) return null;
      return new WeChatMessageBatchReader({
        databaseRoot: account.databaseRoot, keyFile, cursorFile,
        sqlcipherLibrary: library, consent: this.weChatConsent,
        ...(typeof account.baselineSince === "number" ? { baselineSince: account.baselineSince } : {}),
        python,
        pythonArgs: windowsPython?.args ?? ["-B"],
        // macOS takes its baseline inside the connection helper, before WeChat reopens.
        baselineFromConsent: process.platform === "win32",
      });
    } catch {
      return null;
    }
  }

  private get weChatSqlcipherLibrary(): string {
    if (process.env.MEMMY_SQLCIPHER_LIBRARY) return process.env.MEMMY_SQLCIPHER_LIBRARY;
    const helper = physicalRuntimeAsset(moduleFile("wechat/read_messages.py"));
    const marker = `${path.sep}app.asar.unpacked${path.sep}`;
    const index = helper.indexOf(marker);
    if (index >= 0) {
      return path.join(helper.slice(0, index), "native", "sqlcipher", "libsqlcipher.dylib");
    }
    return "/opt/homebrew/opt/sqlcipher/lib/libsqlcipher.dylib";
  }

  private weChatStatus(): NonNullable<ComputerHistorySnapshot["wechat"]> {
    // One read per status: on Windows each read runs an NTFS check, and two reads
    // that disagree would report a working connection as needing setup.
    const consent = this.weChatConsent.read();
    if (!consent.enabled) {
      return { enabled: false, connection: "disabled", phase: null, error: null };
    }
    if (this.weChatConnectionChild) {
      return { enabled: true, connection: "connecting", phase: this.weChatPhase, error: null };
    }
    const windows = process.platform === "win32";
    const helper = windows
      ? this.weixinKeyHelper()
      : physicalRuntimeAsset(moduleFile("wechat/connect.py"));
    if ((!windows && !fs.existsSync(this.weChatSqlcipherLibrary)) || !fs.existsSync(helper)) {
      return { enabled: true, connection: "unavailable", phase: null, error: null };
    }
    if (this.weChatError) return { enabled: true, connection: "error", phase: null, error: this.weChatError };
    if (windows ? !resolveWindowsWeChatPython() : !resolveMacWeChatPython()) {
      return { enabled: true, connection: "unavailable", phase: null, error: "python_unavailable" };
    }
    return { enabled: true, connection: this.weChatReader(consent.consentId) ? "connected" : "needs_setup",
      phase: null, error: null };
  }

  /** The user's one extra permission gates both the AX recorder and DB reader. */
  setWeChatChatAccess(enabled: boolean): ComputerHistorySnapshot {
    this.assertPersonalWeChatHistorySupported();
    if (enabled) {
      if (this.segment) {
        fs.chmodSync(this.segment.directory, 0o700);
        if (fs.existsSync(this.segment.eventsFile)) fs.chmodSync(this.segment.eventsFile, 0o600);
      }
      try {
        this.weChatConsent.grant();
      } catch (error) {
        if (process.platform === "win32") {
          // The optional interpreter/NTFS check must complete before an enabled
          // consent is written. Return a stable message without private paths.
          throw new ComputerHistoryApiError(503, "Windows WeChat local reader is unavailable");
        }
        throw error;
      }
      if (this.observationState === "running") this.startWeChatPolling();
      if (this.llmRuntime) this.retrySummariesInBackground();
    } else {
      this.weChatConsent.revoke();
      this.clearWeChatPolling();
    }
    this.weChatError = null;
    this.weChatReadFailures = 0;
    return this.snapshot();
  }

  /** User-initiated setup: the helper reports phases while it restores WeChat. */
  connectWeChat(): ComputerHistorySnapshot {
    this.assertPersonalWeChatHistorySupported();
    if (this.weChatPreparationChild) throw new ComputerHistoryApiError(409, "WeChat reader preparation is busy");
    if (!this.weChatConsent.read().enabled) {
      throw new ComputerHistoryApiError(409, "WeChat chat access is disabled");
    }
    if (this.weChatConnectionChild) return this.snapshot();
    const windows = process.platform === "win32";
    const library = windows ? "builtin" : this.weChatSqlcipherLibrary;
    const helper = windows ? this.weixinKeyHelper() : physicalRuntimeAsset(moduleFile("wechat/connect.py"));
    if ((!windows && !fs.existsSync(library)) || !fs.existsSync(helper)) {
      throw new ComputerHistoryApiError(503, "WeChat local reader is unavailable");
    }
    const windowsPython = windows ? resolveWindowsWeChatPython() : null;
    const command = windows ? windowsPython?.executable : resolveMacWeChatPython();
    if (!command) {
      this.weChatError = "python_unavailable";
      this.weChatPhase = null;
      this.saveWeChatFailure(this.weChatError, "preparing");
      return this.snapshot();
    }
    this.weChatError = null;
    this.weChatReadFailures = 0;
    this.weChatPhase = "preparing";
    // The Windows helper uses Known Folders/config and verifies account keys;
    // do not silently replace an ambiguous custom store with default Documents.
    const args = windows
      ? [...windowsPython!.args, helper, "--output", path.join(this.weChatStateDirectory, "keys.json"),
        "--consent-file", this.weChatConsent.filePath]
      : ["-B", helper, "--state", this.weChatStateDirectory, "--library", library];
    // A pending read belongs to the old account/key setup, even when the user
    // keeps the same consent while switching accounts or refreshing keys.
    this.weChatPollGeneration += 1;
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end();
    this.weChatConnectionChild = child;
    let pending = "";
    const readStatus = (line: string) => {
      try {
        const status = JSON.parse(line) as { event?: unknown; category?: unknown; detail?: unknown };
        const failedPhase = this.weChatPhase;
        if (typeof status.event === "string" && /^[a-z_]+$/u.test(status.event)
          && status.event !== "connection_error" && status.event !== "capture_error") {
          this.weChatPhase = status.event;
        }
        if ((status.event === "connection_error" || status.event === "capture_error")
          && typeof status.category === "string") {
          // Older helpers report a useful capture error, then a generic parent
          // error. Preserve the cause instead of hiding it with the fallback.
          if (status.category !== this.weChatError
            && (status.category !== "key_capture_failed" || !this.weChatError)) {
            this.weChatError = status.category;
            this.saveWeChatFailure(status.category, failedPhase, status.detail);
          }
        }
      } catch { /* Status output contains no chat content; ignore malformed lines. */ }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      if (pending.length > 8_192) pending = pending.slice(-8_192);
      while (pending.includes("\n")) {
        const index = pending.indexOf("\n");
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        readStatus(line);
      }
    });
    child.stderr.resume();
    child.once("error", () => {
      if (this.weChatConnectionChild === child) {
        this.weChatConnectionChild = null;
        this.weChatPhase = null;
        this.weChatError = "connection_process_failed";
        this.saveWeChatFailure(this.weChatError, "preparing");
      }
    });
    // stdout can still contain the terminal error after exit. Finalize only
    // after close, when all helper status output has been delivered.
    child.once("close", (code, signal) => {
      if (this.weChatConnectionChild !== child) return;
      if (pending.trim()) readStatus(pending);
      const failedPhase = this.weChatPhase;
      this.weChatConnectionChild = null;
      this.weChatPhase = null;
      if (!this.weChatConsent.read().enabled) return;
      if (signal || code !== 0 || !this.weChatReader()) {
        if (!this.weChatError) {
          this.weChatError = signal ? "connection_process_crashed" : "connection_failed";
          this.saveWeChatFailure(this.weChatError, failedPhase);
        }
      } else {
        this.weChatError = null;
        if (this.observationState === "running") {
          void this.pollWeChatMessages();
        }
      }
    });
    return this.snapshot();
  }

  private async pollWeChatMessages(): Promise<void> {
    if (this.weChatPollInFlight || this.weChatConnectionChild || this.observationState !== "running" || !this.segment
      || !this.weChatConsent.read().enabled) return;
    const reader = this.weChatReader();
    if (!reader) return;
    this.weChatPollInFlight = true;
    const generation = this.weChatPollGeneration;
    try {
      // The durable cursor decides first connection versus resume. Recorder
      // restarts and pauses must never advance it without accepting messages.
      const batch = await reader.read();
      const segment = this.segment;
      if (generation !== this.weChatPollGeneration || !segment || this.weChatConnectionChild || this.observationState !== "running"
        || this.weChatConsent.read().consentId !== batch.consentId) return;
      const appended = appendWeChatMessagesToHistory(this.segmentsDirectory,
        segment.eventsFile, batch.messages);
      reader.acknowledge(batch.nextCursor, batch.consentId);
      // Refreshing the name map can repair an earlier raw id, so re-narrate the
      // segment when names improved even if no new message was appended.
      const namesChanged = this.persistWeChatNames(batch.names);
      if (appended || namesChanged) this.invalidateSummary(segment.historyFile);
      this.weChatError = null;
      this.weChatReadFailures = 0;
    } catch (error) {
      if (generation === this.weChatPollGeneration) this.recordWeChatReadFailure(error);
    } finally {
      this.weChatPollInFlight = false;
    }
  }

  /**
   * A slow or busy read keeps the connection; the next poll retries from the
   * same checkpoint. Showing it as a failed connection sends the user through
   * reconnecting, which can revoke the keys and skip ahead to a new baseline.
   */
  private recordWeChatReadFailure(error: unknown): void {
    const category = error instanceof WeChatReaderError ? error.category : "wechat_history_intake_failed";
    this.weChatReadFailures += 1;
    this.saveWeChatFailure(category, "reading");
    if (WECHAT_KEY_FAILURES.has(category)) this.weChatError = "wechat_keys_outdated";
    else if (this.weChatReadFailures >= WECHAT_READ_FAILURES_BEFORE_ERROR) this.weChatError = "wechat_reader_unavailable";
  }

  private assertPersonalWeChatHistorySupported(): void {
    if (!isPersonalWeChatHistorySupported()) {
      throw new ComputerHistoryApiError(400, "Personal WeChat History is available on Apple silicon macOS and Windows 11 only");
    }
  }

  private startWeChatPolling(): void {
    if (!isPersonalWeChatHistorySupported() || this.weChatPollTimer || !this.weChatConsent.read().enabled) return;
    void this.pollWeChatMessages();
    this.weChatPollTimer = setInterval(() => void this.pollWeChatMessages(), 15_000);
    this.weChatPollTimer.unref();
  }

  private clearWeChatPolling(): void {
    this.weChatPollGeneration += 1;
    if (this.weChatPollTimer) clearInterval(this.weChatPollTimer);
    this.weChatPollTimer = null;
  }

  /**
   * The summaries immediately before this one, oldest first.
   *
   * Without them the model has nothing to relate a window to, and any account
   * of what preceded it would be invention.
   */
  private priorSummaries(historyId: string): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.historyDirectory);
    } catch {
      return [];
    }
    return names
      .filter((name) => name.endsWith("-10min-summary.md") && name < `${historyId}.md`)
      .sort()
      .slice(-PRIOR_SUMMARY_COUNT)
      .map((name) => {
        try {
          return fs.readFileSync(path.join(this.historyDirectory, name), "utf8");
        } catch {
          return "";
        }
      })
      .filter((markdown) => markdown && isNarrated(markdown)
        && (this.weChatConsent.read().enabled || !containsWeChatEvidence(markdown)));
  }

  /** An application's icon for the timeline, as a data URL. */
  applicationIcon(bundleId: string): Promise<string | null> {
    return this.platformDriver?.iconFor(bundleId) ?? Promise.resolve(null);
  }

  listApplications(): Promise<Array<{ bundleId: string; name: string }>> {
    if (this.platformDriver?.listApplications) return this.platformDriver.listApplications();
    return isWindows11() ? listWindowsApplications() : this.applicationIcons.listApplications();
  }

  getObservationSettings(): ObservationSettings {
    return this.observationSettings.read();
  }

  updateObservationSettings(input: unknown): ObservationSettings {
    this.clearBrowserAuthority();
    try {
      const next = this.observationSettings.write(input);
      this.publishBrowserAuthority?.();
      this.memoryAdapter.schedule();
      return next;
    } catch (error) {
      throw new ComputerHistoryApiError(422, error instanceof Error ? error.message : "invalid observation settings");
    }
  }

  private memoryEvidence(): HistoryEvidence[] {
    return this.readMarkdownDirectory(this.historyDirectory)
      .filter((entry) => isNarrated(entry.markdown) && (
        (entry.summaryWindow === "10min"
          && readSourceType(entry.markdown) === "captured"
          && readFrontmatterValue(entry.markdown, "status") === "completed")
        || (entry.summaryWindow === "6h"
          && readSourceType(entry.markdown) === "rollup"
          && entry.coveredHistoryIds.length > 0
          && instantFromId(entry.id) !== null
          && isSixHourWindowClosed(instantFromId(entry.id)!))
      ))
      .flatMap((entry) => {
        const start = instantFromId(entry.id);
        if (!start) return [];
        const content = entry.markdown.replace(/^---\n[\s\S]*?\n---\n/u, "").trim().slice(0, 16_000);
        if (!content) return [];
        const windowMs = entry.summaryWindow === "6h" ? SIX_HOUR_MS : SEGMENT_DURATION_MS;
        return [{ id: entry.id, title: entry.title.slice(0, 160),
          summary: historyEvidenceSummary(entry.markdown, entry.description), content,
          revision: fs.statSync(entry.filePath).mtime.toISOString(),
          startedAt: start.toISOString(), endedAt: new Date(start.getTime() + windowMs).toISOString(),
          applications: entry.applications,
          summaryWindow: entry.summaryWindow ?? "10min",
          parentSourceRecordIds: entry.coveredHistoryIds }];
      })
      .sort((left, right) => Number(left.summaryWindow === "6h") - Number(right.summaryWindow === "6h")
        || left.startedAt.localeCompare(right.startedAt));
  }

  private memorySkillGroups(): HistorySkillGroup[] {
    const entries = this.readMarkdownDirectory(this.historyDirectory);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    return entries.filter((entry) => entry.summaryWindow === "6h"
      && readSourceType(entry.markdown) === "rollup" && isNarrated(entry.markdown)
      && entry.coveredHistoryIds.length >= 2)
      .flatMap((rollup) => {
        const at = instantFromId(rollup.id);
        if (!at || !isSixHourWindowClosed(at)) return [];
        const revision = fs.statSync(rollup.filePath).mtime.toISOString();
        const cached = this.skillGroupCache.get(rollup.id);
        if (cached?.revision === revision) return cached.group ? [cached.group] : [];
        const allSources = rollup.coveredHistoryIds.flatMap((id) => {
          const entry = byId.get(id);
          if (!entry || entry.summaryWindow !== "10min" || readSourceType(entry.markdown) !== "captured") return [];
          // Chat content can inform History/Memory, but a chat window alone is
          // not evidence of a repeatable computer operation.
          if (containsWeChatEvidence(entry.markdown)) return [];
          const steps = this.deriveSteps(id).slice(0, 8);
          return steps.length >= 2 ? [{ id, steps }] : [];
        });
        const sources = allSources.length <= 11 ? allSources : Array.from({ length: 11 }, (_, index) =>
          allSources[Math.round(index * (allSources.length - 1) / 10)]!);
        const actions = sources.flatMap((source) => source.steps.map((text) => ({
          sourceRecordId: source.id, text: text.slice(0, 300)
        }))).slice(0, 60);
        const group: HistorySkillGroup | null = sources.length >= 2 && actions.length >= 4
          ? { id: rollup.id, revision, sourceRecordIds: [rollup.id, ...sources.map((source) => source.id)], actions }
          : null;
        this.skillGroupCache.set(rollup.id, { revision, group });
        return group ? [group] : [];
      });
  }

  private updateSkillGroupLinks(group: HistorySkillGroup, skillId: string | null, previousSkillId?: string): void {
    const links = this.readSkillLinks();
    let changed = false;
    for (const id of group.sourceRecordIds) {
      const existing = links[id] ?? [];
      const next = existing.filter((candidate) => candidate !== previousSkillId);
      if (skillId && validSkillMemoryId(skillId)
        && fs.existsSync(path.join(this.historyDirectory, `${id}.md`)) && !next.includes(skillId)) next.push(skillId);
      if (next.length) links[id] = next;
      else delete links[id];
      if (next.length !== existing.length || next.some((candidate, index) => candidate !== existing[index])) changed = true;
    }
    if (changed) atomicWriteText(this.skillLinksFile, JSON.stringify(links));
  }

  /** Supplies the model used to narrate finalized segments. */
  setLlmRuntime(
    llmRuntime: LLMRuntimeResolver | null,
    source: "account" | "byok" | null = null,
    unavailableReason: string | null = null,
  ): void {
    this.modelSource = source;
    if (this.llmRuntime !== llmRuntime) {
      this.backfill = null;
      this.summaryJobs.clear();
      this.narratedOpenSegments.clear();
      this.setNarrationError(null);
    }
    this.llmRuntime = llmRuntime;
    if (!llmRuntime && unavailableReason) this.setNarrationError(unavailableReason);
    if (this.summaryRetryTimer) clearTimeout(this.summaryRetryTimer);
    this.summaryRetryTimer = null;
    if (!llmRuntime || this.shuttingDown) return;
    // Realign first so the rebuilt rollups are among what the backfill writes.
    this.realignRollups();
    this.retrySummariesInBackground();
    if (this.segment && this.observationState === "running") this.writeLiveSummary(this.segment);
  }

  private setNarrationError(reason: string | null, category?: "quota_exhausted"): void {
    this.narrationError = reason;
    this.narrationErrorCategory = category ?? null;
  }

  private retrySummariesInBackground(): void {
    if (!this.llmRuntime || this.shuttingDown) return;
    void this.backfillUnwrittenSummaries().catch((error) => {
      this.setNarrationError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (!this.llmRuntime || this.shuttingDown || this.summaryRetryTimer) return;
      this.summaryRetryTimer = setTimeout(() => {
        this.summaryRetryTimer = null;
        this.retrySummariesInBackground();
      }, 60_000);
      this.summaryRetryTimer.unref();
    });
  }

  /**
   * Writes every machine summary the model never got to.
   *
   * A summary is only shown once written, so one the model never reached is not
   * merely plainer — it is absent from the timeline. That covers summaries from
   * before narration wrote the whole body, and any left behind by a model that
   * was unreachable at the time. Runs when the runtime arrives, one at a time,
   * so a backlog does not go out as a burst of concurrent requests.
   */
  async backfillUnwrittenSummaries(): Promise<number> {
    if (!this.llmRuntime) return 0;
    if (this.backfill) return this.backfill;
    const pending = this.writeUnwrittenSummaries();
    this.backfill = pending;
    try {
      return await pending;
    } finally {
      if (this.backfill === pending) this.backfill = null;
    }
  }

  private async writeUnwrittenSummaries(): Promise<number> {
    this.recoverInterruptedSegments();
    let written = 0;
    const runtime = this.llmRuntime;
    const entries = this.readMarkdownDirectory(this.historyDirectory).reverse();
    // A failed replacement keeps its full evidence beside the standing entry.
    // Include those files after a restart as well as ordinary pending entries.
    const pending = new Map(entries.map((entry) => [entry.filePath, entry.filePath]));
    if (fs.existsSync(this.historyDirectory)) {
      for (const name of fs.readdirSync(this.historyDirectory)) {
        if (!name.endsWith(".md.staging")) continue;
        const staged = path.join(this.historyDirectory, name);
        pending.set(staged.slice(0, -".staging".length), staged);
      }
    }
    // Finish ten-minute evidence before deriving its six-hour account.
    const files = [...pending.entries()].sort(([left], [right]) => (
      Number(left.endsWith("-6h-summary.md")) - Number(right.endsWith("-6h-summary.md"))
        || left.localeCompare(right)
    ));
    const rollups = new Map<string, string>();
    for (const [destination, file] of files) {
      if (this.shuttingDown || this.llmRuntime !== runtime) break;
      const id = path.basename(destination, ".md");
      if (id.endsWith("-6h-summary")) {
        rollups.set(destination, file);
        continue;
      }
      const markdown = readText(file);
      if (!markdown) continue;
      const entry = { id, filePath: destination, markdown };
      if (isCodexSkysightCopy(entry.id)) continue;
      if (!isMachineSummary(readSourceType(entry.markdown))) continue;
      if (file === destination && isNarrated(entry.markdown)) continue;
      // The open segment is still being written to; it is narrated in place.
      if (entry.filePath === this.segment?.historyFile) continue;
      if (await this.writeSummaryWith(file, "10min", this.eventStreamPathFor(entry.id))) {
        written += 1;
      }
    }
    if (this.shuttingDown || this.llmRuntime !== runtime) return written;
    // Include windows whose ten-minute entries were already ready before this
    // process started. Retrying only newly narrated entries left missing and
    // legacy rollups stranded forever. Stable input hashes avoid model churn.
    for (const file of this.prepareRollups()) {
      rollups.set(file.replace(/\.staging$/u, ""), file);
    }
    for (const [destination, file] of rollups) {
      if (this.shuttingDown || this.llmRuntime !== runtime) break;
      const markdown = readText(file);
      if (!markdown || !isMachineSummary(readSourceType(markdown))) continue;
      if (file === destination && isNarrated(markdown)) continue;
      if (await this.writeSummaryWith(file, "6h", null)) written += 1;
    }
    this.removeSupersededRollups();
    return written;
  }

  /** Lightweight status for the menu bar; avoids reading summaries and Skill links. */
  observationStatus(): { state: ObservationState } {
    return { state: this.observationState === "running" && this.eventCaptureIntent ? this.eventCaptureIntent : this.observationState };
  }

  snapshot(): ComputerHistorySnapshot {
    this.cleanupExpiredRecordings();
    // Give a real active capture a durable pending entry before its first timer
    // tick. This preparation never calls the model or changes a standing account.
    if (this.segment && !fs.existsSync(this.segment.historyFile) && segmentHasActivity(this.segment.eventsFile)) {
      const error = this.writeSegmentSummary(this.segment);
      if (error) this.setNarrationError(error);
    }
    const snapshotAt = new Date();
    const historyEntries = this.readMarkdownDirectory(this.historyDirectory);
    const currentId = this.segment ? `${this.segment.id}-10min-summary` : null;
    const standingCurrent = historyEntries.find((entry) => entry.id === currentId);
    const currentRaw = (!standingCurrent || !isNarrated(standingCurrent.markdown)) ? this.currentRawHistory() : null;
    const skillIdsByHistory = this.readSkillLinks();
    return {
      memorySync: this.memoryAdapter.status(),
      observation: {
        state: this.observationState === "running" && this.eventCaptureIntent ? this.eventCaptureIntent : this.observationState,
        startedAt: this.observationStartedAt,
        segmentId: this.segment?.id ?? null,
        segmentStartedAt: this.segment?.startedAt ?? null,
        error: this.observationError,
        narrationError: this.narrationError,
        narrationErrorCategory: this.narrationErrorCategory,
        modelSource: this.modelSource,
        ...(this.permissions ? { permissions: this.permissions } : {}),
        captureHealth: this.captureHealth(),
      },
      histories: [
        ...historyEntries.map((entry) => {
          const sourceType = readSourceType(entry.markdown);
          const hasRawEvents = this.segmentDirectoryFor(entry.id) !== null;
          const skillMemoryIds = skillIdsByHistory[entry.id] ?? [];
          const memoryId = this.memoryAdapter.memoryIdFor(entry.id);
          return { ...entry, skillMemoryIds, ...(memoryId ? { memoryId } : {}),
            ...(isMachineSummary(sourceType) ? { summaryStatus: this.storedSummaryIsPending(entry)
              ? "pending" as const : "ready" as const } : {}),
            sourceType, replayPlan: replayPlanFor(entry, sourceType, hasRawEvents) };
        }),
        ...(currentRaw && !standingCurrent ? [currentRaw.history] : []),
      ]
        // An entry appears once it has been written. Showing the placeholder
        // would put the mechanical wording in front of the reader, which is the
        // thing the written summary exists to avoid. Rollups are machine
        // generated too: read as "imported", they slipped past this gate and
        // put a templated body on the timeline.
        .filter((entry) => !isMachineSummary(entry.sourceType) || isNarrated(entry.markdown)
          || (entry.sourceType === "captured" && (entry.id === currentId ? currentRaw !== null
            : this.hasStoredRawActivity(entry.id))))
        // Hide partial accounts left by the former incremental implementation.
        // They remain on disk so the closed-window pass can safely replace or
        // retain them, but they are not final history while the window is open.
        .filter((entry) => {
          if (entry.summaryWindow !== "6h") return true;
          const windowStart = instantFromId(entry.id);
          return windowStart !== null && isSixHourWindowClosed(windowStart, snapshotAt);
        })
        .filter((entry) => !isCodexSkysightCopy(entry.id))
        .map((entry) => ({
          ...entry,
          pinned: this.isPinned(entry.id),
          eventStreamPath: this.eventStreamPathFor(entry.id),
        })),
      // Pick the fields explicitly rather than spreading the directory entry: a
      // workflow is not a summary, and spreading leaked summary-only fields
      // into it the moment the reader grew new ones.
      workflows: this.readMarkdownDirectory(this.workflowDirectory).map((entry) => ({
        id: entry.id,
        title: entry.title,
        createdAt: entry.createdAt,
        markdown: entry.markdown,
        filePath: entry.filePath,
        sourceHistoryId: nullableFrontmatterValue(entry.markdown, "source_history_id"),
      })),
      ...(isPersonalWeChatHistorySupported() ? { wechat: this.weChatStatus() } : {}),
      privacy: {
        screenshots: false,
        audio: false,
        rawRetentionHours: 48,
        markdownDirectory: this.historyDirectory,
        eventStreamDirectory: this.segmentsDirectory,
      },
    };
  }

  /** Called by the optional Memory adapter only after a Skill ID is persisted. */
  setHistorySkillLinks(historyId: string, skillIds: string[]): ComputerHistorySnapshot {
    const history = this.readMarkdownDirectory(this.historyDirectory).find((entry) => entry.id === historyId);
    if (!history) throw new ComputerHistoryApiError(404, "history not found");
    if (!Array.isArray(skillIds) || skillIds.length > 20 || skillIds.some((id) => !validSkillMemoryId(id))) {
      throw new ComputerHistoryApiError(400, "invalid memory Skill IDs");
    }
    const links = this.readSkillLinks();
    const unique = [...new Set(skillIds)];
    if (unique.length) links[historyId] = unique;
    else delete links[historyId];
    fs.mkdirSync(this.historyDirectory, { recursive: true });
    atomicWriteText(this.skillLinksFile, JSON.stringify(links));
    return this.snapshot();
  }

  private get skillLinksFile(): string {
    return path.join(this.historyDirectory, "skill-links.json");
  }

  private readSkillLinks(): Record<string, string[]> {
    try {
      if (fs.statSync(this.skillLinksFile).size > 1024 * 1024) return {};
      const parsed: unknown = JSON.parse(fs.readFileSync(this.skillLinksFile, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const result: Record<string, string[]> = Object.create(null);
      for (const [historyId, ids] of Object.entries(parsed)) {
        if (!Array.isArray(ids)) continue;
        const valid = [...new Set(ids.filter(validSkillMemoryId))].slice(0, 20);
        if (valid.length) result[historyId] = valid;
      }
      return result;
    } catch {
      return {};
    }
  }

  importMarkdown(input: { title?: string; markdown: string; sourceType?: ComputerHistorySourceType }): ComputerHistorySnapshot {
    const markdown = input.markdown.trim();
    if (!markdown) throw new ComputerHistoryApiError(400, "markdown is required");
    if (Buffer.byteLength(markdown, "utf8") > MAX_MARKDOWN_BYTES) {
      throw new ComputerHistoryApiError(413, "markdown is too large");
    }
    const sourceType = input.sourceType === "demo_fixture" ? "demo_fixture" : "imported";
    const title = cleanTitle(input.title || readFrontmatterValue(markdown, "title") || "Imported Computer History");
    const id = `${timestampForPath()}-${slug(title)}`;
    const normalized = ensureHistoryFrontmatter(markdown, { title, sourceType });
    fs.mkdirSync(this.historyDirectory, { recursive: true });
    fs.writeFileSync(path.join(this.historyDirectory, `${id}.md`), normalized, { encoding: "utf8", flag: "wx" });
    return this.snapshot();
  }

  private segmentId(at: Date): string {
    // Align segment ids to the ten-minute grid so their names sort and group
    // the same way Codex's do, and so the rollup can parse them back.
    return alignedId(at, SEGMENT_DURATION_MS);
  }

  private openSegment(): SegmentState {
    const now = new Date();
    const id = this.segmentId(now);
    const directory = path.join(this.segmentsDirectory, id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    fs.mkdirSync(this.historyDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.historyDirectory, 0o700);
    fs.mkdirSync(this.workflowDirectory, { recursive: true });
    const eventsFile = path.join(directory, "events.jsonl");
    const metadataFile = path.join(directory, "metadata.json");
    const priorMetadata = readText(metadataFile);
    let startedAt = now.toISOString();
    try {
      const previous = JSON.parse(priorMetadata ?? "{}");
      if (typeof previous.startedAt === "string"
        && this.segmentId(new Date(previous.startedAt)) === id) startedAt = previous.startedAt;
    } catch { /* A missing or invalid older timestamp does not prevent recording. */ }
    const historyFile = path.join(this.historyDirectory, `${id}-10min-summary.md`);
    this.invalidateSummary(historyFile);
    fs.rmSync(`${historyFile}.staging`, { force: true });
    fs.writeFileSync(
      metadataFile,
      `${JSON.stringify({ id, startedAt, eventsPath: eventsFile, state: "open" }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return {
      child: null,
      id,
      directory,
      startedAt,
      eventsFile,
      metadataFile,
      historyFile,
      output: "",
      stoppedByUser: false,
    };
  }

  private spawnRecorder(segment: SegmentState): void {
    const recorder = this.recorderScript;
    if (!this.platformDriver && !fs.existsSync(recorder)) throw new ComputerHistoryApiError(503, "recorder script is unavailable");
    segment.recorderStartedAtByte = fs.existsSync(segment.eventsFile) ? fs.statSync(segment.eventsFile).size : 0;
    segment.stoppedByUser = false;
    segment.output = "";
    const child = this.platformDriver ? this.platformDriver.launch({ title: `Computer History ${segment.id}`,
      eventsFile: segment.eventsFile, observationSettingsFile: this.observationSettings.filePath, weChatConsentFile: this.weChatConsent.filePath }) : spawn(process.execPath, [
      recorder,
      "--title", `Computer History ${segment.id}`,
      "--out", segment.eventsFile,
      "--no-screenshots",
      "--capture-search-text",
      "--capture-text",
      // The recorder evaluates the policy per event, because the website axis
      // depends on the URL each event carries.
      "--observation-settings", this.observationSettings.filePath,
      // Windows requires native window proof; filtered extension focus adds a
      // corroboration/veto rather than granting permission to unknown windows.
      ...(process.platform === "win32" ? ["--browser-authority", this.browserAuthorityPath] : []),
    ], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    segment.child = child;
    this.recorderSegments.set(child, segment);
    if (this.platformDriver?.ready) void this.platformDriver.ready(child).catch((error) => {
      if (this.segment?.child === child && this.observationState === "running") this.failObservation(error instanceof Error ? error.message : "recorder startup failed");
    });
    this.captureObserverStartedAt = Date.now();
    this.captureLastHeartbeatAt = null;
    // A normal segment rotation preserves a continuously healthy observer's
    // stability window; only a disconnect or user transition starts it over.
    this.recorderStableSince ??= Date.now();
    this.recorderChildren.add(child);
    child.once("exit", () => this.recorderChildren.delete(child));

    const append = (chunk: Buffer) => {
      if (this.segment?.child !== child) return;
      this.segment.output = appendLog(this.segment.output, chunk.toString("utf8"));
    };
    let healthBuffer = "";
    let discardHealthLine = false;
    const healthGeneration = this.captureHealthGeneration;
    child.stdout.on("data", (chunk: Buffer) => {
      const finalEventOnly = this.segment?.child !== child;
      if (healthGeneration !== this.captureHealthGeneration
        || (finalEventOnly && !this.captureHealthDrainingChildren.has(child))) return;
      // Bound incomplete/untrusted stdout lines. No rejected payload is logged
      // or copied to health state, where observed text or credentials could leak.
      for (const piece of chunk.toString("utf8").split(/(?<=\n)/u)) {
        if (!discardHealthLine) healthBuffer += piece;
        if (healthBuffer.length > 4_096) { healthBuffer = ""; discardHealthLine = true; }
        if (piece.endsWith("\n")) {
          if (!discardHealthLine) {
            const line = healthBuffer.trimEnd();
            if (line === CONTINUOUS_RECORDER_CAPABILITY) this.continuousRecorderChildren.add(child);
            else if (line.startsWith(RECORDER_HEALTH_PREFIX)) this.ingestRecorderHealthLine(line, finalEventOnly);
            else append(Buffer.from(healthBuffer));
          }
          healthBuffer = "";
          discardHealthLine = false;
        }
      }
    });
    child.stderr.on("data", append);
    child.once("error", (error) => {
      if (!child.pid) this.recorderChildren.delete(child);
      if (this.segment?.child !== child) return;
      this.failObservation(error.message);
    });
    child.once("exit", (code) => {
      const segment = this.recorderSegments.get(child)!;
      if (this.platformDriver?.stop && this.segment?.child === child && this.observationState === "running") {
        // exit precedes pipe close: the managed driver must validate terminal status and
        // fully drained output before an independent exit can finish observation.
        void this.stopRecorderChild(child).then(() => {
          if (this.segment?.child !== child || this.observationState !== "running") return;
          segment.child = null;
          return this.stopObservation();
        }).catch((error) => {
          if (this.segment?.child === child || this.segment === segment) this.failObservation(error instanceof Error ? error.message : "recorder shutdown failed");
        });
        return;
      }
      const stopReason = recorderUserStopReason(segment.eventsFile, segment.recorderStartedAtByte ?? 0);
      const reason = code === 0 ? stopReason : null;
      // Preserve an explicit stop even when an overlapping pause/rotation has
      // already detached this child. Its own SIGTERM produces user_interrupt,
      // which must continue to mean the API transition rather than a hotkey.
      if (reason === "stop_hotkey" || reason === "user_stop") segment.stoppedByUser = true;
      if (this.segment?.child !== child) return;
      // Pausing, rotating and stopping all detach the child first, so reaching
      // here means the recorder exited independently of an API transition.
      if (this.observationState !== "running") return;
      if (reason) {
        segment.child = null;
        // Use the same transition as the API: it closes the window once and
        // prepares narration without waiting for the model. A previous run's
        // stop marker cannot authorize this exit in a reused time bucket.
        void this.stopObservation().catch((error) => {
          if (this.segment === segment) this.failObservation(error instanceof Error ? error.message : String(error));
        });
        return;
      }
      this.clearLiveSummaryTimer();
      this.clearRotationTimer();
      this.clearWeChatPolling();
      const message = segment.output.trim() || `recorder exited with code ${code}`;
      if (!isHistoryStreamDisconnect(message) || this.platformDriver?.permissionError(message)) {
        this.observationError = message;
        this.observationState = "failed";
      }
      // Exit can precede the last stderr chunk. Keep this child's output until
      // close before deciding whether the native socket failure is retryable.
      // A user transition can cancel this wait immediately: the writer exited,
      // so Stop/Pause need not wait for an inherited stdout/stderr descriptor.
      const version = this.recorderReconnectVersion;
      let drainTimer: ReturnType<typeof setTimeout> | null = null;
      const cancel = () => {
        if (drainTimer) clearTimeout(drainTimer);
        child.removeListener("close", complete);
        if (this.recorderExitDrain?.child === child) this.recorderExitDrain = null;
      };
      const complete = () => {
        cancel();
        if (version !== this.recorderReconnectVersion || this.shuttingDown || this.segment?.child !== child) return;
        const completeMessage = segment.output.trim() || `recorder exited with code ${code}`;
        if (!stopReason && isHistoryStreamDisconnect(completeMessage) && !this.platformDriver?.permissionError(completeMessage)) {
          this.scheduleRecorderReconnect(segment, completeMessage);
        } else {
          if (stopReason) this.saveRecordingIntent("stopped");
          this.failObservation(completeMessage);
        }
      };
      this.recorderExitDrain = { child, cancel };
      child.once("close", complete);
      drainTimer = setTimeout(complete, RECORDER_EXIT_DRAIN_MS);
    });
  }

  private resetCaptureHealth(): void {
    ++this.captureHealthGeneration;
    this.captureObserverStartedAt = null;
    this.captureLastEventAt = null;
    this.captureLastHeartbeatAt = null;
    this.captureHeartbeatSupported = false;
    this.captureIssues.clear();
    this.captureObserverReadyAt = 0;
    this.captureSnapshotReadyAt = 0;
    this.captureInputReadyAt = 0;
  }

  private ingestRecorderHealthLine(line: string, finalEventOnly = false): void {
    if (!line.startsWith(RECORDER_HEALTH_PREFIX)) return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line.slice(RECORDER_HEALTH_PREFIX.length));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch { return; }
    const { timestamp, code, count } = message;
    if (finalEventOnly && code !== "event_recorded") return;
    if (typeof timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(timestamp)
      || typeof code !== "string") return;
    const at = Date.parse(timestamp);
    if (!Number.isFinite(at) || at > Date.now() + 5_000
      || (this.captureObserverStartedAt !== null && at < this.captureObserverStartedAt - 5_000)) return;
    const normalized = new Date(at).toISOString();
    if (code === "heartbeat") {
      this.captureHeartbeatSupported = true;
      if (!this.captureLastHeartbeatAt || at >= Date.parse(this.captureLastHeartbeatAt)) this.captureLastHeartbeatAt = normalized;
    } else if (code === "event_recorded") {
      if (!this.captureLastEventAt || at >= Date.parse(this.captureLastEventAt)) this.captureLastEventAt = normalized;
    } else if (code === "ax_snapshot_ready") {
      // Only the consumer emits this after a complete authorized tree reaches
      // disk (or matches its persisted baseline). Input and heartbeat signals
      // say nothing about whether window contents can be read.
      this.captureSnapshotReadyAt = Math.max(this.captureSnapshotReadyAt, at);
      const previous = this.captureIssues.get("ax_snapshot_failed");
      if (previous && at >= previous.lastAt) previous.active = false;
    } else if (code === "input_monitoring_ready") {
      this.captureInputReadyAt = Math.max(this.captureInputReadyAt, at);
      const previous = this.captureIssues.get("input_monitoring_unavailable");
      if (previous && at >= previous.lastAt) previous.active = false;
    } else if (code === "observer_ready") {
      this.captureHeartbeatSupported = true;
      this.captureObserverReadyAt = Math.max(this.captureObserverReadyAt, at);
      if (!this.captureLastHeartbeatAt || at >= Date.parse(this.captureLastHeartbeatAt)) this.captureLastHeartbeatAt = normalized;
      for (const issue of ["observer_unavailable", "observer_notifications_unavailable"]) {
        const previous = this.captureIssues.get(issue);
        if (previous && at >= previous.lastAt) previous.active = false;
      }
    } else if (CAPTURE_ISSUE_CODES.has(code)) {
      if (count !== undefined && (!Number.isSafeInteger(count) || (count as number) < 1)) return;
      this.captureCoverageGaps.add(code, at);
      const previous = this.captureIssues.get(code);
      const readyAt = code === "input_monitoring_unavailable" ? this.captureInputReadyAt
        : code === "ax_snapshot_failed" ? this.captureSnapshotReadyAt
        : code === "observer_unavailable" || code === "observer_notifications_unavailable" ? this.captureObserverReadyAt : 0;
      this.captureIssues.set(code, {
        count: Math.min(Number.MAX_SAFE_INTEGER, (previous?.count ?? 0) + (typeof count === "number" ? count : 1)),
        lastAt: Math.max(previous?.lastAt ?? 0, at),
        active: at <= readyAt ? (previous?.active ?? false)
          : previous && at <= previous.lastAt ? previous.active : true,
      });
    }
  }

  private captureHealth(): ComputerHistoryCaptureHealth {
    const now = Date.now();
    const windows = process.platform === "win32";
    const issues: Array<{ code: string; count: number }> = [];
    let activeIssue = false;
    for (const [code, issue] of this.captureIssues) {
      if (issue.active && code !== "observer_unavailable" && code !== "observer_notifications_unavailable" && code !== "input_monitoring_unavailable" && code !== "ax_snapshot_failed"
        && now - issue.lastAt >= CAPTURE_ISSUE_RECOVERY_MS
        && this.captureLastEventAt && Date.parse(this.captureLastEventAt) > issue.lastAt
        && ((windows && !this.captureHeartbeatSupported)
          || (this.captureLastHeartbeatAt && Date.parse(this.captureLastHeartbeatAt) > issue.lastAt))) {
        issue.active = false;
      }
      activeIssue ||= issue.active;
      if (issue.active) issues.push({ code, count: issue.count });
    }
    const reconnecting = this.observationState === "running"
      && (this.recorderReconnectTimer !== null || this.recorderExitDrain !== null || !this.segment?.child);
    const expectsHeartbeat = !windows || this.captureHeartbeatSupported;
    const heartbeatMissing = expectsHeartbeat && this.observationState === "running" && !reconnecting
      && this.captureObserverStartedAt !== null
      && now - (this.captureLastHeartbeatAt ? Date.parse(this.captureLastHeartbeatAt) : this.captureObserverStartedAt) > CAPTURE_HEARTBEAT_TIMEOUT_MS;
    if (heartbeatMissing) issues.push({ code: "heartbeat_missing", count: 1 });
    const status: ComputerHistoryCaptureHealth["status"] = this.observationState === "failed" ? "degraded"
      : this.observationState !== "running" ? "inactive"
      : reconnecting ? "reconnecting"
      : activeIssue || heartbeatMissing ? "degraded"
      : (expectsHeartbeat ? !this.captureLastHeartbeatAt : !this.captureLastEventAt) ? "starting"
      : "healthy";
    return { status, lastEventAt: this.captureLastEventAt, lastHeartbeatAt: this.captureLastHeartbeatAt,
      issues: status === "inactive" ? [] : issues,
      limitations: [windows ? "foreground_events_and_accessibility_only" : "foreground_accessibility_only",
        "screenshots_and_audio_not_recorded"] };
  }

  private cancelRecorderReconnect(): void {
    ++this.recorderReconnectVersion;
    if (this.recorderReconnectTimer) clearTimeout(this.recorderReconnectTimer);
    this.recorderReconnectTimer = null;
    this.recorderStableSince = null;
    this.recorderExitDrain?.cancel();
  }

  private scheduleRecorderReconnect(segment: SegmentState, message: string): void {
    if (this.recorderStableSince !== null && Date.now() - this.recorderStableSince >= RECORDER_RECONNECT_STABLE_MS) {
      this.recorderReconnectAttempts = 0;
    }
    this.recorderStableSince = null;
    const delay = RECORDER_RECONNECT_DELAYS_MS[this.recorderReconnectAttempts];
    if (delay === undefined) {
      console.warn("[Computer History] Native event stream reconnect attempts exhausted:", message);
      this.failObservation(`Computer History recording disconnected after ${RECORDER_RECONNECT_DELAYS_MS.length} reconnect attempts`);
      return;
    }
    ++this.recorderReconnectAttempts;
    segment.child = null;
    // Running is the user's retained intent during a short socket outage.
    // Only the recorder restarts; explicit Stop/Pause and consent checks win.
    this.observationState = "running";
    this.observationError = null;
    const version = ++this.recorderReconnectVersion;
    this.recorderReconnectTimer = setTimeout(() => {
      this.recorderReconnectTimer = null;
      void this.reconnectRecorder(segment, version).catch((error) => {
        if (version !== this.recorderReconnectVersion || this.shuttingDown) return;
        this.failObservation(error instanceof Error ? error.message : String(error));
      });
    }, delay);
  }

  private async reconnectRecorder(previous: SegmentState, version: number): Promise<void> {
    const current = () => version === this.recorderReconnectVersion && !this.shuttingDown
      && this.observationState === "running" && this.segment === previous && !previous.child;
    if (!current()) return;
    const permissions = await this.checkPermissions();
    if (!current()) return;
    if (!permissions.supported) throw new ComputerHistoryApiError(400, "Computer History recording requires macOS or Windows 11");
    if (!permissions.accessibility || !permissions.inputMonitoring) {
      void this.finalizeSegment(previous);
      this.completeObservationStop();
      return;
    }
    this.ensureObservationSettings();
    this.assertObservesSomething();
    if (previous.id !== this.segmentId(new Date())) {
      void this.finalizeSegment(previous);
      this.segment = null;
      this.segment = this.openSegment();
    }
    this.spawnRecorder(this.segment!);
    this.startLiveSummaryTimer();
    this.startRotationTimer();
    this.startWeChatPolling();
  }

  private failObservation(message: string): void {
    const permission = this.platformDriver?.permissionError(message);
    this.cancelRecorderReconnect();
    this.clearLiveSummaryTimer();
    this.clearRotationTimer();
    this.clearWeChatPolling();
    const segment = this.segment;
    if (segment) {
      const child = segment.child;
      segment.child = null;
      const finalize = () => {
        this.historyLease?.(); this.historyLease = null;
        // Finalization writes the closed evidence before its first await. A
        // fresh same-bucket open then invalidates any pending model response.
        void this.finalizeSegment(segment);
        if (this.segment === segment) this.segment = null;
      };
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        void this.trackRecorderTransition(async () => {
          await this.stopRecorderChild(child);
          finalize();
        });
      } else {
        finalize();
      }
    }
    if (permission === "accessibility" || permission === "inputMonitoring") {
      // Permission can be revoked between preflight and the event tap startup.
      this.permissions = { supported: true, accessibility: !message.includes("Accessibility"), inputMonitoring: !message.includes("Input Monitoring") };
      this.observationError = null;
      this.completeObservationStop();
    } else {
      this.observationError = message;
      this.observationState = "failed";
      this.browserAuthoritySuspended = true;
      this.clearBrowserAuthority();
    }
  }

  private clearRotationTimer(): void {
    if (this.rotationTimer) clearTimeout(this.rotationTimer);
    this.rotationTimer = null;
  }

  private startRotationTimer(): void {
    this.clearRotationTimer();
    const delay = SEGMENT_DURATION_MS - Date.now() % SEGMENT_DURATION_MS;
    this.rotationTimer = setTimeout(() => {
      this.rotationTimer = null;
      if (this.observationState !== "running") return;
      this.rotateSegment();
    }, delay);
  }

  private trackRecorderTransition(operation: () => Promise<void>): Promise<void> {
    const pending = operation().catch((error) => {
      if (this.platformDriver?.stop) this.failObservation(error instanceof Error ? error.message : "recorder transition failed");
      throw error;
    }).finally(() => {
      if (this.recorderTransition === pending) this.recorderTransition = null;
    });
    this.recorderTransition = pending;
    return pending;
  }

  private stopRecorderChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    const pending = this.recorderExits.get(child);
    if (pending) return pending;
    // Failed spawn has no process to signal and emits error/close, not exit.
    if (!child.pid) {
      this.recorderChildren.delete(child);
      return Promise.resolve();
    }
    // Install the exit listener before signalling, including for test doubles
    // and a child that exits immediately in its signal handler.
    const exited = (this.platformDriver?.stop ? this.platformDriver.stop(child) : waitForExit(child, 8_000)).then(() => {
      this.recorderChildren.delete(child);
    }).finally(() => this.recorderExits.delete(child));
    this.recorderExits.set(child, exited);
    if (!this.platformDriver?.stop && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    return exited;
  }

  private async detachRecorder(segment: SegmentState): Promise<void> {
    const child = segment.child;
    if (!child) return;
    segment.child = null;
    this.captureHealthDrainingChildren.add(child);
    // Process exit can precede the final stdout chunk. Do not delay the stop
    // transition, but accept this run's final written-event timestamp until
    // stdio closes, with a bound for inherited descriptors that stay open.
    let closed = false;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    const finishDrain = () => {
      closed = true;
      if (drainTimer) clearTimeout(drainTimer);
      child.removeListener("close", finishDrain);
      this.captureHealthDrainingChildren.delete(child);
    };
    child.once("close", finishDrain);
    try {
      await this.stopRecorderChild(child);
      if (!closed) {
        drainTimer = setTimeout(finishDrain, RECORDER_EXIT_DRAIN_MS);
        drainTimer.unref?.();
      }
    } catch (error) {
      finishDrain();
      throw error;
    }
  }

  /**
   * Summarizes a closed segment and leaves it behind as searchable history.
   *
   * A segment narrated while it was open already stands on the timeline, and
   * regenerating it in place would put the placeholder back over that account
   * until the model caught up — an entry that blinks out and returns, or, if
   * the model is unreachable, never returns at all. So the fuller summary is
   * built beside the standing one and swapped in only once it is written.
   * Nothing on disk ever says less than it did a moment ago.
   */
  private async finalizeSegment(segment: SegmentState): Promise<void> {
    if (!segmentHasActivity(segment.eventsFile)) return;
    this.invalidateSummary(segment.historyFile);
    const staging = `${segment.historyFile}.staging`;
    const destination = isSummaryWritten(segment.historyFile) ? staging : segment.historyFile;
    const error = this.writeSegmentSummary(segment, destination, true);
    if (error) {
      this.observationError = error;
      fs.rmSync(staging, { force: true });
      return;
    }
    this.narratedOpenSegments.delete(segment.id);
    const summaryId = path.basename(segment.historyFile, ".md");
    const written = await this.writeSummaryWith(destination, "10min", segment.eventsFile, summaryId);
    // Failed replacements remain staged for the next pass. A deleted or
    // superseded request returns false and must not create a derived rollup.
    if (written) this.writeSixHourRollup(segment.id);
  }

  /**
   * Rewrites a finished summary's title and description with a model-written
   * account of the window.
   *
   * Deliberately fire-and-forget: the mechanical summary is already on disk, so
   * a slow or unreachable model delays the better wording, never the recording.
   */
  private narrateSummary(file: string, window: "10min" | "6h", eventsFile: string | null): void {
    void this.writeSummaryWith(file, window, eventsFile).catch((error) => {
      this.setNarrationError(error instanceof Error ? error.message : String(error));
    });
  }

  private invalidateSummary(file: string): void {
    this.summaryVersions.set(file, (this.summaryVersions.get(file) ?? 0) + 1);
  }

  /** Never replace the only written account of a source that is no longer available. */
  private preservesRollupCoverage(destination: string, candidate: string): boolean {
    const standing = readText(destination);
    if (!standing || !isNarrated(standing)) return true;
    const id = path.basename(destination, ".md");
    const proposed = new Set(rollupCoveredHistoryIds(candidate, id));
    if (rollupCoveredHistoryIds(standing, id).every((source) => proposed.has(source))) return true;
    // This path may already be queued or at the model. Invalidate its response
    // and remove the unsafe replacement while retaining the standing account.
    this.invalidateSummary(destination);
    fs.rmSync(`${destination}.staging`, { force: true });
    return false;
  }

  /** Share a request only while its input version, runtime, and output language match. */
  private writeSummaryWith(
    file: string,
    window: "10min" | "6h",
    eventsFile: string | null,
    summaryId?: string,
  ): Promise<boolean> {
    const llmRuntime = this.llmRuntime;
    if (!llmRuntime || this.shuttingDown) {
      if (!llmRuntime && !this.shuttingDown && !this.narrationError) {
        this.setNarrationError("Computer History summary is pending: no model runtime is available");
      }
      return Promise.resolve(false);
    }
    const destination = file.endsWith(".staging") ? file.slice(0, -".staging".length) : file;
    if (window === "6h") {
      const windowStart = instantFromId(path.basename(destination, ".md"));
      // Existing pending files from the former incremental implementation can
      // survive an upgrade. Keep them off the model path until the complete
      // window is available, just like newly prepared rollups.
      if (!windowStart || !isSixHourWindowClosed(windowStart)) return Promise.resolve(false);
    }
    const version = this.summaryVersions.get(destination) ?? 0;
    const language = this.summaryLanguage();
    const active = this.summaryJobs.get(destination);
    if (active?.version === version && active.runtime === llmRuntime && active.language === language) return active.promise;
    const markdown = readText(file);
    if (!markdown) return Promise.resolve(false);
    const containsWeChat = containsWeChatEvidence(markdown);
    const weChatConsentId = this.weChatConsent.read().consentId;
    if (containsWeChat && !weChatConsentId) return Promise.resolve(false);
    if (window === "6h" && !this.preservesRollupCoverage(destination, markdown)) return Promise.resolve(false);
    const isCurrent = () => !this.shuttingDown
      && this.llmRuntime === llmRuntime
      && this.summaryLanguage() === language
      && (!containsWeChat || this.weChatConsent.read().consentId === weChatConsentId)
      && (this.summaryVersions.get(destination) ?? 0) === version
      && readText(file) === markdown;
    const promise = this.narratePreparedSummary(
      file, destination, window, eventsFile, summaryId, markdown, llmRuntime, language, isCurrent,
    ).finally(() => {
      if (this.summaryJobs.get(destination)?.promise === promise) this.summaryJobs.delete(destination);
    });
    this.summaryJobs.set(destination, { version, runtime: llmRuntime, language, promise });
    return promise;
  }

  private async narratePreparedSummary(
    file: string,
    destination: string,
    window: "10min" | "6h",
    eventsFile: string | null,
    summaryId: string | undefined,
    markdown: string,
    llmRuntime: LLMRuntimeResolver,
    language: MemmyOutputLanguage | undefined,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    // A segment is narrated from its own event stream, compacted into activity
    // arcs. A rollup has no stream of its own and is narrated from the
    // ten-minute summaries it already gathered.
    let evidence = markdown.replace(/^---\n[\s\S]*?\n---\n/u, "");
    if (eventsFile) {
      try {
        const compacted = compactEventEvidence(fs.readFileSync(eventsFile, "utf8").split("\n"),
          { weChatNames: this.weChatNameMap() });
        if (compacted) evidence = compacted;
      } catch {
        // Fall back to the mechanical summary body.
      }
    } else if (window === "10min") {
      const retained = this.readRetentionCheckpoint(path.basename(destination, ".md"));
      if (retained) evidence = retained.evidence;
    }
    const narrative = await writeSegmentNarrative(llmRuntime, {
      applications: applicationsFromMarkdown(markdown),
      evidence,
      window,
      language,
      priorSummaries: this.priorSummaries(summaryId ?? path.basename(destination, ".md")),
      onError: (reason, category) => {
        // Narration is best effort, but a silent no-op is indistinguishable
        // from a feature that was never wired, so say why it produced nothing.
        if (!isCurrent()) return;
        this.setNarrationError(reason, category);
        console.warn(`[computer-history] summary narration skipped: ${reason}`);
      },
    });
    if (!narrative || !isCurrent()) return false;
    try {
      // Recheck at commit too: another writer may have supplied a fuller
      // standing account while this candidate was being narrated.
      if (window === "6h" && !this.preservesRollupCoverage(destination, markdown)) return false;
      // The body must describe exactly the evidence sent to the model. Never
      // combine an old response with a file another pass has since rewritten.
      atomicWriteText(destination, applyNarrative(markdown, narrative));
      if (file !== destination) fs.rmSync(file, { force: true });
      this.setNarrationError(null);
      if (window === "10min") this.memoryAdapter.schedule();
      return true;
    } catch (error) {
      this.setNarrationError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /** Builds the final six-hour summary once the segment closes its whole window. */
  private writeSixHourRollup(segmentId: string): void {
    const at = instantFromId(segmentId);
    if (!at) return;
    const rollupFile = this.writeRollupFor(sixHourWindowStart(at));
    if (rollupFile) this.narrateSummary(rollupFile, "6h", null);
  }

  private storedTenMinuteSummaries(): SummaryInput[] {
    return this.readMarkdownDirectory(this.historyDirectory)
      .filter((entry) => canonicalSegmentId(entry.id) !== null)
      .map((entry) => ({ name: `${entry.id}.md`, markdown: entry.markdown }));
  }

  /** One preparation per eligible local window, including already-ready history. */
  private prepareRollups(): string[] {
    const summaries = this.storedTenMinuteSummaries();
    const windows = new Map<number, Date>();
    for (const summary of summaries) {
      if (!isCompletedCapturedSummary(summary)) continue;
      const start = sixHourWindowStart(instantFromId(summary.name)!);
      windows.set(start.getTime(), start);
    }
    return [...windows.values()].sort((left, right) => left.getTime() - right.getTime())
      .map((start) => this.writeRollupFor(start, summaries))
      .filter((file): file is string => file !== null);
  }

  /** Writes the mechanical six-hour summary for a closed window; the model writes it later. */
  private writeRollupFor(windowStart: Date, summaries = this.storedTenMinuteSummaries()): string | null {
    // Ten-minute summaries provide the live view while this window is open.
    // Preparing a partial rollup here used to trigger up to 36 model rewrites
    // for one final account and made its meaning change every ten minutes.
    if (!isSixHourWindowClosed(windowStart)) return null;
    if (this.hasPendingTenMinuteSummary(windowStart)) return null;
    const rollup = buildSixHourSummary(summaries, windowStart);
    if (!rollup) return null;
    const rollupFile = path.join(this.historyDirectory, rollup.fileName);
    // A user-deleted rollup is different from one an older version forgot to
    // build. Its sources remain readable without recreating the deleted item.
    if (fs.existsSync(`${rollupFile}.deleted`)) return null;
    if (!this.preservesRollupCoverage(rollupFile, rollup.markdown)) return null;
    const inputHash = hashText(rollup.markdown);
    const standing = readText(rollupFile);
    const staged = `${rollupFile}.staging`;
    const pending = readText(staged);
    const matchesInput = (markdown: string) => (
      readFrontmatterValue(markdown, "summary_input_hash") === inputHash
      && JSON.stringify(rollupCoveredHistoryIds(markdown, rollup.id + "-6h-summary")) === JSON.stringify(rollup.coveredHistoryIds)
    );
    if (standing && isNarrated(standing) && matchesInput(standing)) {
      // A completed account wins over any abandoned replacement. Otherwise a
      // staging path queued earlier in the pass could overwrite current prose
      // with older membership even though this preparation needs no new work.
      if (pending !== null) {
        this.invalidateSummary(rollupFile);
        fs.rmSync(staged, { force: true });
      }
      return null;
    }
    if (pending && matchesInput(pending)) return staged;
    const destination = standing && isNarrated(standing) ? staged : rollupFile;
    const markdown = rollup.markdown.replace(/^---\n/u, `---\nsummary_input_hash: ${inputHash}\n`);
    if (readText(destination) !== markdown) {
      this.invalidateSummary(rollupFile);
      atomicWriteText(destination, markdown);
    }
    return destination;
  }

  /** Wait until every captured source in the closed window has finished narration. */
  private hasPendingTenMinuteSummary(windowStart: Date): boolean {
    if (!fs.existsSync(this.historyDirectory)) return false;
    const start = windowStart.getTime();
    const end = start + SIX_HOUR_MS;
    return fs.readdirSync(this.historyDirectory).some((name) => {
      const destinationName = name.endsWith(".md.staging") ? name.slice(0, -".staging".length) : name;
      if (!destinationName.endsWith("-10min-summary.md")) return false;
      const id = destinationName.slice(0, -3);
      const at = instantFromId(id)?.getTime();
      if (at === undefined || at < start || at >= end) return false;
      const markdown = readText(path.join(this.historyDirectory, name));
      if (!markdown) return false;
      const source = readFrontmatterValue(markdown, "source_type");
      return (source === "captured" || source === "human_computer_history")
        && readFrontmatterValue(markdown, "status") === "completed"
        && !isNarrated(markdown);
    });
  }

  /**
   * Replaces six-hour summaries cut on the old epoch-aligned windows.
   *
   * Keep written accounts until ready replacements demonstrably cover their
   * cited sources. Removing them before narration lost the only readable copy
   * when the model was unavailable or the old source files no longer existed.
   */
  realignRollups(): number {
    let names: string[];
    try {
      names = fs.readdirSync(this.historyDirectory);
    } catch {
      return 0;
    }
    const misaligned = [...new Set(names.map((name) => name.replace(/\.staging$/u, "")))].filter((name) => {
      if (!name.endsWith("-6h-summary.md")) return false;
      const start = instantFromId(name);
      return start !== null && !isLocalSixHourWindow(start);
    });
    let removed = 0;
    for (const name of misaligned) {
      const file = path.join(this.historyDirectory, name);
      const standing = readText(file);
      if (!standing || !isNarrated(standing)) {
        this.removeStoredHistory(name.slice(0, -3));
        removed += 1;
      } else if (fs.existsSync(`${file}.staging`)) {
        this.invalidateSummary(file);
        fs.rmSync(`${file}.staging`, { force: true });
      }
    }
    this.prepareRollups();
    return removed + this.removeSupersededRollups();
  }

  private removeSupersededRollups(): number {
    const rollups = this.readMarkdownDirectory(this.historyDirectory)
      .filter((entry) => entry.summaryWindow === "6h" && isNarrated(entry.markdown));
    const replaced = new Set(rollups.filter((entry) => {
      const at = instantFromId(entry.id);
      return at && isLocalSixHourWindow(at);
    }).flatMap((entry) => entry.coveredHistoryIds));
    let removed = 0;
    for (const entry of rollups) {
      const at = instantFromId(entry.id);
      if (!at || isLocalSixHourWindow(at) || !entry.coveredHistoryIds.length) continue;
      if (entry.coveredHistoryIds.every((id) => replaced.has(id))) {
        this.removeStoredHistory(entry.id);
        removed += 1;
      }
    }
    return removed;
  }

  private rotateSegment(): void {
    const previous = this.segment;
    if (!previous || this.recorderTransition || this.shuttingDown) return;
    void this.trackRecorderTransition(async () => {
      if (previous.child && (this.platformDriver?.rotate || this.continuousRecorderChildren.has(previous.child))) {
        const child = previous.child;
        const next = this.openSegment();
        next.recorderStartedAtByte = fs.existsSync(next.eventsFile) ? fs.statSync(next.eventsFile).size : 0;
        const launch = { title: `Computer History ${next.id}`, eventsFile: next.eventsFile,
          observationSettingsFile: this.observationSettings.filePath, weChatConsentFile: this.weChatConsent.filePath };
        if (this.platformDriver?.rotate) await this.platformDriver.rotate(child, launch);
        else await rotateRecorderOutput(child, { title: launch.title, eventsFile: launch.eventsFile });
        previous.child = null; next.child = child;
        this.recorderSegments.set(child, next); this.segment = next;
        void this.finalizeSegment(previous);
        if (this.observationState === "running" && !this.shuttingDown) this.startRotationTimer();
        return;
      }
      await this.detachRecorder(previous);
      // Not awaited: the entry already on the timeline stays right while the
      // model writes the fuller one, so nothing is held up waiting for it.
      void this.finalizeSegment(previous);
      if (previous.stoppedByUser && this.segment === previous) {
        this.completeObservationStop();
        return;
      }
      if (this.observationState !== "running" || this.shuttingDown || this.segment !== previous) return;
      const next = this.openSegment();
      this.segment = next;
      try {
        this.spawnRecorder(next);
        this.startRotationTimer();
      } catch (error) {
        this.failObservation(error instanceof Error ? error.message : String(error));
      }
    }).catch((error) => this.failObservation(error instanceof Error ? error.message : String(error)));
  }

  startObservation(forEventSubscription = false): ComputerHistorySnapshot {
    if (!forEventSubscription && this.eventCaptureBootstrap) { this.eventCaptureBootstrap = null; this.eventCaptureIntent = "running"; }
    if (this.eventCaptureActive && this.observationState === "running") {
      this.eventCaptureIntent = "running"; this.saveRecordingIntent("running"); return this.snapshot();
    }
    if (collectorGate.taskActive) throw new CollectorBusyError();
    this.assertNativeRecordingCompatibility();
    if (this.shuttingDown || this.recorderTransition || this.recorderExitDrain || this.observationState === "stopping") {
      throw new ComputerHistoryApiError(409, "Computer History is finishing a recorder transition");
    }
    if (this.observationState === "running") {
      throw new ComputerHistoryApiError(409, "Computer History is already running");
    }
    this.cancelRecorderReconnect();
    this.recorderReconnectAttempts = 0;
    this.resetCaptureHealth();
    if (this.platformDriver?.prepare) this.platformDriver.prepare();
    else { this.ensureObservationSettings(); this.assertObservesSomething(); }
    this.cleanupExpiredRecordings();
    if (this.segment && this.segment.id !== this.segmentId(new Date())) {
      void this.finalizeSegment(this.segment);
      this.segment = null;
    }
    const segment = this.segment ?? this.openSegment();
    this.segment = segment;
    this.observationStartedAt ??= new Date().toISOString();
    this.observationError = null;
    this.observationState = "running";
    this.browserAuthoritySuspended = false;
    this.publishBrowserAuthority?.();
    try {
      if (!this.platformDriver) this.historyLease ??= collectorGate.acquire("history");
      this.spawnRecorder(segment);
    } catch (error) {
      this.failObservation(error instanceof Error ? error.message : String(error));
      throw error;
    }
    this.saveRecordingIntent("running");
    this.startLiveSummaryTimer();
    this.startRotationTimer();
    this.startWeChatPolling();
    return this.snapshot();
  }

  async checkPermissions(): Promise<HistoryPermissions> {
    // Windows UI Automation needs a signed-in desktop, but no TCC-style grant.
    // The app's recording confirmation remains the explicit consent boundary.
    const status = await this.permissionReader();
    this.permissions = status;
    return status;
  }

  async openPermission(permission: HistoryPermission, mode: "request" | "settings" = "settings"): Promise<HistoryPermissions> {
    this.permissions = this.platformDriver
      ? await this.platformDriver.openPermission(permission, mode) : await this.permissionReader(permission);
    return this.permissions;
  }

  /** Missing consent is an onboarding state, before creating any recording. */
  async startObservationWithPermissions(resume = false, forEventSubscription = false): Promise<ComputerHistorySnapshot> {
    if (!forEventSubscription && this.eventCaptureBootstrap) { this.eventCaptureBootstrap = null; this.eventCaptureIntent = "running"; }
    if (collectorGate.taskActive) throw new CollectorBusyError();
    this.assertNativeRecordingCompatibility();
    const version = ++this.permissionStartVersion;
    this.permissionStarts++;
    let status: HistoryPermissions;
    try { status = await this.checkPermissions(); } finally { this.permissionStarts--; }
    if (version !== this.permissionStartVersion || this.shuttingDown) return this.snapshot();
    if (!status.supported) throw new ComputerHistoryApiError(400, "Computer History recording is unavailable on this platform");
    if (!historyPermissionsReady(status)) {
      this.observationError = null;
      if (this.observationState === "failed") {
        if (this.segment) void this.finalizeSegment(this.segment);
        this.completeObservationStop();
      }
      return this.snapshot();
    }
    const snapshot = resume ? this.resumeObservation(forEventSubscription) : this.startObservation(forEventSubscription);
    const child = this.segment?.child;
    if (child && this.platformDriver?.ready) {
      try { await this.platformDriver.ready(child); }
      catch (error) {
        if (this.segment?.child === child) await this.detachRecorder(this.segment).catch(() => {});
        this.failObservation(error instanceof Error ? error.message : "recorder startup failed");
        throw new ComputerHistoryApiError(503, this.observationError ?? "recorder startup failed");
      }
      return this.snapshot();
    }
    return snapshot;
  }

  private assertNativeRecordingCompatibility(): void {
    if (!isMacNativeRuntimeSupported()) {
      throw new ComputerHistoryApiError(400, "Computer History recording requires macOS 14 or later. Existing History remains available.");
    }
  }

  /**
   * Makes the legacy Mac policy explicit before the recorder reads it.
   * Windows uses its driver's prepare() and separate explicit-consent store.
   *
   * Writing the defaults out on first start means the recorder parses one
   * unambiguous file instead of inferring a policy from a missing one, and it
   * gives the user something to edit. A file that exists but does not parse is
   * an error state rather than a policy, so it stops the start instead of
   * falling back to something they did not choose.
   */
  private ensureObservationSettings(): void {
    const file = this.observationSettings.filePath;
    if (!fs.existsSync(file)) {
      this.observationSettings.write(DEFAULT_OBSERVATION_SETTINGS);
      return;
    }
    try {
      parseObservationSettings(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (error) {
      throw new ComputerHistoryApiError(
        400,
        `Computer History settings at ${file} are not valid: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Refuses to start when the policy would record nothing.
   *
   * The legacy Mac default observes everything, so this only fires for someone who
   * deliberately switched to an allowlist and then left it empty. Starting
   * anyway would look like it was recording while producing empty segments,
   * so say what is missing instead.
   */
  private assertObservesSomething(): void {
    const { observation } = this.observationSettings.read();
    if (observation.defaultApplicationBehavior === "observe") return;
    const allowsAnyApp = observation.rules.some(
      (rule) => rule.scope === "app" && rule.behavior === "observe",
    );
    if (allowsAnyApp) return;
    throw new ComputerHistoryApiError(
      400,
      "Computer History observes nothing yet: allow at least one application, "
        + `or set defaultApplicationBehavior to "observe", in ${this.observationSettings.filePath}`,
    );
  }

  /** Keeps the current segment but stops writing to it. */
  async pauseObservation(): Promise<ComputerHistorySnapshot> {
    if (this.eventCaptureActive && this.observationState === "running" && !this.shuttingDown) {
      this.eventCaptureIntent = "paused"; this.saveRecordingIntent("paused"); return this.snapshot();
    }
    if (this.recorderTransition || this.shuttingDown) {
      throw new ComputerHistoryApiError(409, "Computer History is finishing a recorder transition");
    }
    const drainingExit = this.recorderExitDrain !== null;
    if (this.observationState !== "running" && !(drainingExit && this.observationState === "failed")) {
      throw new ComputerHistoryApiError(409, "Computer History is not running");
    }
    this.browserAuthoritySuspended = true;
    this.clearBrowserAuthority();
    ++this.permissionStartVersion;
    this.cancelRecorderReconnect();
    this.clearLiveSummaryTimer();
    this.clearRotationTimer();
    this.clearWeChatPolling();
    await this.trackRecorderTransition(async () => {
      const segment = this.segment;
      if (segment) await this.detachRecorder(segment);
      if (segment?.stoppedByUser) {
        void this.finalizeSegment(segment);
        this.completeObservationStop();
        return;
      }
      this.historyLease?.(); this.historyLease = null;
      this.observationState = "paused";
      this.saveRecordingIntent("paused");
    });
    return this.snapshot();
  }

  resumeObservation(forEventSubscription = false): ComputerHistorySnapshot {
    if (this.eventCaptureActive && this.observationState === "running") {
      this.eventCaptureIntent = "running"; this.saveRecordingIntent("running"); return this.snapshot();
    }
    if (collectorGate.taskActive) throw new CollectorBusyError();
    if (this.observationState !== "paused") {
      throw new ComputerHistoryApiError(409, "Computer History is not paused");
    }
    return this.startObservation(forEventSubscription);
  }

  private completeObservationStop(): void {
    this.historyLease?.(); this.historyLease = null;
    this.browserAuthoritySuspended = true;
    this.clearBrowserAuthority();
    this.cancelRecorderReconnect();
    this.clearLiveSummaryTimer();
    this.clearRotationTimer();
    this.clearWeChatPolling();
    this.segment = null;
    this.observationStartedAt = null;
    this.observationState = "stopped";
    if (!this.shuttingDown) this.saveRecordingIntent("stopped");
  }

  async stopObservation(): Promise<ComputerHistorySnapshot> {
    if (this.eventCaptureActive && this.observationState === "running" && !this.shuttingDown) {
      this.eventCaptureIntent = "stopped"; this.saveRecordingIntent("stopped"); return this.snapshot();
    }
    this.browserAuthoritySuspended = true;
    this.clearBrowserAuthority();
    ++this.permissionStartVersion;
    this.cancelRecorderReconnect();
    // A stop also waits for an in-flight pause/rotation to release its child.
    // Concurrent stops share that work instead of clearing each other's state.
    const transitioning = this.recorderTransition !== null;
    if (transitioning && this.observationState !== "stopped") this.observationState = "stopping";
    while (this.recorderTransition) await this.recorderTransition;
    if (this.observationState === "stopped") {
      if (transitioning) return this.snapshot();
      throw new ComputerHistoryApiError(409, "Computer History is not running");
    }
    const segment = this.segment;
    this.observationState = "stopping";
    this.clearLiveSummaryTimer();
    this.clearRotationTimer();
    this.clearWeChatPolling();
    await this.trackRecorderTransition(async () => {
      if (segment) {
        await this.detachRecorder(segment);
        // Stopping should not wait on the model; the swap happens when it lands.
        void this.finalizeSegment(segment);
      }
      await Promise.all([...this.recorderChildren].map((child) => this.stopRecorderChild(child)));
      this.completeObservationStop();
    });
    return this.snapshot();
  }

  /** Called when the desktop app exits: recording does not outlive the app. */
  async shutdown(): Promise<void> {
    ++this.permissionStartVersion;
    this.shuttingDown = true;
    this.browserHistoryBridge?.close();
    this.browserHistoryBridge = null;
    this.browserAuthoritySuspended = true;
    this.clearBrowserAuthority();
    if (this.browserAuthorityTimer) clearInterval(this.browserAuthorityTimer);
    this.browserAuthorityTimer = null;
    this.weChatPreparationChild?.kill("SIGINT");
    this.cancelRecorderReconnect();
    if (this.weChatConnectionChild) this.weChatConsent.revoke();
    this.clearWeChatPolling();
    if (this.summaryRetryTimer) clearTimeout(this.summaryRetryTimer);
    this.summaryRetryTimer = null;
    try {
      if (this.recorderTransition || this.observationState !== "stopped") await this.stopObservation();
    } catch {
      // Shutdown is best effort; a failed segment must not block app exit.
    }
    await Promise.all([...this.recorderChildren].map((child) => this.stopRecorderChild(child)));
    this.historyLease?.(); this.historyLease = null;
    await this.memoryAdapter.close();
  }

  private startLiveSummaryTimer(): void {
    this.clearLiveSummaryTimer();
    this.liveSummarySignature = null;
    this.liveSummaryTimer = setInterval(() => {
      const segment = this.segment;
      if (!segment || this.observationState !== "running") return;
      this.writeLiveSummary(segment);
    }, this.liveSummaryIntervalMs);
  }

  private clearLiveSummaryTimer(): void {
    if (this.liveSummaryTimer) clearInterval(this.liveSummaryTimer);
    this.liveSummaryTimer = null;
    this.liveSummarySignature = null;
  }

  private writeLiveSummary(segment: SegmentState): void {
    if (this.summaryJobs.has(segment.historyFile)) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(segment.eventsFile);
      const raw = fs.readFileSync(segment.eventsFile, "utf8");
      if (!rawHasEvidence(raw)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.setNarrationError("Computer History could not read the active event stream");
      return;
    }
    const signature = `${stat.size}:${stat.mtimeMs}`;
    if (!stat.size) return;
    const standing = readText(segment.historyFile);
    const staging = `${segment.historyFile}.staging`;
    const destination = standing && isNarrated(standing) ? staging : segment.historyFile;
    const prepared = readText(destination);
    // A completed account remains readable while its fuller replacement is
    // prepared beside it. Unchanged input needs no second model request.
    if (standing && isNarrated(standing) && !prepared
      && Number(readFrontmatterValue(standing, "summary_input_bytes")) === stat.size) return;
    if (signature !== this.liveSummarySignature || !prepared) {
      this.invalidateSummary(segment.historyFile);
      const error = this.writeSegmentSummary(segment, destination);
      if (error) { this.setNarrationError(error); return; }
      this.liveSummarySignature = signature;
    }

    // Narrate an open segment once it has enough to say. Waiting for the
    // segment to close left the entry reading mechanically for the whole ten
    // minutes someone is most likely to look at it.
    if (stat.size >= LIVE_NARRATION_MIN_BYTES && !this.narratedOpenSegments.has(segment.id)) {
      this.narratedOpenSegments.add(segment.id);
      void this.writeSummaryWith(destination, "10min", segment.eventsFile).catch((error) => {
        this.setNarrationError(error instanceof Error ? error.message : String(error));
      }).finally(() => {
        // A failed live request can try again on the next tick, even if the
        // user has not generated another event in the meantime.
        this.narratedOpenSegments.delete(segment.id);
      });
    }
  }

  /** Prepare abandoned raw segments before retries or retention can lose them. */
  private recoverInterruptedSegments(): void {
    if (!fs.existsSync(this.segmentsDirectory)) return;
    for (const entry of fs.readdirSync(this.segmentsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/u.test(entry.name)) continue;
      if (entry.name === this.segment?.id) continue;
      const directory = path.join(this.segmentsDirectory, entry.name);
      const eventsFile = path.join(directory, "events.jsonl");
      const historyFile = path.join(this.historyDirectory, `${entry.name}-10min-summary.md`);
      const staging = `${historyFile}.staging`;
      try {
        const stat = fs.statSync(eventsFile);
        const checkpoint = this.readRetentionCheckpoint(`${entry.name}-10min-summary`);
        const standing = readText(historyFile);
        const prepared = readText(staging) ?? standing;
        if (prepared && readFrontmatterValue(prepared, "capture_complete") === "true"
          && Number(readFrontmatterValue(prepared, "summary_input_bytes")) === stat.size
          && checkpoint?.rawBytes === stat.size && checkpoint.rawMtimeMs === stat.mtimeMs
          && readFrontmatterValue(prepared, "summary_input_sha256") === checkpoint.rawSha256) continue;
        let metadata: Record<string, unknown> = {};
        try { metadata = JSON.parse(readText(path.join(directory, "metadata.json")) ?? "{}") ?? {}; } catch { /* Legacy segment. */ }
        // Legacy metadata has no open/closed state or byte marker. A completed
        // summary is safe to retain only if the stream ended before it was
        // written, rather than reopening after an earlier recording_stopped.
        if (checkpoint && prepared && !readFrontmatterValue(prepared, "summary_input_bytes")
          && readFrontmatterValue(prepared, "status") === "completed"
          && metadata.state !== "open"
          && recordingEnded(fs.readFileSync(eventsFile, "utf8"))
          && fs.statSync(eventsFile).mtimeMs <= fs.statSync(fs.existsSync(staging) ? staging : historyFile).mtimeMs) continue;
        if (!segmentHasActivity(eventsFile)) continue;
        fs.mkdirSync(this.historyDirectory, { recursive: true });
        const segment: SegmentState = {
          id: entry.name, directory, eventsFile, historyFile,
          metadataFile: path.join(directory, "metadata.json"),
          startedAt: new Date(segmentAgeMs(directory)).toISOString(),
          child: null, output: "", stoppedByUser: false,
        };
        this.invalidateSummary(historyFile);
        const error = this.writeSegmentSummary(segment, standing && isNarrated(standing) ? staging : historyFile, true);
        if (error) this.setNarrationError(error);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.setNarrationError(error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  private writeSegmentSummary(segment: SegmentState, destination = segment.historyFile, closed = false): string | null {
    try {
      const sourceStat = fs.statSync(segment.eventsFile);
      const source = fs.readFileSync(segment.eventsFile);
      const raw = source.toString("utf8");
      const retained = closed ? completeRawEvidence(source) : null;
      const interrupted = closed && !recordingEnded(raw);
      const markdown = renderSummary({ file: segment.eventsFile, ...parsedRawRecords(raw), title: `Computer History ${segment.id}` })
        .replace(/^source_type:\s*human_computer_history\s*$/m, "source_type: captured")
        .replace(/^status:.*$/m, `status: ${closed ? "completed" : "incomplete"}`)
        .replace(/^---\n/, "---\n"
          + `capture_complete: ${closed}\nsummary_input_bytes: ${source.length}\nsummary_input_sha256: ${hashBytes(source)}\n`
          + (interrupted ? "capture_end_reason: interrupted\n" : ""));
      // Retention can remove raw files while the model is offline. Keep the
      // bounded, distilled input with the pending summary so a later retry
      // still has evidence. applyNarrative replaces it on success.
      const evidence = compactEventEvidence(raw.split("\n"), { weChatNames: this.weChatNameMap() });
      const pending = evidence ? markdown.replace("（尚未生成）", evidence) : markdown;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      atomicWriteText(destination, pending);
      if (closed) {
        const currentStat = fs.statSync(segment.eventsFile);
        if (currentStat.size !== source.length || currentStat.mtimeMs !== sourceStat.mtimeMs) {
          throw new Error("Computer History raw evidence changed while finalizing; retaining the event stream");
        }
        const checkpointFile = this.retentionCheckpointPath(`${segment.id}-10min-summary`);
        if (!checkpointFile) throw new Error("Computer History retention source has an invalid segment identifier");
        const checkpoint: RetainedSegmentEvidence = { version: 1, segmentId: segment.id,
          rawBytes: source.length, rawMtimeMs: sourceStat.mtimeMs, rawSha256: hashBytes(source),
          evidenceSha256: hashText(retained!), evidence: retained! };
        atomicWriteText(checkpointFile, `${JSON.stringify(checkpoint)}\n`);
        this.retentionCache.delete(checkpointFile);
        let metadata = {};
        try { metadata = JSON.parse(readText(segment.metadataFile) ?? "{}"); } catch { /* Legacy segment. */ }
        atomicWriteText(segment.metadataFile, `${JSON.stringify({ ...metadata, startedAt: segment.startedAt, state: "closed" }, null, 2)}\n`);
      }
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private retentionCheckpointPath(historyId: string): string | null {
    const id = canonicalSegmentId(historyId);
    return id ? path.join(this.historyDirectory, `${id}-10min-summary.md.evidence.json`) : null;
  }

  private readRetentionCheckpoint(historyId: string, verifyPersisted = false): RetainedSegmentEvidence | null {
    const file = this.retentionCheckpointPath(historyId);
    if (!file) return null;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) return null;
      const signature = `${stat.size}:${stat.mtimeMs}`;
      const cached = this.retentionCache.get(file);
      if (!verifyPersisted && cached?.signature === signature) return cached.checkpoint;
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<RetainedSegmentEvidence> | null;
      if (!value || value.version !== 1 || value.segmentId !== canonicalSegmentId(historyId)
        || !Number.isSafeInteger(value.rawBytes) || value.rawBytes! < 0 || !Number.isFinite(value.rawMtimeMs)
        || typeof value.rawSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.rawSha256)
        || typeof value.evidence !== "string" || typeof value.evidenceSha256 !== "string"
        || hashText(value.evidence) !== value.evidenceSha256) return null;
      const checkpoint = value as RetainedSegmentEvidence;
      this.retentionCache.set(file, { signature, checkpoint });
      return checkpoint;
    } catch { return null; }
  }

  private canExpireRaw(directory: string): boolean {
    const eventsFile = path.join(directory, "events.jsonl");
    if (!fs.existsSync(eventsFile)) return true;
    try {
      const raw = fs.readFileSync(eventsFile);
      const evidence = completeRawEvidence(raw);
      if (!segmentHasActivity(eventsFile)) return true;
      const checkpoint = this.readRetentionCheckpoint(`${path.basename(directory)}-10min-summary`, true);
      if (checkpoint && checkpoint.rawBytes === raw.length && checkpoint.rawSha256 === hashBytes(raw)
        && checkpoint.evidence === evidence) return true;
    } catch { /* Keep incomplete or unreadable evidence. Never expose its contents. */ }
    this.setNarrationError("Computer History raw retention is deferred until complete evidence is safely persisted");
    return false;
  }

  private activeSummaryIsPending(markdown: string): boolean {
    if (!this.segment || !isNarrated(markdown)) return true;
    try {
      return Number(readFrontmatterValue(markdown, "summary_input_bytes")) !== fs.statSync(this.segment.eventsFile).size
        || fs.existsSync(`${this.segment.historyFile}.staging`);
    } catch { return true; }
  }

  private storedSummaryIsPending(entry: MarkdownEntry): boolean {
    if (!isNarrated(entry.markdown) || fs.existsSync(`${entry.filePath}.staging`)) return true;
    if (readSourceType(entry.markdown) !== "captured") return false;
    const raw = this.eventStreamPathFor(entry.id);
    if (!raw) return false;
    const bytes = readFrontmatterValue(entry.markdown, "summary_input_bytes");
    return bytes !== null && Number(bytes) !== fs.statSync(raw).size;
  }

  private hasStoredRawActivity(historyId: string): boolean {
    const checkpoint = this.readRetentionCheckpoint(historyId);
    if (checkpoint?.evidence) return true;
    const raw = this.eventStreamPathFor(historyId);
    return raw !== null && segmentHasActivity(raw);
  }

  /** A raw-backed retrieval candidate remains available before model narration. */
  private currentRawHistory(segment = this.segment): { history: ComputerHistoryEntry; raw: string } | null {
    if (!segment) return null;
    try {
      const stat = fs.statSync(segment.eventsFile);
      const signature = `${segment.eventsFile}:${stat.size}:${stat.mtimeMs}`;
      const stage = `${segment.historyFile}.staging`;
      const filePath = fs.existsSync(stage) ? stage : fs.existsSync(segment.historyFile) ? segment.historyFile : segment.eventsFile;
      if (this.currentRawCache?.signature === signature) {
        return { history: { ...this.currentRawCache.history, filePath }, raw: this.currentRawCache.raw };
      }
      const raw = fs.readFileSync(segment.eventsFile, "utf8");
      if (!rawHasEvidence(raw)) return null;
      const pending = renderSummary({ file: segment.eventsFile, ...parsedRawRecords(raw), title: `Computer History ${segment.id}` })
        .replace(/^source_type:\s*human_computer_history\s*$/mu, "source_type: captured")
        .replace(/^status:.*$/mu, "status: incomplete")
        .replace(/^---\n/u, `---\ncapture_complete: false\nsummary_input_bytes: ${Buffer.byteLength(raw, "utf8")}\n`);
      const evidence = compactEventEvidence(raw.split("\n"));
      const markdown = evidence ? pending.replace("（尚未生成）", evidence) : pending;
      // A candidate can be constructed before its first timer tick. In that
      // case the existing source file is raw, and the body explicitly stays pending.
      const history: ComputerHistoryEntry = { id: `${segment.id}-10min-summary`,
        title: readFrontmatterValue(markdown, "title") || `Computer History ${segment.id}`,
        description: null, applications: applicationsFromMarkdown(markdown), summaryWindow: "10min", coveredHistoryIds: [],
        pinned: this.isPinned(`${segment.id}-10min-summary`), eventStreamPath: segment.eventsFile,
        sourceType: "captured", createdAt: instantFromId(segment.id)!.toISOString(), markdown, filePath, summaryStatus: "pending" };
      this.currentRawCache = { signature, history, raw };
      return this.currentRawCache;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.setNarrationError("Computer History could not prepare raw evidence for retrieval");
      return null;
    }
  }

  private pendingHistoryForSearch(history: ComputerHistoryEntry): { history: ComputerHistoryEntry; raw: string } | null {
    const id = canonicalSegmentId(history.id);
    if (!id || history.sourceType !== "captured") return null;
    const directory = this.segmentDirectoryFor(history.id);
    if (directory && history.eventStreamPath) {
      return this.currentRawHistory({ id, directory, eventsFile: history.eventStreamPath,
        historyFile: path.join(this.historyDirectory, `${history.id}.md`), metadataFile: path.join(directory, "metadata.json"),
        startedAt: history.createdAt, child: null, output: "", stoppedByUser: false });
    }
    const checkpoint = this.readRetentionCheckpoint(history.id);
    if (!checkpoint) return null;
    const stage = `${path.join(this.historyDirectory, `${history.id}.md`)}.staging`;
    const markdown = readText(stage) ?? history.markdown;
    return { history: { ...history, markdown, filePath: fs.existsSync(stage) ? stage : history.filePath,
      summaryStatus: "pending" }, raw: checkpoint.evidence };
  }



  /** Resolves the segment directory a summary came from, if it still exists. */
  private segmentDirectoryFor(historyId: string): string | null {
    // Only a ten-minute summary has a segment of its own. A six-hour summary is
    // named for its window start, which is also the id of the first segment in
    // that window — mapping it the same way deleted and pinned that segment's
    // raw events whenever the rollup was deleted or pinned.
    const segmentId = canonicalSegmentId(historyId);
    if (!segmentId) return null;
    const directory = path.join(this.segmentsDirectory, segmentId);
    try {
      // A canonical name alone does not make a symlink belong to this store.
      if (!fs.lstatSync(directory).isDirectory()) return null;
      const root = fs.realpathSync(this.segmentsDirectory);
      return fs.realpathSync(directory) === path.join(root, segmentId) ? directory : null;
    } catch { return null; }
  }

  /** The segment's event stream, or null once it has passed retention. */
  private eventStreamPathFor(historyId: string): string | null {
    const directory = this.segmentDirectoryFor(historyId);
    if (!directory) return null;
    const file = path.join(directory, "events.jsonl");
    return fs.existsSync(file) ? file : null;
  }

  private isPinned(historyId: string): boolean {
    const directory = this.segmentDirectoryFor(historyId);
    return directory !== null && fs.existsSync(path.join(directory, PIN_MARKER));
  }

  /**
   * Keeps a segment's raw events past the retention window.
   *
   * Retention exists so a recording of an ordinary afternoon does not live
   * forever, but occasionally a window is worth keeping as the source for a
   * workflow. Pinning is that exception, and it is deliberately explicit.
   */
  pinSegment(historyId: string, pinned: boolean): ComputerHistorySnapshot {
    const id = historyId.trim();
    if (!canonicalSegmentId(id)) {
      throw new ComputerHistoryApiError(422, "only a ten-minute entry with a canonical ID has raw events of its own to pin");
    }
    const directory = this.segmentDirectoryFor(id);
    if (!directory) {
      throw new ComputerHistoryApiError(
        404,
        "the raw events for this entry are no longer on disk, so there is nothing to pin",
      );
    }
    const historyFile = path.join(this.historyDirectory, `${id}.md`);
    if (this.segment?.historyFile === historyFile && !fs.existsSync(historyFile)) {
      const error = this.writeSegmentSummary(this.segment);
      if (error) {
        this.setNarrationError(error);
        throw new ComputerHistoryApiError(503, "Computer History could not prepare the active captured entry");
      }
    }
    try {
      if (!fs.lstatSync(historyFile).isFile() || readSourceType(readText(historyFile) ?? "") !== "captured"
        || !fs.lstatSync(path.join(directory, "events.jsonl")).isFile()) {
        throw new Error("not a captured entry");
      }
    } catch {
      throw new ComputerHistoryApiError(404, "captured history and its raw events were not found");
    }
    const marker = path.join(directory, PIN_MARKER);
    if (pinned) {
      try {
        // Never truncate or follow an existing marker, even if someone has
        // replaced it with a link to another file.
        const fd = fs.openSync(marker, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.closeSync(fd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!fs.lstatSync(marker).isFile()) throw new ComputerHistoryApiError(422, "pin marker must be a regular file");
      }
    } else {
      fs.rmSync(marker, { force: true });
    }
    return this.snapshot();
  }

  /**
   * Derives replayable steps from a segment's own event stream, on demand.
   *
   * This used to run for every segment at capture time, which produced a
   * candidate for every ten-minute slice of the day. A window boundary has
   * nothing to do with a task boundary, so almost all of them were noise.
   * Deriving on request means it happens when someone actually wants to repeat
   * something.
   */
  private deriveSteps(historyId: string): string[] {
    const directory = this.segmentDirectoryFor(historyId);
    if (!directory) return [];
    const eventsFile = path.join(directory, "events.jsonl");
    if (!fs.existsSync(eventsFile)) return [];
    const target = path.join(directory, "candidate.md");
    try {
      const written = writeWorkflowCandidate({
        file: eventsFile,
        out: target,
        title: historyId,
        sourceHistoryId: historyId,
      });
      if (!written) return [];
    } catch {
      return [];
    }
    return extractCandidateSteps(fs.readFileSync(target, "utf8"));
  }

  deleteHistory(historyId: string): ComputerHistorySnapshot {
    if (this.segment && historyId.trim() === `${this.segment.id}-10min-summary`) {
      throw new ComputerHistoryApiError(409, "stop recording before deleting the window being recorded");
    }
    // Pending entries are still stored history and must be deletable too.
    const history = this.readMarkdownDirectory(this.historyDirectory)
      .find((entry) => entry.id === historyId.trim());
    if (!history) throw new ComputerHistoryApiError(404, "history not found");
    // The recorder is still writing into this window's directory, paused or
    // not; deleting it out from under the recorder loses everything after.
    if (this.segment && history.filePath === this.segment.historyFile) {
      throw new ComputerHistoryApiError(409, "stop recording before deleting the window being recorded");
    }
    if (history.summaryWindow === "6h") {
      atomicWriteText(`${history.filePath}.deleted`, `${new Date().toISOString()}\n`);
    }
    this.removeStoredHistory(history.id);
    this.removeRollupsContaining(history.id);
    return this.snapshot();
  }

  /** Invalidate first: a model response may already be waiting to commit. */
  private removeStoredHistory(id: string): void {
    this.memoryAdapter.remove(id);
    const file = path.join(this.historyDirectory, `${id}.md`);
    this.invalidateSummary(file);
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.staging`, { force: true });
    const checkpoint = this.retentionCheckpointPath(id);
    if (checkpoint) {
      fs.rmSync(checkpoint, { force: true });
      this.retentionCache.delete(checkpoint);
    }
    this.currentRawCache = null;
    const links = this.readSkillLinks();
    if (Object.hasOwn(links, id)) {
      delete links[id];
      atomicWriteText(this.skillLinksFile, JSON.stringify(links));
    }
    for (const workflow of this.readMarkdownDirectory(this.workflowDirectory)) {
      if (nullableFrontmatterValue(workflow.markdown, "source_history_id") === id) {
        fs.rmSync(workflow.filePath, { force: true });
      }
    }
    const segment = this.segmentDirectoryFor(id);
    if (segment) {
      fs.rmSync(segment, { recursive: true, force: true });
    } else if (!id.endsWith("-6h-summary") && !id.endsWith("-10min-summary") && id !== SEGMENTS_DIRECTORY_NAME) {
      // A recording from before segments kept its events at `recordings/<id>`.
      // Never for a summary, whose id names a segment it does not own, and
      // never the directory that holds every segment.
      fs.rmSync(path.join(this.recordingDirectory, id), { recursive: true, force: true });
    }
  }

  private removeRollupsContaining(historyId: string): void {
    if (!historyId.endsWith("-10min-summary")) return;
    const at = instantFromId(historyId);
    for (const entry of this.readMarkdownDirectory(this.historyDirectory)) {
      if (entry.summaryWindow !== "6h") continue;
      const start = instantFromId(entry.id);
      // Older rollups did not declare membership. Their time window is the
      // conservative boundary for removing derived copies of deleted text.
      if (entry.coveredHistoryIds.includes(historyId)
        || (at && start && at >= start && at.getTime() < start.getTime() + 6 * 60 * 60_000)) {
        this.removeStoredHistory(entry.id);
      }
    }
  }

  /** Clear stored history, cutting the active stream at the deletion boundary. */
  async clearHistories(scope: "today" | "all"): Promise<ComputerHistorySnapshot> {
    if (scope !== "today" && scope !== "all") throw new ComputerHistoryApiError(400, "scope must be today or all");
    // A rotation or another clear must finish before selecting the active stream.
    while (this.recorderTransition) await this.recorderTransition;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    const includes = (id: string, modifiedAt: number) => {
      if (scope === "all") return true;
      const at = instantFromId(id)?.getTime() ?? modifiedAt;
      return at >= today && at < tomorrow;
    };
    const previous = this.segment && includes(`${this.segment.id}-10min-summary`, Date.parse(this.segment.startedAt))
      ? this.segment : null;
    await this.trackRecorderTransition(async () => {
      try {
        if (previous) {
          this.cancelRecorderReconnect();
          this.recorderReconnectAttempts = 0;
          this.clearLiveSummaryTimer();
          this.clearRotationTimer();
          this.invalidateSummary(previous.historyFile);
          // Wait for the native writer to exit before deleting its files. Do not
          // finalize this segment: the user has asked to discard its evidence.
          await this.detachRecorder(previous);
        }
        const ids = new Set<string>();
        if (fs.existsSync(this.historyDirectory)) {
          for (const entry of fs.readdirSync(this.historyDirectory, { withFileTypes: true })) {
            if (!entry.isFile() || !/\.md(?:\.staging|\.evidence\.json)?$/u.test(entry.name)) continue;
            const id = entry.name.replace(/\.md(?:\.staging|\.evidence\.json)?$/u, "");
            if (includes(id, fs.statSync(path.join(this.historyDirectory, entry.name)).mtimeMs)) ids.add(id);
          }
        }
        // A crash can leave raw events before any summary exists.
        if (fs.existsSync(this.segmentsDirectory)) {
          for (const entry of fs.readdirSync(this.segmentsDirectory, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const id = `${entry.name}-10min-summary`;
            if (includes(id, segmentAgeMs(path.join(this.segmentsDirectory, entry.name)))) ids.add(id);
          }
        }
        if (fs.existsSync(this.recordingDirectory)) {
          for (const entry of fs.readdirSync(this.recordingDirectory, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name === SEGMENTS_DIRECTORY_NAME) continue;
            if (includes(entry.name, segmentAgeMs(path.join(this.recordingDirectory, entry.name)))) ids.add(entry.name);
          }
        }
        for (const id of ids) this.removeStoredHistory(id);
        for (const id of ids) this.removeRollupsContaining(id);
        if (previous) {
          this.segment = null;
          this.resetCaptureHealth();
          this.narratedOpenSegments.delete(previous.id);
          // Invalidated model responses cannot commit, and must not block the
          // first summary of fresh activity in the same ten-minute bucket.
          this.summaryJobs.delete(previous.historyFile);
          if (previous.stoppedByUser || this.shuttingDown || this.observationState === "stopping") {
            this.completeObservationStop();
          } else if (this.observationState === "running" || this.observationState === "paused") {
            this.segment = this.openSegment();
            if (this.observationState === "running") {
              this.spawnRecorder(this.segment);
              this.startLiveSummaryTimer();
              this.startRotationTimer();
              this.startWeChatPolling();
            }
          }
        }
      } catch (error) {
        if (previous) this.failObservation(error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
    return this.snapshot();
  }

  createWorkflow(historyId: string, userRequest = ""): ComputerHistorySnapshot {
    const history = this.findHistory(historyId);
    const request = cleanUserRequest(userRequest || "按记录中的步骤复现这段操作，完成后停止。");
    if (history.sourceType === "captured") {
      if (history.sourceType === "captured" && readFrontmatterValue(history.markdown, "status") !== "completed") {
        throw new ComputerHistoryApiError(422, "the selected operation-experience recording is incomplete");
      }
      if (history.sourceType === "captured" && readFrontmatterValue(history.markdown, "experience_version") !== "1") {
        throw new ComputerHistoryApiError(422, "the selected recording does not contain reusable semantic operation experience");
      }
      const steps = normalizeRecordedExperienceSteps(this.deriveSteps(history.id));
      if (!steps.length) {
        // Distinguish "nothing repeatable happened" from "the evidence is gone",
        // because only the second one is the user's to prevent next time.
        throw new ComputerHistoryApiError(
          422,
          this.segmentDirectoryFor(history.id)
            ? "the selected recording contains no reusable semantic action"
            : "the raw events for this entry passed the retention window; pin a segment to keep its events for later",
        );
      }
      const id = `${timestampForPath()}-recorded-operation-experience-computer-use`;
      const markdown = buildRecordedExperienceWorkflow({ history, request, steps });
      fs.mkdirSync(this.workflowDirectory, { recursive: true });
      fs.writeFileSync(path.join(this.workflowDirectory, `${id}.md`), markdown, { encoding: "utf8", flag: "wx" });
      return this.snapshot();
    }
    throw new ComputerHistoryApiError(422, "select a completed operation-experience recording");
  }

  searchHistories(query: string, limit = 5, options: { historyId?: string | null } = {}): ComputerHistoryMatch[] {
    const terms = queryTerms(query);
    const segment = this.segment;
    if (segment && (!options.historyId || options.historyId === `${segment.id}-10min-summary`)) this.writeLiveSummary(segment);
    const snapshot = this.snapshot();
    const current = this.currentRawHistory();
    const byId = new Map(snapshot.histories.map((history) => [history.id, history]));
    const rawById = new Map<string, string>();
    for (const history of snapshot.histories) {
      if (history.summaryStatus !== "pending" || history.id === current?.history.id
        || (options.historyId && history.id !== options.historyId)) continue;
      const pending = this.pendingHistoryForSearch(history);
      if (pending) { byId.set(history.id, pending.history); rawById.set(history.id, pending.raw); }
    }
    if (current && this.activeSummaryIsPending(byId.get(current.history.id)?.markdown ?? "")) byId.set(current.history.id, current.history);
    if (current) rawById.set(current.history.id, current.raw);
    // Searching is evidence retrieval, not replay selection. Filtering by
    // replayability meant an entry vanished from search the moment its raw
    // events expired — exactly when the written summary is all that is left and
    // the only thing that can still answer "what was I doing".
    return [...byId.values()]
      // An entry asked for by id is the answer whatever the query ranks it; it
      // used to be filtered only after the top few were kept, so an entry
      // outside them came back as nothing.
      .filter((history) => !options.historyId || history.id === options.historyId)
      .map((history) => {
        const title = searchableText(history.title);
        const markdown = searchableText(history.markdown + (rawById.has(history.id) ? `\n${rawById.get(history.id)}` : ""));
        const matchedTerms = terms.filter((term) => title.includes(term) || markdown.includes(term));
        const score = matchedTerms.reduce((total, term) => (
          total + (title.includes(term) ? 8 : 0) + (markdown.includes(term) ? 2 : 0)
        ), history.sourceType === "captured" ? 2 : 1);
        return { history, score, matchedTerms };
      })
      .sort((left, right) => right.score - left.score || right.history.createdAt.localeCompare(left.history.createdAt))
      .slice(0, Math.max(1, Math.min(20, limit)));
  }

  private findHistory(id: string): ComputerHistoryEntry {
    const entry = this.snapshot().histories.find((candidate) => candidate.id === id);
    if (!entry) throw new ComputerHistoryApiError(404, "history not found");
    return entry;
  }

  /**
   * Reads every summary in a directory, reusing the parse of any file that has
   * not changed.
   *
   * The timeline polls the snapshot every 1.5 seconds while recording, and a
   * summary is never deleted, so re-reading and re-parsing every file on every
   * poll grew without bound — on the gateway's own event loop.
   */
  private readMarkdownDirectory(directory: string): MarkdownEntry[] {
    if (!fs.existsSync(directory)) return [];
    const cache = this.markdownCache.get(directory) ?? new Map<string, CachedEntry>();
    this.markdownCache.set(directory, cache);
    const present = new Set<string>();
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => {
        const filePath = path.join(directory, entry.name);
        present.add(filePath);
        const stat = fs.statSync(filePath);
        const cached = cache.get(filePath);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.entry;
        const markdown = fs.readFileSync(filePath, "utf8");
        const id = entry.name.slice(0, -3);
        const parsed: MarkdownEntry = {
          id,
          title: readFrontmatterValue(markdown, "title") || id,
          description: nullableFrontmatterValue(markdown, "description"),
          applications: applicationsFromMarkdown(markdown),
          coveredHistoryIds: rollupCoveredHistoryIds(markdown, id),
          pinned: false,
          summaryWindow: id.endsWith("-10min-summary")
            ? ("10min" as const)
            : id.endsWith("-6h-summary")
              ? ("6h" as const)
              : null,
          // When the window happened, not when its file was last touched.
          // A summary is rewritten every time it is regenerated and narrated,
          // so mtime walks forward as the model catches up — which made an
          // entry appear to vanish and a new one take its place, and sorted
          // rollups into the middle of the segments they cover.
          createdAt: entryInstant(id, markdown, stat.mtime),
          markdown,
          filePath,
        };
        cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, entry: parsed });
        return parsed;
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    for (const filePath of cache.keys()) if (!present.has(filePath)) cache.delete(filePath);
    return entries;
  }

  /**
   * Drops raw event streams past the retention window.
   *
   * Segments live one level down, under `segments/`, so the container itself is
   * never a candidate: judging it by its own mtime meant it stayed fresh as
   * long as recording continued and nothing inside was ever cleaned, then
   * expired as a whole once recording stopped for long enough. Each segment is
   * judged on its own age instead, and the open one is left alone because it is
   * still being written to.
   */
  private cleanupExpiredRecordings(): void {
    if (this.eventCaptureActive) return;
    if (!fs.existsSync(this.recordingDirectory)) return;
    this.recoverInterruptedSegments();
    const cutoff = Date.now() - RAW_RETENTION_MS;
    const openSegmentId = this.segment?.id ?? null;

    const expire = (directory: string, isOpen: (name: string) => boolean): void => {
      if (!fs.existsSync(directory)) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || isOpen(entry.name)) continue;
        const target = path.join(directory, entry.name);
        if (fs.existsSync(path.join(target, PIN_MARKER))) continue;
        try {
          if (segmentAgeMs(target) < cutoff && this.canExpireRaw(target)) fs.rmSync(target, { recursive: true, force: true });
        } catch {
          // A segment removed by another pass is already in the desired state.
        }
      }
    };

    expire(this.segmentsDirectory, (name) => name === openSegmentId);
    // Recordings captured before segments existed still sit at the top level.
    expire(this.recordingDirectory, (name) => name === SEGMENTS_DIRECTORY_NAME);
  }
}


function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function canonicalSegmentId(historyId: string): string | null {
  const match = historyId.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)-10min-summary$/u);
  if (!match) return null;
  const at = instantFromId(match[1]);
  return at && alignedId(at, SEGMENT_DURATION_MS) === match[1] ? match[1] : null;
}

function atomicWriteText(file: string, text: string): void {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashBytes(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}


/**
 * Reports whether an entry can still be turned into a workflow.
 *
 * Steps are derived from the raw event stream on demand, so what decides this
 * is whether that stream is still on disk, not whether the summary happens to
 * contain a section listing actions.
 */
function replayPlanFor(
  entry: MarkdownEntry,
  sourceType: ComputerHistorySourceType,
  hasRawEvents: boolean,
): ComputerHistoryReplayPlan | null {
  if (sourceType !== "captured") return null;
  const steps: string[] = [];
  return {
    sourcePath: entry.filePath,
    sourceHash: hashText(entry.markdown),
    status: hasRawEvents ? "ready" : "not_replayable",
    steps,
    variables: [...entry.markdown.matchAll(/\{\{\s*([^}]+?)\s*\}\}/gu)].map((match) => match[1].trim()),
  };
}

function normalizeRecordedExperienceSteps(steps: string[]): string[] {
  const firstObservedPageIndex = steps.findIndex((step) => (
    /^Confirm the front browser page\b/u.test(step) && /https?:\/\//u.test(step)
  ));
  let normalized = steps;
  if (firstObservedPageIndex >= 0) {
    const prefix = steps.slice(0, firstObservedPageIndex);
    if (prefix.some((step) => /intentionally redacted/u.test(step))) {
      const observedUrl = steps[firstObservedPageIndex].match(/https?:\/\/[^\s（(]+/u)?.[0];
      if (observedUrl) {
        normalized = [
          `Activate Google Chrome (\`com.google.Chrome\`), open ${observedUrl} in the current tab, and verify the page is visible before continuing.`,
          ...steps.slice(firstObservedPageIndex + 1),
        ];
      }
    }
  }
  return normalized.filter((step) => !isRecordedScrollNavigationStep(step));
}

function isRecordedScrollNavigationStep(step: string): boolean {
  return /\b(?:move|scroll)\b.*\b(?:reveal|viewport|page)\b/iu.test(step)
    && /\b(?:up|down|left|right|within|far enough|at most)\b/iu.test(step);
}


function extractCandidateSteps(markdown: string): string[] {
  const heading = markdown.match(/^## Semantic steps\s*$/mu);
  if (!heading || heading.index === undefined) return [];
  const remainder = markdown.slice(heading.index + heading[0].length);
  const nextHeading = remainder.search(/^##\s/mu);
  const section = nextHeading >= 0 ? remainder.slice(0, nextHeading) : remainder;
  return section
    .split("\n")
    .map((line) => line.match(/^\s*\d+\.\s+(.+?)\s*$/u)?.[1] ?? "")
    .filter(Boolean)
    .slice(0, 80);
}


const QUERY_STOP_TERMS = new Set([
  "帮我", "一下", "复现", "重放", "继续", "接着", "刚才", "之前", "那个", "这个", "行为", "操作", "流程",
  "please", "replay", "repeat", "resume", "continue", "previous", "operation", "workflow",
]);

function searchableText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function queryTerms(value: string): string[] {
  const normalized = searchableText(value);
  const terms = new Set<string>();
  for (const token of normalized.match(/[a-z0-9][a-z0-9._+-]{1,}|[\p{Script=Han}]{2,}/gu) ?? []) {
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      if (token.length <= 6 && !QUERY_STOP_TERMS.has(token)) terms.add(token);
      for (let index = 0; index < token.length - 1; index += 1) {
        const pair = token.slice(index, index + 2);
        if (!QUERY_STOP_TERMS.has(pair)) terms.add(pair);
      }
    } else if (!QUERY_STOP_TERMS.has(token)) {
      terms.add(token);
    }
  }
  return [...terms].slice(0, 32);
}

export function buildRecordedExperienceWorkflow(input: {
  history: ComputerHistoryEntry;
  request: string;
  steps: string[];
}): string {
  const isBrowserStep = (step: string) => /^Recorded browser operation \(/u.test(step);
  const browserSteps = input.steps.filter(isBrowserStep).length;
  const gateSections = input.steps.map((step, index) => [
    `### Gate ${index + 1} of ${input.steps.length}`,
    "",
    `Recorded semantic action: ${step}`,
    "",
    isBrowserStep(step) ? "- Execution surface: browser. Resolve the intended Chrome/Edge tab with browser_list_tabs, then read browser_snapshot immediately before acting."
      : "- Execution surface: desktop. Read the target application's current window state immediately before acting.",
    isBrowserStep(step) ? "- Locate the current page control using its role/name and current state; use browser actions and verify the returned or refreshed browser state. Never replay a recorded reference or coordinate."
      : "- Locate the target from current Accessibility text, role, value, or visible UI; never use a recorded coordinate.",
    "- Perform this gate at most once, then read state again and record concrete evidence that its intended effect occurred.",
    `- Gate ${index + 2} is locked until this evidence exists. If the target or evidence is unavailable, stop and report this gate as blocked.`,
  ].join("\n")).join("\n\n");
  return [
    "---",
    `title: ${JSON.stringify(`从录制经验生成：${input.history.title}`)}`,
    "kind: computer_use_workflow",
    `source_history_id: ${input.history.id}`,
    `source_history_path: ${JSON.stringify(input.history.filePath)}`,
    `user_request: ${JSON.stringify(input.request)}`,
    "generated_from: recorded_operation_experience",
    "experience_version: 1",
    "status: ready",
    "---",
    "",
    `# Workflow：复用“${input.history.title}”操作经验`,
    "",
    "## Current request",
    "",
    `> ${input.request}`,
    "",
    browserSteps ? "This Workflow was distilled from observed operation evidence. Browser steps preserve their human/unknown actor attribution; an unknown actor is not a confirmed human demonstration. Follow semantic targets and state transitions rather than recorded coordinates."
      : "This Workflow was distilled from an explicit human demonstration. It is a semantic state machine, not a macro: raw coordinates and exact scroll distances are deliberately excluded.",
    "",
    "## Execution contract",
    "",
    "1. Start by stating the current request, the source History title, and the safety boundary inferred from the request.",
    browserSteps ? "2. Browser gates use Memmy browser tools: browser_list_tabs, browser_snapshot, browser_click, browser_type, browser_select_option, browser_press_key, and browser_wait_for. Preserve the selected tab and verify every state transition."
      + (browserSteps < input.steps.length ? " Desktop gates use only Memmy Computer Use MCP list_apps/get_app_state/click/type_text/press_key/scroll. Choose the executor from each gate's surface." : "")
      + " If a required tool or target is unavailable, stop at that gate and report it as blocked."
      : "2. Use only the Memmy Computer Use MCP tools `mcp_memmy_computer_use_list_apps`, `mcp_memmy_computer_use_get_app_state`, `mcp_memmy_computer_use_click`, `mcp_memmy_computer_use_type_text`, `mcp_memmy_computer_use_press_key`, and `mcp_memmy_computer_use_scroll`. If these tools are unavailable, stop and report the workflow as blocked; never substitute another desktop executor.",
    "3. Execute the gates below strictly in order. Maintain a visible checklist such as `G1 verified / G2 pending`; never search for a later action while an earlier gate is unresolved.",
    browserSteps ? "4. For browser gates, begin with browser_list_tabs/browser_snapshot and verify the actual state after each action. For desktop gates, use list_apps/get_app_state and the refreshed state returned by the action."
      : "4. Start with `list_apps` and `get_app_state`. Memmy Computer Use action tools return refreshed post-action state; use that result as verification evidence instead of immediately calling `get_app_state` again. Read state again only after an out-of-band UI change or when the action result lacks the evidence needed for the next gate.",
    browserSteps ? "5. Browser element references and desktop element indexes belong to the current observation. Re-observe after navigation, modal changes or stale targets, and locate each gate from live semantics."
      : "5. Element indexes are state-scoped. Use only an `element_index` from the latest returned state, and never reuse an index after a click, key action, scroll, navigation, modal change, or page reload.",
    "6. Recorded scrolls are navigation hints, not workflow gates. If a target is absent, scroll at most one viewport and inspect the state returned by that scroll; stop as soon as the target or its section anchor appears.",
    "7. If the live UI differs from the demonstration, adapt semantic localization but preserve the demonstrated intent and order. Do not guess missing values or choose approximate alternatives.",
    "",
    "## Ordered state gates",
    "",
    gateSections,
    "",
    "## Consequential-action guard",
    "",
    "- Before activating anything equivalent to Add to Bag, Save, Send, Submit, Delete, Checkout, or Pay, verify every earlier selection/input gate and summarize the visible final state.",
    "- Perform an allowed consequential action at most once. A click acknowledgement is not success; verify the resulting UI.",
    "- Adding to a bag never authorizes login, checkout, order submission, payment, credentials, verification codes, addresses, or changes to unrelated items.",
    "- If the current request is narrower than the recorded demonstration, stop at the current request's boundary even when the recording continued farther.",
    "",
    "## Success criteria",
    "",
    "- Every ordered gate has post-action UI evidence from the current run.",
    "- The visible end state satisfies the current request and is semantically equivalent to the demonstrated result.",
    "- No action outside the current request's authorization boundary occurred.",
    "",
    "Only after all three criteria are verified may the Agent report `COMPUTER_USE_RESULT: success`; otherwise it must report failure and the first unresolved gate.",
    "",
  ].join("\n");
}

export class ComputerHistoryApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const done = (code: number | null) => {
      clearTimeout(timer);
      child.removeListener("exit", done);
      child.removeListener("close", done);
      resolve(code);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      // A signal is a request, not proof of termination. Wait for exit before
      // releasing the lifecycle lock or reporting that recording has stopped.
    }, timeoutMs);
    child.once("exit", done);
    child.once("close", done);
  });
}

function ensureHistoryFrontmatter(markdown: string, input: { title: string; sourceType: ComputerHistorySourceType }): string {
  if (markdown.startsWith("---\n")) {
    let result = markdown;
    if (!/^title:/m.test(result)) result = result.replace(/^---\n/, `---\ntitle: ${JSON.stringify(input.title)}\n`);
    if (/^source_type:/m.test(result)) result = result.replace(/^source_type:.*$/m, `source_type: ${input.sourceType}`);
    else result = result.replace(/^---\n/, `---\nsource_type: ${input.sourceType}\n`);
    return `${result.trim()}\n`;
  }
  return [
    "---",
    `title: ${JSON.stringify(input.title)}`,
    `source_type: ${input.sourceType}`,
    `captured_at: ${new Date().toISOString()}`,
    "---",
    "",
    markdown,
    "",
  ].join("\n");
}

function readSourceType(markdown: string): ComputerHistorySourceType {
  const value = readFrontmatterValue(markdown, "source_type");
  if (value === "captured" || value === "rollup" || value === "demo_fixture") return value;
  return "imported";
}

function readFrontmatterValue(markdown: string, key: string): string | null {
  const match = markdown.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
  if (!match) return null;
  return match[1].replace(/^['"]|['"]$/g, "").trim() || null;
}

function nullableFrontmatterValue(markdown: string, key: string): string | null {
  const value = readFrontmatterValue(markdown, key);
  return value === "null" || value === "~" ? null : value;
}

function validSkillMemoryId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && /^[\w:.-]+$/u.test(value);
}

function cleanTitle(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, 120) || "Computer History";
}

function cleanUserRequest(value: string): string {
  const normalized = value.replace(/[\r\n]+/g, " ").trim();
  if (!normalized) throw new ComputerHistoryApiError(400, "user request is required");
  return normalized.slice(0, 500);
}


function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gu, "-").replace(/^-|-$/g, "");
  return normalized.slice(0, 48) || "history";
}

function timestampForPath(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(":", "-");
}

function appendLog(current: string, next: string): string {
  const merged = current + next;
  return merged.length > MAX_LOG_CHARS ? merged.slice(-MAX_LOG_CHARS) : merged;
}

function moduleFile(relative: string): string {
  return fileURLToPath(new URL(`../mac/${relative}`, import.meta.url));
}

function containsWeChatEvidence(markdown: string): boolean {
  return /^sensitive_source:\s*personal_wechat\s*$/imu.test(markdown)
    || /com\.tencent\.(?:xinwechat|wechat)|win32\.(?:wechat|weixin)/iu.test(markdown);
}
