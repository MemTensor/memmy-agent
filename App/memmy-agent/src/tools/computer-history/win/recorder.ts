import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { DEFAULT_OBSERVATION_SETTINGS, evaluateObservation, parseObservationSettings } from "../core/observation-settings.js";
import { windowsApplicationAlias } from "../core/application-identity.js";
import { WeChatHistoryConsentStore } from "../mac/wechat-consent.js";
import path from "node:path";
import { resolveNativeCollector } from "./native-helper.js";
import { RecordingWriter, type HistoryEvent } from "../core/recording.js";
import { readNativePolicy, replaceNativePolicy, type NativePolicy } from "./policy.js";
import { NativeStreamReader, type NativeEvent } from "./protocol.js";
import { SnapshotNormalizer } from "./normalize.js";

export type RecorderState = "starting" | "running" | "pausing" | "paused" | "resuming" | "stopping" | "stopped" | "failed";
export interface WindowsRecorderOptions {
  binary?: string;
  policyFile: string;
  eventsFile: string;
  observationSettingsFile?: string;
  weChatConsentFile?: string;
  title: string;
  seconds?: number;
  sampleMs?: number;
  commandTimeoutMs?: number;
  onEvent?: (event: HistoryEvent) => void;
  appendToRecording?: boolean;
  inputHooks?: boolean;
}
interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
const successfulStops = new Set(["stop_command", "stdin_eof", "duration_elapsed", "console_control", "stop_hotkey"]);

// The adapter continuously drains both pipes and never asks the native process to write raw UI data.
export class WindowsHistoryRecorder {
  private stateValue: RecorderState = "starting";
  private readonly reader = new NativeStreamReader();
  private readonly normalizer = new SnapshotNormalizer();
  private readonly writer: RecordingWriter;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly ready = deferred<void>();
  private readonly done = deferred<void>();
  private readonly timeout: number;
  private started = false;
  private terminal = false;
  private stopReason: string | null = null;
  private closed = false;
  private failure: Error | null = null;
  private pending: { kind: "session.paused" | "session.resumed"; ack: Deferred<void>; timer: NodeJS.Timeout } | null = null;
  private readonly startupTimer: NodeJS.Timeout;
  private killTimer: NodeJS.Timeout | null = null;
  private closeTimer: NodeJS.Timeout | null = null;
  private diagnosticBytes = 0;
  private policyUpdate = false;
  readonly finished: Promise<void>;

  static async start(options: WindowsRecorderOptions): Promise<WindowsHistoryRecorder> {
    const recorder = new WindowsHistoryRecorder(options);
    try { await recorder.ready.promise; }
    catch (error) { await recorder.finished.catch(() => {}); throw error; }
    return recorder;
  }
  private constructor(private readonly options: WindowsRecorderOptions) {
    const binary = resolveNativeCollector(import.meta.url, options.binary);
    if (!path.isAbsolute(options.policyFile) || !path.isAbsolute(options.eventsFile)
        || path.resolve(options.policyFile).toLowerCase() === path.resolve(options.eventsFile).toLowerCase()) throw new Error("windows_recording_path_invalid");
    const seconds = options.seconds ?? 30;
    const sample = options.sampleMs ?? 1000;
    this.timeout = options.commandTimeoutMs ?? 5000;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400 || !Number.isInteger(sample) || sample < 200 || sample > 60000
        || !Number.isInteger(this.timeout) || this.timeout < 100 || this.timeout > 30000) throw new Error("windows_recorder_options_invalid");
    readNativePolicy(options.policyFile);
    this.writer = new RecordingWriter(options.eventsFile, { recordingId: crypto.randomUUID(), title: options.title, platform: "windows" }, options.appendToRecording);
    try {
      this.child = spawn(binary, ["observe", "--policy", options.policyFile, "--seconds", String(seconds),
        "--sample-ms", String(sample), "--parent-pid", String(process.pid), ...(options.inputHooks ? ["--input-hooks"] : [])], { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    } catch { this.writer.close(); throw new Error("windows_collector_launch_failed"); }
    this.finished = this.done.promise;
    this.startupTimer = setTimeout(() => this.fail("windows_collector_start_timeout"), this.timeout);
    this.child.on("error", () => this.fail("windows_collector_launch_failed"));
    this.child.stdin.on("error", () => { if (!this.terminal && !this.closed) this.fail("windows_control_write_failed"); });
    this.child.stdout.on("error", () => this.fail("windows_collector_output_failed"));
    this.child.stderr.on("error", () => this.fail("windows_collector_output_failed"));
    this.child.stdout.on("data", (chunk: Buffer) => {
      try { for (const event of this.reader.feed(chunk)) this.receive(event); }
      catch (error) { this.fail(this.safeCode(error, "windows_protocol_invalid")); }
    });
    // Drain diagnostics without logging or persisting provider-controlled text.
    this.child.stderr.on("data", (chunk: Buffer) => { this.diagnosticBytes = Math.min(32768, this.diagnosticBytes + chunk.length); });
    this.child.on("close", (code) => this.finish(code));
  }
  get state(): RecorderState { return this.stateValue; }
  get pid(): number | undefined { return this.child.pid; }
  private safeCode(error: unknown, fallback: string): string {
    return error instanceof Error && /^windows_[a-z_]+$/u.test(error.message) ? error.message : fallback;
  }
  private persist(event: HistoryEvent): void {
    try { this.writer.append(event); }
    catch { throw new Error("windows_recording_write_failed"); }
  }
  private observationAllowed(record: HistoryEvent): boolean {
    if (!record.application?.executable) return true;
    const file = this.options.observationSettingsFile;
    // Missing policy preserves the established default; a corrupt live policy stops capture.
    const settings = file && fs.existsSync(file) ? parseObservationSettings(JSON.parse(fs.readFileSync(file, "utf8")))
      : DEFAULT_OBSERVATION_SETTINGS;
    const bundleId = windowsApplicationAlias(record.application.executable);
    return evaluateObservation(settings, { bundleId, executable: record.application.executable,
      browser: record.details?.browser === true,
      url: typeof record.details?.url === "string" ? record.details.url : null,
      privateBrowsingUnknown: record.details?.browser === true && record.details?.browserMode !== "normal",
      weChatChatAccess: new WeChatHistoryConsentStore(this.options.weChatConsentFile).read().enabled,
    }, { ignorePrivateBrowsing: true, observeUnknownURL: true }).observe;
  }
  private receive(event: NativeEvent): void {
    if (this.failure) return;
    if (this.terminal) throw new Error("windows_protocol_after_stop");
    if (!this.started) {
      if (event.kind !== "session.started" || event.collector.testHooks || event.collector.pid !== this.child.pid
          || event.options.parentPid !== process.pid || event.segment !== null
          || event.options.inputHooks !== (this.options.inputHooks ?? false) || event.options.seconds !== (this.options.seconds ?? 30)
          || event.options.sampleMs !== (this.options.sampleMs ?? 1000)
          || event.policyRevision !== readNativePolicy(this.options.policyFile).revision) throw new Error("windows_protocol_start_invalid");
      this.started = true;
      clearTimeout(this.startupTimer);
      this.stateValue = "running";
      this.persist({ eventType: "recording_started", timestamp: event.timestamp, details: { source: "windows_uia", nativeSessionId: event.sessionId } });
      this.ready.resolve();
      return;
    }
    switch (event.kind) {
      case "session.started": throw new Error("windows_protocol_duplicate_start");
      case "snapshot": {
        if (!this.options.inputHooks && event.snapshot.status === "ok" && event.snapshot.actions?.length) throw new Error("windows_protocol_unrequested_actions");
        if (this.stateValue === "paused") throw new Error("windows_protocol_capture_while_paused");
        if (this.stateValue !== "running") { this.normalizer.reset(); return; }
        const { policy, revision } = readNativePolicy(this.options.policyFile);
        const normalized = this.normalizer.normalizeEvents(event, policy, revision);
        for (const record of normalized) {
          // Keep the in-memory native baseline while discarding excluded content.
          // The next frame may be a delta, even while this site remains excluded.
          if (!this.observationAllowed(record)) return;
          if (this.stateValue !== "running") { this.normalizer.reset(); break; }
          if (readNativePolicy(this.options.policyFile).revision !== revision) { this.normalizer.reset(); return; }
          this.persist(record);
          this.options.onEvent?.(record);
        }
        return;
      }
      case "session.paused":
      case "session.resumed": {
        if (this.stateValue === "stopping") return;
        if (!this.pending || this.pending.kind !== event.kind
            || (event.kind === "session.paused" ? event.alreadyPaused : event.alreadyRunning)) throw new Error("windows_control_ack_invalid");
        this.stateValue = event.kind === "session.paused" ? "paused" : "running";
        this.normalizer.reset();
        const pending = this.pending;
        this.persist({ eventType: event.kind === "session.paused" ? "recording_paused" : "recording_resumed", timestamp: event.timestamp });
        this.pending = null;
        clearTimeout(pending.timer);
        pending.ack.resolve();
        return;
      }
      case "segment.started": throw new Error("windows_protocol_raw_segment_unexpected");
      case "error":
        this.normalizer.reset();
        if (event.fatal) throw new Error("windows_collector_fatal");
        return;
      case "session.stopped":
        if (!event.hooksDetached || !successfulStops.has(event.reason)) throw new Error("windows_collector_shutdown_failed");
        this.terminal = true;
        this.stopReason = event.reason;
        this.stateValue = "stopping";
        this.normalizer.reset();
        this.rejectPending(new Error("windows_collector_stopped"));
        // Completion is written only after the process closes successfully with all pipes drained.
        if (this.closeTimer) clearTimeout(this.closeTimer);
        this.closeTimer = setTimeout(() => this.fail("windows_collector_exit_timeout"), this.timeout);
    }
  }
  private rejectPending(error: Error): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.ack.reject(error);
    this.pending = null;
  }
  private fail(code: string): void {
    if (this.failure || this.closed) return;
    this.failure = new Error(code);
    this.stateValue = "failed";
    this.normalizer.reset();
    clearTimeout(this.startupTimer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.rejectPending(this.failure);
    this.ready.reject(this.failure);
    // Give the owned collector a bounded chance to detach; kill closes its worker Job.
    if (this.child.stdin.writable) this.child.stdin.end("stop\n");
    this.killTimer = setTimeout(() => { this.child.kill(); }, Math.min(this.timeout, 1500));
  }
  private finish(code: number | null): void {
    this.closed = true;
    clearTimeout(this.startupTimer);
    if (this.killTimer) clearTimeout(this.killTimer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    try {
      this.reader.end();
      if (!this.failure && (!this.terminal || code !== 0)) {
        this.failure = new Error(!this.started && code === 4 ? "windows_collector_already_running" : "windows_collector_incomplete");
      }
      if (!this.failure) this.writer.complete({ eventType: "recording_stopped", timestamp: new Date().toISOString(), details: { reason: this.stopReason } });
    } catch (error) { this.failure ??= new Error(this.safeCode(error, "windows_recording_write_failed")); }
    try { this.writer.close(); } catch { this.failure ??= new Error("windows_recording_flush_failed"); }
    this.rejectPending(this.failure ?? new Error("windows_collector_stopped"));
    if (this.failure) { this.stateValue = "failed"; this.ready.reject(this.failure); this.done.reject(this.failure); }
    else { this.stateValue = "stopped"; this.done.resolve(); }
  }
  private command(kind: "session.paused" | "session.resumed"): Promise<void> {
    const ack = deferred<void>();
    this.pending = { kind, ack, timer: setTimeout(() => this.fail("windows_control_ack_timeout"), this.timeout) };
    this.child.stdin.write(kind === "session.paused" ? "pause\n" : "resume\n");
    return ack.promise;
  }
  pause(): Promise<void> {
    if (this.policyUpdate) return Promise.reject(new Error("windows_policy_update_in_progress"));
    return this.pauseInternal();
  }
  private pauseInternal(): Promise<void> {
    if (this.stateValue === "paused") return Promise.resolve();
    if (this.stateValue !== "running" || this.pending) return Promise.reject(new Error("windows_recorder_state_invalid"));
    this.stateValue = "pausing";
    this.normalizer.reset();
    return this.command("session.paused");
  }
  resume(): Promise<void> {
    if (this.policyUpdate) return Promise.reject(new Error("windows_policy_update_in_progress"));
    return this.resumeInternal();
  }
  private resumeInternal(): Promise<void> {
    if (this.stateValue === "running") return Promise.resolve();
    if (this.stateValue !== "paused" || this.pending) return Promise.reject(new Error("windows_recorder_state_invalid"));
    this.stateValue = "resuming";
    return this.command("session.resumed");
  }
  stop(): Promise<void> { return this.shutdown(false); }
  endInput(): Promise<void> { return this.shutdown(true); }
  private shutdown(eof: boolean): Promise<void> {
    if (this.closed || this.failure) return this.finished;
    if (this.stateValue === "stopping") return this.finished;
    this.stateValue = "stopping";
    this.normalizer.reset();
    this.rejectPending(new Error("windows_collector_stopping"));
    this.child.stdin.end(eof ? undefined : "stop\n");
    this.closeTimer = setTimeout(() => this.fail("windows_control_stop_timeout"), this.timeout);
    return this.finished;
  }
  async updatePolicy(policy: NativePolicy): Promise<void> {
    if (this.policyUpdate || (this.stateValue !== "running" && this.stateValue !== "paused")) throw new Error("windows_recorder_state_invalid");
    this.policyUpdate = true;
    const resume = this.stateValue === "running";
    try {
      await this.pauseInternal();
      if (this.stateValue !== "paused") throw new Error("windows_recorder_state_invalid");
      replaceNativePolicy(this.options.policyFile, policy);
      this.normalizer.reset();
      if (resume) await this.resumeInternal();
    } finally { this.policyUpdate = false; }
  }
}
