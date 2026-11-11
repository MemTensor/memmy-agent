import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { RecordingSessionSchema, RecordingEventSchema, RecordingFrameSchema, RecordingStartSchema,
  type OperationEvidence,
  type RecordingSession, type RecordingEvent, type RecordingStart, type RecordingExportResult,
  type RecordingConfiguration, type RecordingPermission } from "@memmy/local-api-contracts";
import { collectorGate, type CollectorGate } from "../computer-history/core/collector-gate.js";
import { buildRecordingOperationEvidence } from "../computer-use/operation-evidence.js";
import { writeJsonAtomic } from "../../utils/atomic-json.js";
export { writeJsonAtomic } from "../../utils/atomic-json.js";

export class RecordingError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export type RecordingResult = Pick<RecordingSession, "durationMs" | "video" | "parts" | "gaps" | "qpc" | "clock" | "idleSpans" | "videoIntegrity" | "timelineCompleteness" | "error"> & {
  endReason?: RecordingSession["taskEndReason"];
};
export interface TaskRecordingHandle {
  finished: Promise<RecordingResult>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<RecordingResult>;
  timeMs(): number;
  idleStatus?(): { paused: boolean; videoTimeMs: number } | undefined;
}
export interface TaskRecordingDriver {
  configuration?(): Promise<RecordingConfiguration>;
  openPermission?(permission: RecordingPermission, mode: "request" | "settings"): Promise<RecordingConfiguration>;
  start(input: { directory: string; applications: string[]; skipIdle?: boolean; target?: NativeTaskTarget;
    onEvent: (event: Omit<RecordingEvent, "id" | "sequence">) => void }): Promise<TaskRecordingHandle>;
  recover(directory: string): Promise<RecordingResult>;
  exportFlow(directory: string, session: RecordingSession, events: RecordingEvent[], destination: string): Promise<string[]>;
}
export type NativeTaskTarget = { pid: number; processStart: string; hwnd: string };
interface ActiveRecording {
  session: RecordingSession; release: () => void; handle: TaskRecordingHandle | null;
  fd: number; sequence: number; start: Promise<void>; operation: Promise<unknown>; settling: Promise<void> | null; persistFailed: boolean;
}
const terminal = (state: RecordingSession["state"]) => state === "ready" || state === "failed";
const recordingId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export function readLines<T>(file: string, parse: (value: unknown) => T, maxBytes = 64 * 1024 * 1024): T[] {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new RecordingError(422, "recording_index_invalid");
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => parse(JSON.parse(line)));
}

/** Task videos are independent of background history and never enter its model pipeline. */
export class RecordingSessionService {
  readonly directory: string;
  private readonly gate: CollectorGate;
  private active: ActiveRecording | null = null;
  private readonly failedManifests = new Map<string, RecordingSession>();
  private readonly attemptedAgentMessages = new Set<string>();
  private attemptsInvalid = false;
  private readonly initialized: Promise<void>;
  private closing = false;
  private readonly exports = new Map<string, { result: RecordingExportResult; promise: Promise<void> }>();
  private cleanupTimer: NodeJS.Timeout;
  constructor(private readonly options: { driver: TaskRecordingDriver; directory?: string; gate?: CollectorGate;
    supported?: boolean; platform?: RecordingSession["platform"]; historyBusy?: () => boolean; now?: () => number }) {
    this.directory = path.resolve(options.directory ?? path.join(os.homedir(), ".memmy", "computer-recordings"));
    this.gate = options.gate ?? collectorGate;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink()) throw new RecordingError(422, "recording_directory_invalid");
    this.initialized = this.recover();
    this.cleanupTimer = setInterval(() => { void this.cleanup().catch(() => {}); }, 60_000);
    this.cleanupTimer.unref();
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private folder(id: string): string {
    if (!recordingId.test(id)) throw new RecordingError(400, "recording_id_invalid");
    const folder = path.join(this.directory, id);
    if (fs.existsSync(folder) && (fs.lstatSync(folder).isSymbolicLink() || !fs.lstatSync(folder).isDirectory())) throw new RecordingError(422, "recording_directory_invalid");
    return folder;
  }
  private read(id: string): RecordingSession {
    if (this.active?.session.id === id) {
      const snapshot = structuredClone(this.active.session);
      if (this.active.handle && (snapshot.state === "recording" || snapshot.state === "paused")) snapshot.durationMs = Math.min(1_200_000, this.active.handle.timeMs());
      const idle = this.active.handle?.idleStatus?.();
      if (idle) { snapshot.idlePaused = idle.paused; snapshot.recordedDurationMs = idle.videoTimeMs; }
      return snapshot;
    }
    const failed = this.failedManifests.get(id); if (failed) return structuredClone(failed);
    try {
      const file = path.join(this.folder(id), "manifest.json");
      if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 4 * 1024 * 1024) throw new Error();
      const session = RecordingSessionSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
      if (session.id !== id) throw new Error();
      return session;
    } catch (error) { if (error instanceof RecordingError) throw error; throw new RecordingError(404, "recording_not_found"); }
  }
  private save(session: RecordingSession): void {
    writeJsonAtomic(path.join(this.folder(session.id), "manifest.json"), RecordingSessionSchema.parse(session));
    this.failedManifests.delete(session.id);
  }
  private async recover(): Promise<void> {
    const attempts = path.join(this.directory, "agent-attempts.jsonl");
    if (fs.existsSync(attempts)) {
      try {
        for (const hash of readLines(attempts, (value) => {
          if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new Error("attempt_invalid");
          return value;
        })) this.attemptedAgentMessages.add(hash);
      } catch { this.attemptsInvalid = true; }
    }
    for (const id of fs.readdirSync(this.directory).filter((name) => recordingId.test(name))) {
      let session: RecordingSession;
      try { session = this.read(id); } catch { continue; }
      if (terminal(session.state)) continue;
      const eventsFile = path.join(this.folder(id), "events.jsonl");
      try {
        if (fs.existsSync(eventsFile) && !fs.lstatSync(eventsFile).isSymbolicLink() && fs.statSync(eventsFile).isFile() && fs.statSync(eventsFile).size <= 64 * 1024 * 1024) {
          const bytes = fs.readFileSync(eventsFile);
          if (bytes.length && bytes.at(-1) !== 10) fs.truncateSync(eventsFile, bytes.lastIndexOf(10) + 1);
        }
      } catch { session.error = "recording_event_recovery_failed"; }
      try { Object.assign(session, await this.options.driver.recover(this.folder(id))); }
      catch { session.videoIntegrity = "missing"; session.video = null; session.error = "recording_recovery_failed"; }
      session.state = "failed";
      session.videoIntegrity = session.parts.length ? "partial" : "missing";
      session.timelineCompleteness = "partial";
      session.taskEndReason = "process_exit";
      session.stoppedAt = new Date(this.now()).toISOString();
      session.error ??= "recording_interrupted";
      try { this.save(session); } catch { this.failedManifests.set(session.id, structuredClone(session)); }
    }
    await this.cleanup(false);
  }
  async list(chatId?: string): Promise<RecordingSession[]> {
    await this.initialized;
    const sessions: RecordingSession[] = [];
    for (const id of fs.readdirSync(this.directory).filter((name) => recordingId.test(name))) {
      try { const session = this.read(id); if (!chatId || session.agent?.chatId === chatId) sessions.push(session); } catch { /* preserve unreadable packages */ }
    }
    return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async get(id: string): Promise<RecordingSession> { await this.initialized; return this.read(id); }
  private writeOperationEvidence(session: RecordingSession): OperationEvidence {
    const directory = this.folder(session.id), eventsFile = path.join(directory, "events.jsonl"), framesFile = path.join(directory, "frames.jsonl");
    const events = readLines(eventsFile, (value) => RecordingEventSchema.parse(value));
    const frames = fs.existsSync(framesFile) ? readLines(framesFile, (value) => RecordingFrameSchema.parse(value)) : [];
    const evidence = buildRecordingOperationEvidence({ session, events, frames, eventsText: fs.readFileSync(eventsFile, "utf8"),
      framesText: fs.existsSync(framesFile) ? fs.readFileSync(framesFile, "utf8") : "" });
    writeJsonAtomic(path.join(directory, "operation-evidence.json"), evidence);
    return evidence;
  }
  async evidence(id: string): Promise<OperationEvidence> {
    const session = await this.get(id);
    if (!terminal(session.state)) throw new RecordingError(409, "recording_busy");
    try { return this.writeOperationEvidence(session); }
    catch { throw new RecordingError(422, "recording_evidence_index_invalid"); }
  }
  async configuration(): Promise<RecordingConfiguration> {
    if (!this.options.driver.configuration) throw new RecordingError(400, "recording_configuration_unavailable");
    return this.options.driver.configuration();
  }
  async openPermission(permission: RecordingPermission, mode: "request" | "settings"): Promise<RecordingConfiguration> {
    if (!this.options.driver.openPermission) throw new RecordingError(400, "recording_permissions_unavailable");
    return this.options.driver.openPermission(permission, mode);
  }
  /** Durable one-message consent claim; a recovered Agent run never restarts recording. */
  async claimAgentMessage(chatId: string, messageId: string): Promise<boolean> {
    await this.initialized;
    if (this.attemptsInvalid) throw new RecordingError(422, "recording_attempt_index_invalid");
    const hash = crypto.createHash("sha256").update(`${chatId}\0${messageId}`).digest("hex");
    if (this.attemptedAgentMessages.has(hash)) return false;
    const file = path.join(this.directory, "agent-attempts.jsonl");
    if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size >= 64 * 1024 * 1024)) throw new RecordingError(422, "recording_attempt_index_invalid");
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(hash)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.attemptedAgentMessages.add(hash);
    return true;
  }
  async start(input: RecordingStart, agent: RecordingSession["agent"] = null, target?: NativeTaskTarget): Promise<RecordingSession> {
    await this.initialized;
    if (this.options.supported === false) throw new RecordingError(400, "task_recording_requires_supported_desktop");
    if (this.closing) throw new RecordingError(409, "recording_shutting_down");
    const parsed = RecordingStartSchema.safeParse(input);
    if (!parsed.success) throw new RecordingError(422, "recording_requires_applications_and_video_consent");
    if (this.active || this.options.historyBusy?.()) throw new RecordingError(409, "collector_busy: pause Computer History first");
    const release = this.gate.acquire("task");
    const session: RecordingSession = {
      schemaVersion: 1, id: crypto.randomUUID(), title: parsed.data.title, platform: this.options.platform ?? "windows", source: agent ? "agent" : "human",
      state: "starting", createdAt: new Date(this.now()).toISOString(), stoppedAt: null, durationMs: 0,
      applications: [...new Set(parsed.data.applications)], agent, pinned: false, videoIntegrity: "missing", timelineCompleteness: "complete",
      taskEndReason: null, error: null, qpc: null, video: null, parts: [], gaps: [],
      privacy: { rawVisibleFrames: true, audio: false, localOnly: true, retentionHours: 48 },
    };
    let fd: number;
    try {
      fs.mkdirSync(this.folder(session.id), { mode: 0o700 }); this.save(session);
      fd = fs.openSync(path.join(this.folder(session.id), "events.jsonl"), "wx", 0o600);
    } catch (error) { release(); throw error; }
    const active: ActiveRecording = { session, release, fd, sequence: 0, handle: null, start: Promise.resolve(), operation: Promise.resolve(), settling: null, persistFailed: false };
    this.active = active;
    active.start = (async () => {
      try {
        active.handle = await this.options.driver.start({ directory: this.folder(session.id), applications: session.applications, skipIdle: parsed.data.skipIdle, ...(target ? { target } : {}),
          onEvent: (event) => this.append(active, event) });
        session.state = "recording"; this.save(session);
        void active.handle.finished.then((result) => this.settle(active, result), (error) => this.settleFailure(active, error)).catch(() => {});
      } catch (error) {
        if (active.handle) await active.handle.stop().catch(() => {});
        await this.settleFailure(active, error); throw error;
      }
    })();
    await active.start;
    return this.read(session.id);
  }
  private append(active: ActiveRecording, event: Omit<RecordingEvent, "id" | "sequence">): void {
    if (active.fd < 0) return;
    const sequence = active.sequence + 1;
    const record = RecordingEventSchema.parse({ ...event, id: `${active.session.id}:${sequence}`, sequence });
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.writeSync(active.fd, bytes, offset);
      if (!count) throw new Error("recording_event_write_failed");
      offset += count;
    }
    active.sequence = sequence;
  }
  private settle(active: ActiveRecording, result: RecordingResult): Promise<void> {
    if (active.settling) return active.settling;
    active.settling = Promise.resolve().then(() => {
      try {
        const { endReason: _endReason, ...fields } = result; void _endReason;
        Object.assign(active.session, fields);
        active.session.state = result.error || result.videoIntegrity !== "complete" ? "failed" : "ready";
        active.session.taskEndReason ??= result.endReason ?? "user_stopped";
        active.session.stoppedAt = new Date(this.now()).toISOString();
        if (active.persistFailed) { active.session.state = "failed"; active.session.error = "recording_metadata_write_failed"; }
        if (active.fd >= 0) { fs.fsyncSync(active.fd); fs.closeSync(active.fd); active.fd = -1; }
        this.save(active.session);
        // Extraction is retryable via /evidence and must not change a sealed
        // video's lifecycle result when indexes are unavailable or damaged.
        try { this.writeOperationEvidence(active.session); } catch { /* retain original capture evidence */ }
      } catch {
        active.session.state = "failed"; active.session.error = "recording_metadata_write_failed"; active.session.timelineCompleteness = "partial";
        this.failedManifests.set(active.session.id, structuredClone(active.session));
      } finally {
        if (active.fd >= 0) { try { fs.closeSync(active.fd); } catch { /* release the collector even after disk failure */ } active.fd = -1; }
        if (this.active === active) this.active = null;
        active.release();
      }
    });
    void active.settling.catch(() => {});
    return active.settling;
  }
  private async settleFailure(active: ActiveRecording, _error: unknown): Promise<void> {
    void _error;
    let result: RecordingResult = { durationMs: active.handle?.timeMs() ?? 0, video: null, parts: [], gaps: [], qpc: null,
      videoIntegrity: "missing", timelineCompleteness: "partial", error: "recording_capture_failed" };
    try { result = { ...await this.options.driver.recover(this.folder(active.session.id)), timelineCompleteness: "partial", error: "recording_capture_failed" }; } catch { /* keep original failure */ }
    active.session.taskEndReason ??= "capture_failed";
    await this.settle(active, result);
  }
  async control(id: string, action: "pause" | "resume" | "stop", reason: RecordingSession["taskEndReason"] = "user_stopped"): Promise<RecordingSession> {
    await this.initialized;
    const active = this.active;
    if (!active || active.session.id !== id) {
      const session = this.read(id);
      if (action === "stop" && terminal(session.state)) return session;
      throw new RecordingError(409, "recording_is_not_active");
    }
    const operation = active.operation.catch(() => {}).then(async () => {
      await active.start;
      if (terminal(active.session.state)) { if (action === "stop") return; throw new RecordingError(409, "recording_is_not_active"); }
      if (action === "stop") {
        active.session.state = "finalizing"; active.session.taskEndReason = reason;
        active.session.durationMs = Math.min(1_200_000, active.handle!.timeMs());
        try { this.save(active.session); } catch { active.persistFailed = true; }
        await this.settle(active, await active.handle!.stop());
      } else {
        const expected = action === "pause" ? "recording" : "paused";
        if (active.session.state !== expected) throw new RecordingError(409, "recording_state_conflict");
        await active.handle![action]();
        if (!terminal(active.session.state)) { active.session.state = action === "pause" ? "paused" : "recording"; this.save(active.session); }
      }
    });
    active.operation = operation;
    await operation;
    return this.read(id);
  }
  markOcu(chatId: string, tool: string, status: "started" | "finished" | "failed" | "unknown", runId?: string | null): void {
    const active = this.active;
    if (!active?.handle || !active.session.agent || (runId ? active.session.agent.runId !== runId : active.session.agent.chatId !== chatId) || active.session.state !== "recording") return;
    try { this.append(active, { timeMs: active.handle.timeMs(), timestamp: new Date(this.now()).toISOString(),
      origin: "ocu", type: "tool_call", window: null, action: { tool: tool.slice(0, 100), status } }); }
    catch { void this.control(active.session.id, "stop", "capture_failed").catch(() => {}); }
  }
  async finishAgent(chatId: string, reason: "completed" | "cancelled"): Promise<void> {
    const active = this.active;
    if (active?.session.agent?.chatId === chatId) await this.control(active.session.id, "stop", reason);
  }
  async events(id: string, after = 0, limit = 500): Promise<{ events: RecordingEvent[]; nextCursor: number | null }> {
    await this.get(id);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RecordingError(400, "recording_cursor_invalid");
    const records = readLines(path.join(this.folder(id), "events.jsonl"), (v) => RecordingEventSchema.parse(v));
    // Provider snapshots feed extraction; they are not user inputs and must
    // not crowd the player's action timeline or consume its page size.
    const remaining = records.filter((event) => event.sequence > after && !event.observation);
    const events = remaining.slice(0, limit);
    return { events, nextCursor: remaining.length > limit ? events.at(-1)!.sequence : null };
  }
  async pin(id: string, pinned: boolean): Promise<RecordingSession> {
    const session = await this.get(id); session.pinned = pinned;
    if (this.active?.session.id === id) this.active.session.pinned = pinned;
    this.save(session); return session;
  }
  async delete(id: string): Promise<void> {
    const session = await this.get(id);
    if (!terminal(session.state) || [...this.exports.values()].some((job) => job.result.recordingId === id && job.result.state === "processing")) throw new RecordingError(409, "recording_busy");
    fs.rmSync(this.folder(id), { recursive: true });
    this.failedManifests.delete(id);
    for (const [key, job] of this.exports) if (job.result.recordingId === id) this.exports.delete(key);
  }
  private async cleanup(wait = true): Promise<void> {
    if (wait) await this.initialized;
    for (const id of fs.readdirSync(this.directory).filter((name) => recordingId.test(name))) {
      try {
        const session = this.read(id);
        if (!session.pinned && terminal(session.state) && this.now() - Date.parse(session.createdAt) >= 48 * 3600_000
          && ![...this.exports.values()].some((job) => job.result.recordingId === id && job.result.state === "processing")) {
          fs.rmSync(this.folder(id), { recursive: true }); this.failedManifests.delete(id);
        }
      } catch { /* retain unknown files */ }
    }
  }
  async clear(scope: "today" | "all"): Promise<void> {
    const today = new Date(this.now()); today.setHours(0, 0, 0, 0);
    const selected = (await this.list()).filter((session) => scope === "all" || Date.parse(session.createdAt) >= today.getTime());
    if (selected.some((session) => !terminal(session.state) || [...this.exports.values()].some((job) => job.result.recordingId === session.id && job.result.state === "processing"))) throw new RecordingError(409, "recording_busy");
    for (const session of selected) await this.delete(session.id);
  }
  async exportOpenAdapt(id: string): Promise<RecordingExportResult> {
    const session = await this.get(id);
    if (!terminal(session.state)) throw new RecordingError(409, "recording_busy");
    const result: RecordingExportResult = { id: crypto.randomUUID(), recordingId: id, state: "processing", format: "openadapt-flow-1.35.1",
      executionAdmission: "not_admitted", replayable: false, missing: [], error: null };
    const exportsDirectory = path.join(this.folder(id), "exports");
    fs.mkdirSync(exportsDirectory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(exportsDirectory).isSymbolicLink() || !fs.lstatSync(exportsDirectory).isDirectory()) throw new RecordingError(422, "recording_export_directory_invalid");
    const destination = path.join(exportsDirectory, result.id);
    fs.mkdirSync(destination, { mode: 0o700 });
    const promise = Promise.resolve().then(async () => {
      try {
        const records = readLines(path.join(this.folder(id), "events.jsonl"), (v) => RecordingEventSchema.parse(v));
        result.missing = await this.options.driver.exportFlow(this.folder(id), session, records, destination);
        result.state = "ready";
      } catch { result.state = "failed"; result.error = "recording_export_failed"; }
      writeJsonAtomic(path.join(destination, "result.json"), result);
    });
    this.exports.set(result.id, { result, promise });
    void promise.catch(() => {});
    return structuredClone(result);
  }
  async getExport(id: string, exportId: string): Promise<RecordingExportResult> {
    await this.get(id);
    const job = this.exports.get(exportId);
    if (job?.result.recordingId === id) return structuredClone(job.result);
    if (!recordingId.test(exportId)) throw new RecordingError(400, "recording_export_id_invalid");
    try {
      const { RecordingExportResultSchema } = await import("@memmy/local-api-contracts");
      const result = RecordingExportResultSchema.parse(JSON.parse(fs.readFileSync(path.join(this.folder(id), "exports", exportId, "result.json"), "utf8")));
      if (result.recordingId !== id || result.id !== exportId) throw new Error();
      return result;
    } catch { throw new RecordingError(404, "recording_export_not_found"); }
  }
  async openMedia(id: string, mediaId = "recording"): Promise<{ fd: number; size: number; type: string }> {
    const session = await this.get(id);
    let relative: string;
    let type = "video/mp4";
    if (mediaId === "recording" && session.video) relative = "recording.mp4";
    else if (session.parts.some((part) => part.mediaId === mediaId)) relative = path.join("parts", `${mediaId.slice(5)}.mp4`);
    else if (mediaId.startsWith("export-")) {
      const result = await this.getExport(id, mediaId.slice(7));
      if (result.state !== "ready") throw new RecordingError(409, "recording_export_not_ready");
      relative = path.join("exports", result.id, "openadapt-flow.zip"); type = "application/zip";
    } else throw new RecordingError(404, "recording_media_not_found");
    const folder = fs.realpathSync(this.folder(id));
    const file = path.join(folder, relative);
    let fd: number | undefined;
    try {
      const canonical = fs.realpathSync(file);
      if (canonical !== file || !canonical.startsWith(`${folder}${path.sep}`) || fs.lstatSync(file).isSymbolicLink()) throw new Error();
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size < 1) throw new Error();
      return { fd, size: stat.size, type };
    } catch { if (fd !== undefined) fs.closeSync(fd); throw new RecordingError(404, "recording_media_not_found"); }
  }
  async shutdown(): Promise<void> {
    this.closing = true; clearInterval(this.cleanupTimer);
    await this.initialized;
    if (this.active) await this.control(this.active.session.id, "stop", "app_exit").catch(() => {});
    await Promise.allSettled([...this.exports.values()].map((job) => job.promise));
  }
}
