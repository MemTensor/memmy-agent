import {
  ObservationSettingsStore,
} from "../../core/agent-runtime/computer-history/settings-store.js";
import {
  applicationsFromMarkdown,
  applyNarrative,
  writeSegmentNarrative,
} from "../../core/agent-runtime/computer-history/summary-writer.js";
import type { LLMRuntimeResolver } from "../../utils/llm-runtime.js";
import {
  SIX_HOUR_MS,
  alignedId,
  buildSixHourSummary,
  instantFromId,
} from "../../core/agent-runtime/computer-history/rollup.js";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ComputerHistorySourceType = "captured" | "imported" | "demo_fixture";

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
  };
  cuaRun: {
    kind: "smoke" | "workflow" | null;
    status: "idle" | "running" | "completed" | "failed";
    startedAt: string | null;
    finishedAt: string | null;
    output: string;
    error: string | null;
  };
  histories: ComputerHistoryEntry[];
  workflows: ComputerHistoryWorkflow[];
  privacy: {
    screenshots: false;
    audio: false;
    rawRetentionHours: 48;
    markdownDirectory: string;
  };
}

export interface ComputerHistoryMatch {
  history: ComputerHistoryEntry;
  score: number;
  matchedTerms: string[];
}

export interface ComputerHistoryReplayResult {
  history: ComputerHistoryEntry;
  workflow: ComputerHistoryWorkflow;
  snapshot: ComputerHistorySnapshot;
}

export interface ComputerHistoryPreparationResult extends ComputerHistoryReplayResult {
  steps: string[];
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
  workflowCandidateFile: string;
  output: string;
}

/**
 * `paused` keeps the current segment open but stops writing to it, so the user
 * can step away from recording without losing the arc they were in the middle
 * of. `stopped` records nothing while every completed segment stays searchable.
 */
export type ObservationState = "running" | "paused" | "stopped" | "stopping" | "failed";

const SEGMENT_DURATION_MS = 10 * 60 * 1000;

// A six-hour rollup is cheap because it reuses ten-minute summaries, so it can
// run every time a segment is finalized rather than on its own schedule.

interface RunState {
  child: ChildProcessWithoutNullStreams | null;
  kind: "smoke" | "workflow" | null;
  status: "idle" | "running" | "completed" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  output: string;
  error: string | null;
}

interface MarkdownEntry {
  id: string;
  title: string;
  description: string | null;
  applications: string[];
  summaryWindow: "10min" | "6h" | null;
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

export function isCodexSkysightCopy(historyId: string): boolean {
  return CODEX_SKYSIGHT_FILE.test(historyId);
}

function boundedInterval(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

export class ComputerHistoryDemoService {
  private readonly repositoryRoot: string;
  private readonly historyDirectory: string;
  private readonly recordingDirectory: string;
  private readonly workflowDirectory: string;
  private readonly liveSummaryIntervalMs: number;
  private segment: SegmentState | null = null;
  private observationState: ObservationState = "stopped";
  private observationStartedAt: string | null = null;
  private observationError: string | null = null;
  private rotationTimer: ReturnType<typeof setInterval> | null = null;
  private readonly observationSettings: ObservationSettingsStore;
  private llmRuntime: LLMRuntimeResolver | null = null;
  private liveSummaryTimer: ReturnType<typeof setInterval> | null = null;
  private liveSummarySignature: string | null = null;
  private run: RunState = {
    child: null,
    kind: null,
    status: "idle",
    startedAt: null,
    finishedAt: null,
    output: "",
    error: null,
  };

  constructor(input: {
    repositoryRoot?: string;
    historyDirectory?: string;
    recordingDirectory?: string;
    workflowDirectory?: string;
    observationSettingsFile?: string;
  } = {}) {
    this.repositoryRoot = path.resolve(input.repositoryRoot ?? defaultRepositoryRoot());
    this.historyDirectory = path.resolve(input.historyDirectory
      ?? path.join(os.homedir(), ".memmy", "computer-history", "histories"));
    this.recordingDirectory = path.resolve(input.recordingDirectory
      ?? path.join(os.homedir(), ".memmy", "computer-history", "recordings"));
    this.workflowDirectory = path.resolve(input.workflowDirectory
      ?? path.join(os.homedir(), ".memmy", "computer-history", "workflows"));
    this.observationSettings = new ObservationSettingsStore(input.observationSettingsFile);
    this.liveSummaryIntervalMs = boundedInterval(
      process.env.MEMMY_COMPUTER_HISTORY_LIVE_SUMMARY_INTERVAL_MS,
      60_000,
      15_000,
      10 * 60_000,
    );
  }

  /** Supplies the model used to narrate finalized segments. */
  setLlmRuntime(llmRuntime: LLMRuntimeResolver | null): void {
    this.llmRuntime = llmRuntime;
  }

  snapshot(): ComputerHistorySnapshot {
    this.cleanupExpiredRecordings();
    return {
      observation: {
        state: this.observationState,
        startedAt: this.observationStartedAt,
        segmentId: this.segment?.id ?? null,
        segmentStartedAt: this.segment?.startedAt ?? null,
        error: this.observationError,
      },
      cuaRun: {
        kind: this.run.kind,
        status: this.run.status,
        startedAt: this.run.startedAt,
        finishedAt: this.run.finishedAt,
        output: this.run.output,
        error: this.run.error,
      },
      histories: [
        ...this.readMarkdownDirectory(this.historyDirectory).map((entry) => {
          const sourceType = readSourceType(entry.markdown);
          return { ...entry, sourceType, replayPlan: replayPlanFor(entry, sourceType) };
        }),
      ].filter((entry) => !isCodexSkysightCopy(entry.id)),
      workflows: this.readMarkdownDirectory(this.workflowDirectory).map((entry) => ({
        ...entry,
        sourceHistoryId: nullableFrontmatterValue(entry.markdown, "source_history_id"),
      })),
      privacy: {
        screenshots: false,
        audio: false,
        rawRetentionHours: 48,
        markdownDirectory: this.historyDirectory,
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

  installDemoFixture(): ComputerHistorySnapshot {
    const fixture = path.join(this.repositoryRoot, "workflows", "demo-fixtures", "wechat-mom-iphone-history.md");
    if (!fs.existsSync(fixture)) throw new ComputerHistoryApiError(503, "demo fixture is unavailable");
    return this.importMarkdown({
      markdown: fs.readFileSync(fixture, "utf8"),
      sourceType: "demo_fixture",
    });
  }

  private segmentId(at: Date): string {
    // Align segment ids to the ten-minute grid so their names sort and group
    // the same way Codex's do, and so the rollup can parse them back.
    return alignedId(at, SEGMENT_DURATION_MS);
  }

  private openSegment(): SegmentState {
    const startedAt = new Date();
    const id = this.segmentId(startedAt);
    const directory = path.join(this.recordingDirectory, "segments", id);
    fs.mkdirSync(directory, { recursive: true });
    fs.mkdirSync(this.historyDirectory, { recursive: true });
    fs.mkdirSync(this.workflowDirectory, { recursive: true });
    const eventsFile = path.join(directory, "events.jsonl");
    const metadataFile = path.join(directory, "metadata.json");
    fs.writeFileSync(
      metadataFile,
      `${JSON.stringify({ id, startedAt: startedAt.toISOString(), eventsPath: eventsFile }, null, 2)}\n`,
      "utf8",
    );
    return {
      child: null,
      id,
      directory,
      startedAt: startedAt.toISOString(),
      eventsFile,
      metadataFile,
      historyFile: path.join(this.historyDirectory, `${id}-10min-summary.md`),
      workflowCandidateFile: path.join(this.workflowDirectory, `${id}-candidate.md`),
      output: "",
    };
  }

  private spawnRecorder(segment: SegmentState): void {
    const recorder = path.join(this.repositoryRoot, "workflows", "scripts", "record-human-history.mjs");
    if (!fs.existsSync(recorder)) throw new ComputerHistoryApiError(503, "recorder script is unavailable");
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
      cwd: this.repositoryRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    segment.child = child;

    const append = (chunk: Buffer) => {
      if (this.segment?.child !== child) return;
      this.segment.output = appendLog(this.segment.output, chunk.toString("utf8"));
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => {
      if (this.segment?.child !== child) return;
      this.failObservation(error.message);
    });
    child.once("exit", (code) => {
      if (this.segment?.child !== child) return;
      // Pausing, rotating and stopping all detach the child first, so reaching
      // here means the recorder died on its own.
      if (this.observationState !== "running") return;
      this.failObservation(this.segment.output.trim() || `recorder exited with code ${code}`);
    });
  }

  private failObservation(message: string): void {
    this.clearLiveSummaryTimer();
    this.clearRotationTimer();
    if (this.segment) this.segment.child = null;
    this.observationError = message;
    this.observationState = "failed";
  }

  private clearRotationTimer(): void {
    if (this.rotationTimer) clearInterval(this.rotationTimer);
    this.rotationTimer = null;
  }

  private startRotationTimer(): void {
    this.clearRotationTimer();
    this.rotationTimer = setInterval(() => {
      if (this.observationState !== "running") return;
      this.rotateSegment();
    }, SEGMENT_DURATION_MS);
  }

  private async detachRecorder(segment: SegmentState): Promise<void> {
    const child = segment.child;
    if (!child) return;
    segment.child = null;
    child.kill("SIGTERM");
    await waitForExit(child, 8_000);
  }

  /** Summarizes a segment and leaves it behind as searchable history. */
  private finalizeSegment(segment: SegmentState): void {
    if (!fs.existsSync(segment.eventsFile) || !fs.statSync(segment.eventsFile).size) return;
    const error = this.writeSegmentSummary(segment);
    if (error) {
      this.observationError = error;
      return;
    }
    this.narrateSummary(segment.historyFile, "10min");
    this.writeSixHourRollup(segment.id);
  }

  /**
   * Rewrites a finished summary's title and description with a model-written
   * account of the window.
   *
   * Deliberately fire-and-forget: the mechanical summary is already on disk, so
   * a slow or unreachable model delays the better wording, never the recording.
   */
  private narrateSummary(file: string, window: "10min" | "6h"): void {
    const llmRuntime = this.llmRuntime;
    if (!llmRuntime) return;
    void (async () => {
      let markdown: string;
      try {
        markdown = fs.readFileSync(file, "utf8");
      } catch {
        return;
      }
      const narrative = await writeSegmentNarrative(llmRuntime, {
        applications: applicationsFromMarkdown(markdown),
        evidence: markdown.replace(/^---\n[\s\S]*?\n---\n/u, ""),
        window,
      });
      if (!narrative) return;
      try {
        // Re-read: a rollup may have rewritten the file while the model ran.
        fs.writeFileSync(file, applyNarrative(fs.readFileSync(file, "utf8"), narrative), "utf8");
      } catch {
        // Losing the better wording is acceptable; the summary itself stands.
      }
    })();
  }

  /** Rebuilds the six-hour summary covering the segment that just closed. */
  private writeSixHourRollup(segmentId: string): void {
    const at = instantFromId(segmentId);
    if (!at) return;
    const windowStart = new Date(Math.floor(at.getTime() / SIX_HOUR_MS) * SIX_HOUR_MS);
    let names: string[];
    try {
      names = fs.readdirSync(this.historyDirectory);
    } catch {
      return;
    }
    const summaries = names
      .filter((name) => name.endsWith(".md") && name.includes("-10min-"))
      .map((name) => ({
        name,
        markdown: fs.readFileSync(path.join(this.historyDirectory, name), "utf8"),
      }));
    const rollup = buildSixHourSummary(summaries, windowStart);
    if (!rollup) return;
    const rollupFile = path.join(this.historyDirectory, rollup.fileName);
    fs.writeFileSync(rollupFile, rollup.markdown, "utf8");
    this.narrateSummary(rollupFile, "6h");
  }

  private rotateSegment(): void {
    const previous = this.segment;
    if (!previous) return;
    void this.detachRecorder(previous).then(() => {
      this.finalizeSegment(previous);
      if (this.observationState !== "running") return;
      const next = this.openSegment();
      this.segment = next;
      try {
        this.spawnRecorder(next);
      } catch (error) {
        this.failObservation(error instanceof Error ? error.message : String(error));
      }
    });
  }

  startObservation(): ComputerHistorySnapshot {
    if (this.observationState === "running") {
      throw new ComputerHistoryApiError(409, "Computer History is already running");
    }
    this.assertObservesSomething();
    this.cleanupExpiredRecordings();
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

  /**
   * Refuses to start when the policy would record nothing.
   *
   * The default is do-not-observe, so a fresh install has no allowed apps yet.
   * Starting anyway would look like it was recording while producing empty
   * segments, so say what is missing instead.
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
    if (this.observationState !== "running") {
      throw new ComputerHistoryApiError(409, "Computer History is not running");
    }
    this.clearLiveSummaryTimer();
    this.clearRotationTimer();
    if (this.segment) await this.detachRecorder(this.segment);
    this.observationState = "paused";
    return this.snapshot();
  }

  resumeObservation(): ComputerHistorySnapshot {
    if (this.observationState !== "paused") {
      throw new ComputerHistoryApiError(409, "Computer History is not paused");
    }
    return this.startObservation();
  }

  async stopObservation(): Promise<ComputerHistorySnapshot> {
    if (this.observationState === "stopped") {
      throw new ComputerHistoryApiError(409, "Computer History is not running");
    }
    const segment = this.segment;
    this.observationState = "stopping";
    this.clearLiveSummaryTimer();
    this.clearRotationTimer();
    if (segment) {
      await this.detachRecorder(segment);
      this.finalizeSegment(segment);
    }
    this.segment = null;
    this.observationStartedAt = null;
    this.observationState = "stopped";
    return this.snapshot();
  }

  /** Called when the desktop app exits: recording does not outlive the app. */
  async shutdown(): Promise<void> {
    if (this.observationState === "stopped") return;
    try {
      await this.stopObservation();
    } catch {
      // Shutdown is best effort; a failed segment must not block app exit.
    }
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
    if (!fs.existsSync(segment.eventsFile)) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(segment.eventsFile);
    } catch {
      return;
    }
    const signature = `${stat.size}:${stat.mtimeMs}`;
    if (!stat.size || signature === this.liveSummarySignature) return;
    const error = this.writeSegmentSummary(segment);
    if (!error) this.liveSummarySignature = signature;
  }

  private writeSegmentSummary(segment: SegmentState): string | null {
    const summarizer = path.join(this.repositoryRoot, "workflows", "scripts", "summarize-history.mjs");
    const result = spawnSync(process.execPath, [
      summarizer,
      "--file", segment.eventsFile,
      "--out", segment.historyFile,
      "--title", `Computer History ${segment.id}`,
    ], { cwd: this.repositoryRoot, encoding: "utf8", timeout: 30_000 });
    if (result.status !== 0 || !fs.existsSync(segment.historyFile)) {
      return String(result.stderr || result.stdout || "failed to distill captured events").trim();
    }
    const markdown = fs.readFileSync(segment.historyFile, "utf8")
      .replace(/^source_type:\s*human_computer_history\s*$/m, "source_type: captured")
      .replace(/^---\n/, "---\ncapture_policy: accessibility_events_and_page_urls_no_screenshots\n");
    fs.writeFileSync(segment.historyFile, markdown, "utf8");
    this.writeWorkflowCandidate(segment);
    return null;
  }

  private writeWorkflowCandidate(segment: SegmentState): void {
    const extractor = path.join(this.repositoryRoot, "workflows", "scripts", "extract-workflow-candidate.mjs");
    if (!fs.existsSync(extractor)) return;
    const historyTitle = fs.existsSync(segment.historyFile)
      ? readFrontmatterValue(fs.readFileSync(segment.historyFile, "utf8"), "title") ?? `Computer History ${segment.id}`
      : `Computer History ${segment.id}`;
    const result = spawnSync(process.execPath, [
      extractor,
      "--file", segment.eventsFile,
      "--out", segment.workflowCandidateFile,
      "--title", historyTitle,
      "--source-history-id", path.basename(segment.historyFile, ".md"),
    ], { cwd: this.repositoryRoot, encoding: "utf8", timeout: 30_000 });
    if (result.status !== 0 && result.status !== 2) {
      this.observationError = String(result.stderr || result.stdout || "failed to derive workflow candidate").trim();
    }
  }

  deleteHistory(historyId: string): ComputerHistorySnapshot {
    const history = this.findHistory(historyId.trim());
    const derivedWorkflows = this.snapshot().workflows.filter((workflow) => workflow.sourceHistoryId === history.id);
    fs.rmSync(history.filePath, { force: true });
    for (const workflow of derivedWorkflows) fs.rmSync(workflow.filePath, { force: true });
    fs.rmSync(path.join(this.recordingDirectory, history.id), { recursive: true, force: true });
    return this.snapshot();
  }

  createWorkflow(historyId: string, userRequest = ""): ComputerHistorySnapshot {
    const history = this.findHistory(historyId);
    const request = cleanUserRequest(userRequest || "帮我把妈妈之前说的那台 iPhone 配好，加入购物袋就停，不要结账或支付。");
    if (history.sourceType === "captured") {
      if (history.sourceType === "captured" && readFrontmatterValue(history.markdown, "status") !== "completed") {
        throw new ComputerHistoryApiError(422, "the selected operation-experience recording is incomplete");
      }
      if (history.sourceType === "captured" && readFrontmatterValue(history.markdown, "experience_version") !== "1") {
        throw new ComputerHistoryApiError(422, "the selected recording does not contain reusable semantic operation experience");
      }
      const candidate = this.snapshot().workflows.find((workflow) => (
        workflow.sourceHistoryId === history.id
        && readFrontmatterValue(workflow.markdown, "kind") === "computer_use_workflow_candidate"
      ));
      const steps = normalizeRecordedExperienceSteps(
        extractCandidateSteps(candidate?.markdown ?? "")
          .concat(candidate ? [] : extractReusableExperienceSteps(history.markdown)),
      );
      if (!steps.length) {
        throw new ComputerHistoryApiError(422, "the selected recording contains no reusable semantic action");
      }
      const id = `${timestampForPath()}-recorded-operation-experience-computer-use`;
      const markdown = buildRecordedExperienceWorkflow({ history, request, steps });
      fs.mkdirSync(this.workflowDirectory, { recursive: true });
      fs.writeFileSync(path.join(this.workflowDirectory, `${id}.md`), markdown, { encoding: "utf8", flag: "wx" });
      return this.snapshot();
    }
    if (history.sourceType !== "demo_fixture") {
      throw new ComputerHistoryApiError(422, "select a completed operation-experience recording or the WeChat mom iPhone demo History");
    }
    if (readFrontmatterValue(history.markdown, "demo_id") !== "wechat_mom_iphone") {
      throw new ComputerHistoryApiError(422, "select the WeChat mom iPhone demo History before generating this Workflow");
    }
    const fixture = path.join(this.repositoryRoot, "workflows", "demo-fixtures", "wechat-mom-iphone-workflow.md");
    if (!fs.existsSync(fixture)) throw new ComputerHistoryApiError(503, "workflow fixture is unavailable");
    const id = `${timestampForPath()}-wechat-mom-iphone-cua`;
    const markdown = fs.readFileSync(fixture, "utf8")
      .replace("source_history_id: DEMO_HISTORY_ID", `source_history_id: ${history.id}`)
      .replace("source_history_path: DEMO_HISTORY_PATH", `source_history_path: ${history.filePath}`)
      .replace("user_request: DEMO_USER_REQUEST", `user_request: ${JSON.stringify(request)}`)
      .replace("DEMO_USER_REQUEST_TEXT", request);
    fs.mkdirSync(this.workflowDirectory, { recursive: true });
    fs.writeFileSync(path.join(this.workflowDirectory, `${id}.md`), markdown, { encoding: "utf8", flag: "wx" });
    return this.snapshot();
  }

  searchHistories(query: string, limit = 5): ComputerHistoryMatch[] {
    const terms = queryTerms(query);
    return this.snapshot().histories
      .filter(historySupportsReplay)
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

  replayUserRequest(input: { userRequest: string; historyId?: string | null }): ComputerHistoryReplayResult {
    const prepared = this.prepareReplayUserRequest(input);
    const snapshot = this.startCuaRun(prepared.workflow.id, []);
    return { history: prepared.history, workflow: prepared.workflow, snapshot };
  }

  prepareReplayUserRequest(input: { userRequest: string; historyId?: string | null }): ComputerHistoryPreparationResult {
    const userRequest = cleanUserRequest(input.userRequest);
    const history = input.historyId
      ? this.findHistory(input.historyId)
      : this.searchHistories(userRequest, 1)[0]?.history;
    if (!history) {
      throw new ComputerHistoryApiError(404, "no reusable Computer History matched this request");
    }
    if (!historySupportsReplay(history)) {
      throw new ComputerHistoryApiError(422, "the selected Computer History does not contain replayable semantic steps");
    }
    const existingWorkflowIds = new Set(this.snapshot().workflows.map((candidate) => candidate.id));
    const afterWorkflow = this.createWorkflow(history.id, userRequest);
    const workflow = afterWorkflow.workflows.find((candidate) => (
      candidate.sourceHistoryId === history.id && !existingWorkflowIds.has(candidate.id)
    ));
    if (!workflow) throw new ComputerHistoryApiError(500, "workflow generation did not produce an artifact");
    const steps = history.sourceType === "captured"
      ? normalizeRecordedExperienceSteps(extractReusableExperienceSteps(history.markdown))
      : extractWorkflowRecordedActions(workflow.markdown);
    return { history, workflow, snapshot: afterWorkflow, steps };
  }

  startCuaRun(
    workflowId: string,
    variables: string[],
    kind: "smoke" | "workflow" = "workflow",
  ): ComputerHistorySnapshot {
    if (this.run.status === "running") throw new ComputerHistoryApiError(409, "a CUA run is already active");
    const workflow = this.findWorkflow(workflowId);
    const replay = path.join(this.repositoryRoot, "workflows", "scripts", "replay-cua.sh");
    if (!fs.existsSync(replay)) throw new ComputerHistoryApiError(503, "CUA replay script is unavailable");
    const child = spawn("bash", [replay, workflow.filePath, ...variables.slice(0, 20)], {
      cwd: this.repositoryRoot,
      env: {
        ...process.env,
        PATH: `${path.join(os.homedir(), ".local", "bin")}:${process.env.PATH ?? ""}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.run = {
      child,
      kind,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      output: "",
      error: null,
    };
    const append = (chunk: Buffer) => {
      if (this.run.child !== child) return;
      this.run.output = appendLog(this.run.output, chunk.toString("utf8"));
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => {
      if (this.run.child !== child) return;
      this.run.status = "failed";
      this.run.error = error.message;
      this.run.finishedAt = new Date().toISOString();
      this.run.child = null;
    });
    child.once("exit", (code) => {
      if (this.run.child !== child) return;
      this.run.status = code === 0 ? "completed" : "failed";
      this.run.error = code === 0
        ? null
        : lastMeaningfulLogLine(this.run.output) || `CUA process exited with code ${code}`;
      this.run.finishedAt = new Date().toISOString();
      this.run.child = null;
    });
    return this.snapshot();
  }

  startCuaSmokeTest(): ComputerHistorySnapshot {
    if (this.run.status === "running") throw new ComputerHistoryApiError(409, "a CUA run is already active");
    const fixture = path.join(this.repositoryRoot, "workflows", "demo-fixtures", "cua-browser-smoke-workflow.md");
    if (!fs.existsSync(fixture)) throw new ComputerHistoryApiError(503, "CUA smoke-test fixture is unavailable");
    const id = `${timestampForPath()}-cua-browser-smoke`;
    fs.mkdirSync(this.workflowDirectory, { recursive: true });
    fs.writeFileSync(path.join(this.workflowDirectory, `${id}.md`), fs.readFileSync(fixture, "utf8"), {
      encoding: "utf8",
      flag: "wx",
    });
    return this.startCuaRun(id, [], "smoke");
  }

  private findHistory(id: string): ComputerHistoryEntry {
    const entry = this.snapshot().histories.find((candidate) => candidate.id === id);
    if (!entry) throw new ComputerHistoryApiError(404, "history not found");
    return entry;
  }

  private findWorkflow(id: string): ComputerHistoryWorkflow {
    const entry = this.snapshot().workflows.find((candidate) => candidate.id === id);
    if (!entry) throw new ComputerHistoryApiError(404, "workflow not found");
    return entry;
  }

  private readMarkdownDirectory(directory: string): MarkdownEntry[] {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => {
        const filePath = path.join(directory, entry.name);
        const markdown = fs.readFileSync(filePath, "utf8");
        const stat = fs.statSync(filePath);
        const id = entry.name.slice(0, -3);
        return {
          id,
          title: readFrontmatterValue(markdown, "title") || id,
          description: nullableFrontmatterValue(markdown, "description"),
          applications: applicationsFromMarkdown(markdown),
          summaryWindow: id.endsWith("-10min-summary")
            ? ("10min" as const)
            : id.endsWith("-6h-summary")
              ? ("6h" as const)
              : null,
          createdAt: readFrontmatterValue(markdown, "captured_at") || stat.mtime.toISOString(),
          markdown,
          filePath,
        };
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private cleanupExpiredRecordings(): void {
    if (!fs.existsSync(this.recordingDirectory)) return;
    const cutoff = Date.now() - RAW_RETENTION_MS;
    for (const entry of fs.readdirSync(this.recordingDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(this.recordingDirectory, entry.name);
      if (fs.statSync(candidate).mtimeMs < cutoff) fs.rmSync(candidate, { recursive: true, force: true });
    }
  }
}

function extractReusableExperienceSteps(markdown: string): string[] {
  const heading = markdown.match(/^## Reusable operation experience\s*$/mu);
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

function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}


function replayPlanFor(entry: MarkdownEntry, sourceType: ComputerHistorySourceType): ComputerHistoryReplayPlan | null {
  if (sourceType !== "captured") return null;
  const steps = normalizeRecordedExperienceSteps(extractReusableExperienceSteps(entry.markdown));
  return {
    sourcePath: entry.filePath,
    sourceHash: hashText(entry.markdown),
    status: steps.length ? "ready" : "not_replayable",
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

function extractWorkflowRecordedActions(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => line.match(/^Recorded semantic action:\s*(.+?)\s*$/u)?.[1] ?? "")
    .filter(Boolean)
    .slice(0, 80);
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

function historySupportsReplay(history: ComputerHistoryEntry): boolean {
  if (history.sourceType === "demo_fixture") {
    return readFrontmatterValue(history.markdown, "demo_id") === "wechat_mom_iphone";
  }
  return history.sourceType === "captured"
    && readFrontmatterValue(history.markdown, "status") === "completed"
    && readFrontmatterValue(history.markdown, "experience_version") === "1"
    && extractReusableExperienceSteps(history.markdown).length > 0;
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
    "2. Prefer the Open Computer Use MCP tools `mcp_open_computer_use_list_apps`, `mcp_open_computer_use_get_app_state`, `mcp_open_computer_use_click`, `mcp_open_computer_use_type_text`, `mcp_open_computer_use_press_key`, and `mcp_open_computer_use_scroll`. Use built-in `computer_*` tools only if the MCP tools are unavailable; never mix executors within one gate and do not start a CUA subprocess.",
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
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
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
  if (value === "captured" || value === "demo_fixture") return value;
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

function cleanCaptureUrl(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) return null;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new ComputerHistoryApiError(400, "starting URL must be a valid http(s) URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ComputerHistoryApiError(400, "starting URL must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new ComputerHistoryApiError(400, "starting URL must not contain credentials");
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().slice(0, 2048);
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

function lastMeaningfulLogLine(value: string): string | null {
  const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.at(-1) ?? null;
}

function defaultRepositoryRoot(): string {
  let candidate = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (
      fs.existsSync(path.join(candidate, "App", "memmy-agent", "package.json"))
      && fs.existsSync(path.join(candidate, "workflows"))
    ) {
      return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return path.resolve(process.cwd());
}

let defaultComputerHistoryDemoService: ComputerHistoryDemoService | null = null;

export function getComputerHistoryDemoService(): ComputerHistoryDemoService {
  defaultComputerHistoryDemoService ??= new ComputerHistoryDemoService();
  return defaultComputerHistoryDemoService;
}
