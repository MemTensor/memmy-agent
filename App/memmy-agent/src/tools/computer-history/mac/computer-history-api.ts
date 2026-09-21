import { computerHistoryPermissionError } from "../../computer-use/mac-permission-settings.js";
import {
  ObservationSettingsStore,
} from "./settings-store.js";
import {
  DEFAULT_OBSERVATION_SETTINGS,
  parseObservationSettings,
} from "./observation-settings.js";
import {
  applicationsFromMarkdown,
  applyNarrative,
  compactEventEvidence,
  isNarrated,
  writeSegmentNarrative,
} from "./summary-writer.js";
import type { LLMRuntimeResolver } from "../../../utils/llm-runtime.js";
import { readHistoryPermissions, openHistoryPermission, type HistoryPermissions, type HistoryPermission } from "./permissions.js";
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
import { ApplicationIconReader } from "./application-icon.js";
import { summarizeToFile } from "./summarize-history.js";
import { writeWorkflowCandidate } from "../../computer-use/extract-workflow-candidate.js";

export type ComputerHistorySourceType = "captured" | "rollup" | "imported" | "demo_fixture";

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
  /** Whether this entry's raw events are exempt from the retention window. */
  pinned: boolean;
  /** The raw event stream this summary was written from, while it still exists. */
  eventStreamPath: string | null;
  sourceType: ComputerHistorySourceType;
  createdAt: string;
  markdown: string;
  filePath: string;
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
  };

  histories: ComputerHistoryEntry[];
  workflows: ComputerHistoryWorkflow[];
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
}

/**
 * `paused` keeps the current segment open but stops writing to it, so the user
 * can step away from recording without losing the arc they were in the middle
 * of. `stopped` records nothing while every completed segment stays searchable.
 */
export type ObservationState = "running" | "paused" | "stopped" | "stopping" | "failed";

const SEGMENT_DURATION_MS = 10 * 60 * 1000;
const SEGMENTS_DIRECTORY_NAME = "segments";
// Enough of a stream that a summary of it says something.
const LIVE_NARRATION_MIN_BYTES = 4_000;
// How many preceding windows the model is shown, so it can relate this one to them.
const PRIOR_SUMMARY_COUNT = 2;
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
function segmentHasActivity(eventsFile: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(eventsFile, "utf8");
  } catch {
    return false;
  }
  return /"eventType"\s*:\s*"(?!recording_started"|recording_stopped")/u.test(text);
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
  private readonly recorderScript: string;
  private readonly historyDirectory: string;
  private readonly recordingDirectory: string;
  private readonly workflowDirectory: string;
  private readonly liveSummaryIntervalMs: number;
  private segment: SegmentState | null = null;
  private observationState: ObservationState = "stopped";
  private observationStartedAt: string | null = null;
  private observationError: string | null = null;
  private rotationTimer: ReturnType<typeof setTimeout> | null = null;
  private recorderTransition: Promise<void> | null = null;
  private readonly recorderChildren = new Set<ChildProcessWithoutNullStreams>();
  private readonly recorderExits = new Map<ChildProcessWithoutNullStreams, Promise<void>>();
  private readonly observationSettings: ObservationSettingsStore;
  private readonly applicationIcons: ApplicationIconReader;
  private llmRuntime: LLMRuntimeResolver | null = null;
  /** Coalesce only an active pass, so failures remain eligible for retry. */
  private backfill: Promise<number> | null = null;
  private summaryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  /** A deletion or a newer input invalidates every older model response. */
  private readonly summaryVersions = new Map<string, number>();
  private readonly summaryJobs = new Map<string, {
    version: number;
    runtime: LLMRuntimeResolver;
    promise: Promise<boolean>;
  }>();
  private narrationError: string | null = null;
  private narrationErrorCategory: "quota_exhausted" | null = null;
  private modelSource: "account" | "byok" | null = null;
  /** Segments already narrated while still open, so it happens once, not per tick. */
  private readonly narratedOpenSegments = new Set<string>();
  private readonly markdownCache = new Map<string, Map<string, CachedEntry>>();
  private permissions: HistoryPermissions | undefined;
  private readonly permissionReader: typeof readHistoryPermissions;
  private permissionStartVersion = 0;

  private get segmentsDirectory(): string {
    return path.join(this.recordingDirectory, SEGMENTS_DIRECTORY_NAME);
  }
  private liveSummaryTimer: ReturnType<typeof setInterval> | null = null;
  private liveSummarySignature: string | null = null;

  constructor(input: {
    /**
     * The recorder entry point. Tests pass a stand-in: the real one listens to
     * the keyboard and mouse, and a test that forgets to stop it leaves it
     * running long after the suite has finished.
     */
    recorderScript?: string;
    historyDirectory?: string;
    recordingDirectory?: string;
    workflowDirectory?: string;
    observationSettingsFile?: string;
    permissionReader?: typeof readHistoryPermissions;
  } = {}) {
    this.recorderScript = input.recorderScript ?? moduleFile("record-human-history.js");
    this.historyDirectory = path.resolve(input.historyDirectory
      ?? path.join(os.homedir(), ".memmy", "computer-history", "histories"));
    this.recordingDirectory = path.resolve(input.recordingDirectory
      ?? path.join(os.homedir(), ".memmy", "computer-history", "recordings"));
    this.workflowDirectory = path.resolve(input.workflowDirectory
      ?? path.join(os.homedir(), ".memmy", "computer-history", "workflows"));
    this.observationSettings = new ObservationSettingsStore(input.observationSettingsFile);
    this.applicationIcons = new ApplicationIconReader();
    this.permissionReader = input.permissionReader ?? readHistoryPermissions;
    this.liveSummaryIntervalMs = boundedInterval(
      process.env.MEMMY_COMPUTER_HISTORY_LIVE_SUMMARY_INTERVAL_MS,
      60_000,
      15_000,
      10 * 60_000,
    );
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
      .filter((markdown) => markdown && isNarrated(markdown));
  }

  /** An application's icon for the timeline, as a data URL. */
  applicationIcon(bundleId: string): Promise<string | null> {
    return this.applicationIcons.iconFor(bundleId);
  }

  /** Supplies the model used to narrate finalized segments. */
  setLlmRuntime(llmRuntime: LLMRuntimeResolver | null, source: "account" | "byok" | null = null): void {
    this.modelSource = source;
    if (this.llmRuntime !== llmRuntime) {
      this.backfill = null;
      this.summaryJobs.clear();
      this.narratedOpenSegments.clear();
      this.setNarrationError(null);
    }
    this.llmRuntime = llmRuntime;
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

  snapshot(): ComputerHistorySnapshot {
    this.cleanupExpiredRecordings();
    const snapshotAt = new Date();
    return {
      observation: {
        state: this.observationState,
        startedAt: this.observationStartedAt,
        segmentId: this.segment?.id ?? null,
        segmentStartedAt: this.segment?.startedAt ?? null,
        error: this.observationError,
        narrationError: this.narrationError,
        narrationErrorCategory: this.narrationErrorCategory,
        modelSource: this.modelSource,
        ...(this.permissions ? { permissions: this.permissions } : {}),
      },
      histories: [
        ...this.readMarkdownDirectory(this.historyDirectory).map((entry) => {
          const sourceType = readSourceType(entry.markdown);
          const hasRawEvents = this.segmentDirectoryFor(entry.id) !== null;
          return { ...entry, sourceType, replayPlan: replayPlanFor(entry, sourceType, hasRawEvents) };
        }),
      ]
        // An entry appears once it has been written. Showing the placeholder
        // would put the mechanical wording in front of the reader, which is the
        // thing the written summary exists to avoid. Rollups are machine
        // generated too: read as "imported", they slipped past this gate and
        // put a templated body on the timeline.
        .filter((entry) => !isMachineSummary(entry.sourceType) || isNarrated(entry.markdown))
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
      privacy: {
        screenshots: false,
        audio: false,
        rawRetentionHours: 48,
        markdownDirectory: this.historyDirectory,
        eventStreamDirectory: this.segmentsDirectory,
      },
    };
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
    fs.mkdirSync(directory, { recursive: true });
    fs.mkdirSync(this.historyDirectory, { recursive: true });
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
      "utf8",
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
    if (!fs.existsSync(recorder)) throw new ComputerHistoryApiError(503, "recorder script is unavailable");
    const startedAtByte = fs.existsSync(segment.eventsFile) ? fs.statSync(segment.eventsFile).size : 0;
    segment.stoppedByUser = false;
    const child = spawn(process.execPath, [
      recorder,
      "--title", `Computer History ${segment.id}`,
      "--out", segment.eventsFile,
      "--no-screenshots",
      "--capture-search-text",
      // The recorder evaluates the policy per event, because the website axis
      // depends on the URL each event carries.
      "--observation-settings", this.observationSettings.filePath,
    ], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    segment.child = child;
    this.recorderChildren.add(child);
    child.once("exit", () => this.recorderChildren.delete(child));

    const append = (chunk: Buffer) => {
      if (this.segment?.child !== child) return;
      this.segment.output = appendLog(this.segment.output, chunk.toString("utf8"));
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => {
      if (!child.pid) this.recorderChildren.delete(child);
      if (this.segment?.child !== child) return;
      this.failObservation(error.message);
    });
    child.once("exit", (code) => {
      const reason = code === 0 ? recorderUserStopReason(segment.eventsFile, startedAtByte) : null;
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
      this.failObservation(this.segment.output.trim() || `recorder exited with code ${code}`);
    });
  }

  private failObservation(message: string): void {
    const permission = computerHistoryPermissionError(message);
    this.clearLiveSummaryTimer();
    this.clearRotationTimer();
    if (this.segment) this.segment.child = null;
    if (permission === "accessibility" || permission === "inputMonitoring") {
      // Permission can be revoked between preflight and the event tap startup.
      this.permissions = { supported: true, accessibility: !message.includes("Accessibility"), inputMonitoring: !message.includes("Input Monitoring") };
      this.observationError = null;
      if (this.segment) void this.finalizeSegment(this.segment);
      this.completeObservationStop();
    } else {
      this.observationError = message;
      this.observationState = "failed";
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
    const pending = operation().finally(() => {
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
    const exited = waitForExit(child, 8_000).then(() => {
      this.recorderChildren.delete(child);
    }).finally(() => this.recorderExits.delete(child));
    this.recorderExits.set(child, exited);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    return exited;
  }

  private async detachRecorder(segment: SegmentState): Promise<void> {
    const child = segment.child;
    if (!child) return;
    segment.child = null;
    await this.stopRecorderChild(child);
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

  /** Share a request only while both its input version and runtime match. */
  private writeSummaryWith(
    file: string,
    window: "10min" | "6h",
    eventsFile: string | null,
    summaryId?: string,
  ): Promise<boolean> {
    const llmRuntime = this.llmRuntime;
    if (!llmRuntime || this.shuttingDown) return Promise.resolve(false);
    const destination = file.endsWith(".staging") ? file.slice(0, -".staging".length) : file;
    if (window === "6h") {
      const windowStart = instantFromId(path.basename(destination, ".md"));
      // Existing pending files from the former incremental implementation can
      // survive an upgrade. Keep them off the model path until the complete
      // window is available, just like newly prepared rollups.
      if (!windowStart || !isSixHourWindowClosed(windowStart)) return Promise.resolve(false);
    }
    const version = this.summaryVersions.get(destination) ?? 0;
    const active = this.summaryJobs.get(destination);
    if (active?.version === version && active.runtime === llmRuntime) return active.promise;
    const markdown = readText(file);
    if (!markdown) return Promise.resolve(false);
    if (window === "6h" && !this.preservesRollupCoverage(destination, markdown)) return Promise.resolve(false);
    const isCurrent = () => !this.shuttingDown
      && this.llmRuntime === llmRuntime
      && (this.summaryVersions.get(destination) ?? 0) === version
      && readText(file) === markdown;
    const promise = this.narratePreparedSummary(
      file, destination, window, eventsFile, summaryId, markdown, llmRuntime, isCurrent,
    ).finally(() => {
      if (this.summaryJobs.get(destination)?.promise === promise) this.summaryJobs.delete(destination);
    });
    this.summaryJobs.set(destination, { version, runtime: llmRuntime, promise });
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
    isCurrent: () => boolean,
  ): Promise<boolean> {
    // A segment is narrated from its own event stream, compacted into activity
    // arcs. A rollup has no stream of its own and is narrated from the
    // ten-minute summaries it already gathered.
    let evidence = markdown.replace(/^---\n[\s\S]*?\n---\n/u, "");
    if (eventsFile) {
      try {
        const compacted = compactEventEvidence(fs.readFileSync(eventsFile, "utf8").split("\n"));
        if (compacted) evidence = compacted;
      } catch {
        // Fall back to the mechanical summary body.
      }
    }
    const narrative = await writeSegmentNarrative(llmRuntime, {
      applications: applicationsFromMarkdown(markdown),
      evidence,
      window,
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

  startObservation(): ComputerHistorySnapshot {
    if (this.shuttingDown || this.recorderTransition || this.observationState === "stopping") {
      throw new ComputerHistoryApiError(409, "Computer History is finishing a recorder transition");
    }
    if (this.observationState === "running") {
      throw new ComputerHistoryApiError(409, "Computer History is already running");
    }
    this.ensureObservationSettings();
    this.assertObservesSomething();
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
    try {
      this.spawnRecorder(segment);
    } catch (error) {
      this.failObservation(error instanceof Error ? error.message : String(error));
      throw error;
    }
    this.startLiveSummaryTimer();
    this.startRotationTimer();
    return this.snapshot();
  }

  async checkPermissions(): Promise<HistoryPermissions> {
    const status = await this.permissionReader();
    this.permissions = status;
    return status;
  }

  async openPermission(permission: HistoryPermission, mode: "request" | "settings" = "settings"): Promise<HistoryPermissions> {
    this.permissions = await openHistoryPermission(permission, mode);
    return this.permissions;
  }

  /** Missing consent is an onboarding state, before creating any recording. */
  async startObservationWithPermissions(resume = false): Promise<ComputerHistorySnapshot> {
    const version = ++this.permissionStartVersion;
    const status = await this.checkPermissions();
    if (version !== this.permissionStartVersion || this.shuttingDown) return this.snapshot();
    if (!status.supported) throw new ComputerHistoryApiError(400, "Computer History recording requires macOS");
    if (!status.accessibility || !status.inputMonitoring) {
      this.observationError = null;
      if (this.observationState === "failed") {
        if (this.segment) void this.finalizeSegment(this.segment);
        this.completeObservationStop();
      }
      return this.snapshot();
    }
    return resume ? this.resumeObservation() : this.startObservation();
  }

  /**
   * Makes the policy an explicit document before the recorder reads it.
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
   * The default observes everything, so this only fires for someone who
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
    if (this.recorderTransition || this.shuttingDown) {
      throw new ComputerHistoryApiError(409, "Computer History is finishing a recorder transition");
    }
    if (this.observationState !== "running") {
      throw new ComputerHistoryApiError(409, "Computer History is not running");
    }
    this.clearLiveSummaryTimer();
    this.clearRotationTimer();
    await this.trackRecorderTransition(async () => {
      const segment = this.segment;
      if (segment) await this.detachRecorder(segment);
      if (segment?.stoppedByUser) {
        void this.finalizeSegment(segment);
        this.completeObservationStop();
        return;
      }
      this.observationState = "paused";
    });
    return this.snapshot();
  }

  resumeObservation(): ComputerHistorySnapshot {
    if (this.observationState !== "paused") {
      throw new ComputerHistoryApiError(409, "Computer History is not paused");
    }
    return this.startObservation();
  }

  private completeObservationStop(): void {
    this.clearLiveSummaryTimer();
    this.clearRotationTimer();
    this.segment = null;
    this.observationStartedAt = null;
    this.observationState = "stopped";
  }

  async stopObservation(): Promise<ComputerHistorySnapshot> {
    ++this.permissionStartVersion;
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
    if (this.summaryRetryTimer) clearTimeout(this.summaryRetryTimer);
    this.summaryRetryTimer = null;
    try {
      if (this.recorderTransition || this.observationState !== "stopped") await this.stopObservation();
    } catch {
      // Shutdown is best effort; a failed segment must not block app exit.
    }
    await Promise.all([...this.recorderChildren].map((child) => this.stopRecorderChild(child)));
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
    if (!segmentHasActivity(segment.eventsFile)) return;
    // Leave a written summary alone for the rest of the segment. The mechanical
    // pass rewrites the whole file, so running it again would put the
    // placeholder back over the account; and because narration runs once per
    // open segment, nothing would rewrite it until the segment closed. The
    // entry would appear, then vanish from the timeline on the next tick.
    // Closing the segment regenerates and narrates it with the full window.
    if (isSummaryWritten(segment.historyFile)) return;
    if (this.summaryJobs.has(segment.historyFile)) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(segment.eventsFile);
    } catch {
      return;
    }
    const signature = `${stat.size}:${stat.mtimeMs}`;
    if (!stat.size) return;
    if (signature !== this.liveSummarySignature || !fs.existsSync(segment.historyFile)) {
      this.invalidateSummary(segment.historyFile);
      const error = this.writeSegmentSummary(segment);
      if (error) return;
      this.liveSummarySignature = signature;
    }

    // Narrate an open segment once it has enough to say. Waiting for the
    // segment to close left the entry reading mechanically for the whole ten
    // minutes someone is most likely to look at it.
    if (stat.size >= LIVE_NARRATION_MIN_BYTES && !this.narratedOpenSegments.has(segment.id)) {
      this.narratedOpenSegments.add(segment.id);
      void this.writeSummaryWith(segment.historyFile, "10min", segment.eventsFile).finally(() => {
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
        const size = fs.statSync(eventsFile).size;
        const standing = readText(historyFile);
        const prepared = readText(staging) ?? standing;
        if (prepared && readFrontmatterValue(prepared, "capture_complete") === "true"
          && Number(readFrontmatterValue(prepared, "summary_input_bytes")) === size) continue;
        let metadata: Record<string, unknown> = {};
        try { metadata = JSON.parse(readText(path.join(directory, "metadata.json")) ?? "{}") ?? {}; } catch { /* Legacy segment. */ }
        // Legacy metadata has no open/closed state or byte marker. A completed
        // summary is safe to retain only if the stream ended before it was
        // written, rather than reopening after an earlier recording_stopped.
        if (prepared && !readFrontmatterValue(prepared, "summary_input_bytes")
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
      summarizeToFile({ file: segment.eventsFile, out: destination, title: `Computer History ${segment.id}` });
      const raw = fs.readFileSync(segment.eventsFile, "utf8");
      const interrupted = closed && !recordingEnded(raw);
      const markdown = fs.readFileSync(destination, "utf8")
        .replace(/^source_type:\s*human_computer_history\s*$/m, "source_type: captured")
        .replace(/^status:.*$/m, `status: ${closed ? "completed" : "incomplete"}`)
        .replace(/^---\n/, "---\ncapture_policy: accessibility_events_and_page_urls_no_screenshots\n"
          + `capture_complete: ${closed}\nsummary_input_bytes: ${Buffer.byteLength(raw, "utf8")}\n`
          + (interrupted ? "capture_end_reason: interrupted\n" : ""));
      // Retention can remove raw files while the model is offline. Keep the
      // bounded, distilled input with the pending summary so a later retry
      // still has evidence. applyNarrative replaces it on success.
      const evidence = compactEventEvidence(raw.split("\n"));
      const pending = evidence ? markdown.replace("（尚未生成）", evidence) : markdown;
      atomicWriteText(destination, pending);
      if (closed) {
        let metadata = {};
        try { metadata = JSON.parse(readText(segment.metadataFile) ?? "{}"); } catch { /* Legacy segment. */ }
        atomicWriteText(segment.metadataFile, `${JSON.stringify({ ...metadata, startedAt: segment.startedAt, state: "closed" }, null, 2)}\n`);
      }
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
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
    const file = path.join(this.historyDirectory, `${id}.md`);
    this.invalidateSummary(file);
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.staging`, { force: true });
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
            if (!entry.isFile() || !/\.md(?:\.staging)?$/u.test(entry.name)) continue;
            const id = entry.name.replace(/\.md(?:\.staging)?$/u, "");
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
    // Searching is evidence retrieval, not replay selection. Filtering by
    // replayability meant an entry vanished from search the moment its raw
    // events expired — exactly when the written summary is all that is left and
    // the only thing that can still answer "what was I doing".
    return this.snapshot().histories
      // An entry asked for by id is the answer whatever the query ranks it; it
      // used to be filtered only after the top few were kept, so an entry
      // outside them came back as nothing.
      .filter((history) => !options.historyId || history.id === options.historyId)
      .map((history) => {
        const title = searchableText(history.title);
        const markdown = searchableText(history.markdown);
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
          if (segmentAgeMs(target) < cutoff) fs.rmSync(target, { recursive: true, force: true });
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
    fs.writeFileSync(temporary, text, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function hashText(value: string): string {
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

function buildRecordedExperienceWorkflow(input: {
  history: ComputerHistoryEntry;
  request: string;
  steps: string[];
}): string {
  const gateSections = input.steps.map((step, index) => [
    `### Gate ${index + 1} of ${input.steps.length}`,
    "",
    `Recorded semantic action: ${step}`,
    "",
    "- Read the target application's current window state immediately before acting.",
    "- Locate the target from current Accessibility text, role, value, or visible UI; never use a recorded coordinate.",
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
    "This Workflow was distilled from an explicit human demonstration. It is a semantic state machine, not a macro: raw coordinates and exact scroll distances are deliberately excluded.",
    "",
    "## Execution contract",
    "",
    "1. Start by stating the current request, the source History title, and the safety boundary inferred from the request.",
    "2. Use only the Open Computer Use MCP tools `mcp_open_computer_use_list_apps`, `mcp_open_computer_use_get_app_state`, `mcp_open_computer_use_click`, `mcp_open_computer_use_type_text`, `mcp_open_computer_use_press_key`, and `mcp_open_computer_use_scroll`. If these tools are unavailable, stop and report the workflow as blocked; never substitute another desktop executor.",
    "3. Execute the gates below strictly in order. Maintain a visible checklist such as `G1 verified / G2 pending`; never search for a later action while an earlier gate is unresolved.",
    "4. Start with `list_apps` and `get_app_state`. Open Computer Use action tools return refreshed post-action state; use that result as verification evidence instead of immediately calling `get_app_state` again. Read state again only after an out-of-band UI change or when the action result lacks the evidence needed for the next gate.",
    "5. Element indexes are state-scoped. Use only an `element_index` from the latest returned state, and never reuse an index after a click, key action, scroll, navigation, modal change, or page reload.",
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


/**
 * A file shipped beside this module.
 *
 * Everything Computer History runs — the recorder, its Swift helper, the replay
 * script — is compiled or copied into the same tree as this file, so it is
 * found relative to the module rather than by searching upward for a
 * repository checkout that a packaged app does not have.
 */
function moduleFile(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

let defaultComputerHistoryDemoService: ComputerHistoryDemoService | null = null;

export function getComputerHistoryDemoService(): ComputerHistoryDemoService {
  defaultComputerHistoryDemoService ??= new ComputerHistoryDemoService();
  return defaultComputerHistoryDemoService;
}
