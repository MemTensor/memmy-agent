import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { RecordingFrameSchema, RecordingGapSchema, WindowsRecordingWindowSchema, type RecordingEvent, type RecordingSession } from "@memmy/local-api-contracts";
import { WindowsSettingsStore, discoverApplications, resolveWindowsCollector } from "../computer-history/win/settings.js";
import { authorizedRule, compileWindowsPolicy, pathKey, readNativePolicy } from "../computer-history/win/policy.js";
import { parseNativeEvent } from "../computer-history/win/protocol.js";
import { SnapshotNormalizer } from "../computer-history/win/normalize.js";
import { RecordingError, readLines, type RecordingResult, type TaskRecordingDriver, type TaskRecordingHandle } from "./session-service.js";
import { exportOpenAdaptFlow } from "./openadapt-export.js";

const decimal = z.string().regex(/^[0-9]+$/u).max(20);
const taskEnvelope = z.object({ qpcOrigin: decimal, qpcFrequency: decimal.refine((v) => BigInt(v) > 0n), qpc: decimal,
  actionQpc: z.array(decimal).max(64), unsupportedActions: z.number().int().nonnegative() }).strict();
const mediaSchema = z.object({ version: z.literal(1), durationMs: z.number().finite().nonnegative().max(1_200_200), qpcOrigin: decimal, qpcFrequency: decimal.refine((v) => BigInt(v) > 0n),
  width: z.literal(1920), height: z.literal(1080), complete: z.boolean(), error: z.string().nullable(), gaps: z.array(RecordingGapSchema),
  parts: z.array(z.object({ index: z.number().int().min(1).max(999999), startMs: z.number().nonnegative(), durationMs: z.number().nonnegative(),
    bytes: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/u) }).strict()),
}).strict();
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
export function nativeTaskEvent(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("task_protocol_invalid");
  const { task, protocol, version, ...rest } = value as Record<string, unknown>;
  if (protocol !== "memmy.windows.task-recording" || version !== 1) throw new Error("task_protocol_invalid");
  const clock = taskEnvelope.parse(task);
  const event = parseNativeEvent({ ...rest, protocol: "memmy.windows.computer-history", version: 1 });
  const actualMs = Number(BigInt(clock.qpc) - BigInt(clock.qpcOrigin)) * 1000 / Number(clock.qpcFrequency);
  if (Math.abs(actualMs - event.monotonicMs) > 2 || actualMs < 0) throw new Error("task_clock_invalid");
  const count = event.kind === "snapshot" && event.snapshot.status === "ok" ? (event.snapshot.actions?.length ?? 0) : 0;
  if (clock.actionQpc.length !== count || clock.actionQpc.some((qpc) => BigInt(qpc) < BigInt(clock.qpcOrigin) || BigInt(qpc) > BigInt(clock.qpc))) throw new Error("task_action_clock_invalid");
  return { event, clock };
}
export class WindowsTaskRecordingDriver implements TaskRecordingDriver {
  constructor(private readonly binary?: string, private readonly store = new WindowsSettingsStore()) {}
  private run(args: string[], timeout = 120_000): Promise<void> {
    return new Promise((resolve, reject) => execFile(resolveWindowsCollector(this.binary), args,
      { windowsHide: true, timeout, maxBuffer: 64 * 1024 }, (error) => error ? reject(new Error("task_media_processing_failed")) : resolve()));
  }
  async start(input: Parameters<TaskRecordingDriver["start"]>[0]): Promise<TaskRecordingHandle> {
    const binary = resolveWindowsCollector(this.binary);
    const settings = this.store.read();
    const choices = input.applications.map(pathKey);
    if (choices.some((choice) => ["mstsc.exe", "msrdc.exe", "wfica32.exe", "cdviewer.exe"].includes(path.win32.basename(choice)))) throw new RecordingError(422, "recording_application_unsupported");
    if (new Set(choices).size !== choices.length || choices.some((choice) => settings.deny?.executables?.some((exe) => pathKey(exe) === choice)
      || (settings.defaultApplicationBehavior !== "observe" && !settings.applications.some((rule) => pathKey(rule.executable) === choice)))) throw new RecordingError(422, "recording_application_not_authorized");
    const policy = compileWindowsPolicy(input.applications.map((executable) => settings.applications.find((r) => pathKey(r.executable) === pathKey(executable)) ?? { executable }),
      await discoverApplications(binary), { sensitiveAutomationIds: settings.sensitiveAutomationIds, deny: settings.deny, limits: settings.limits });
    if (!policy.applications.length || choices.some((choice) => !policy.applications.some((app) => pathKey(app.executable) === choice))) throw new RecordingError(422, "recording_application_unavailable");
    const policyFile = path.join(input.directory, "policy.json");
    fs.writeFileSync(policyFile, JSON.stringify(policy), { flag: "wx", mode: 0o600 });
    const child = spawn(binary, ["record-task", "--policy", policyFile, "--output-dir", input.directory, "--seconds", "1200",
      "--sample-ms", "200", "--parent-pid", String(process.pid), "--input-hooks"], { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const handle = new NativeTaskHandle(child, input.onEvent, policyFile, () => this.finishFiles(input.directory));
    try { await handle.ready; return handle; }
    catch (error) { await handle.finished; throw error; }
  }
  private async finishFiles(directory: string): Promise<RecordingResult> {
    try { await this.run(["finalize-task", "--output-dir", directory]); }
    catch { if (!fs.existsSync(path.join(directory, "native-media.json"))) throw new Error("task_media_processing_failed"); }
    const file = path.join(directory, "native-media.json");
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 4 * 1024 * 1024) throw new Error("task_media_invalid");
    const media = mediaSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    const parts: RecordingResult["parts"] = [];
    for (const part of media.parts) {
      const name = `${String(part.index).padStart(6, "0")}.mp4`;
      const partFile = path.join(directory, "parts", name);
      if (fs.lstatSync(partFile).isSymbolicLink() || !fs.statSync(partFile).isFile()) throw new Error("task_media_invalid");
      const sha256 = crypto.createHash("sha256");
      for await (const chunk of fs.createReadStream(partFile)) sha256.update(chunk);
      const digest = sha256.digest("hex");
      if (digest !== part.sha256 || fs.statSync(partFile).size !== part.bytes) throw new Error("task_part_integrity_invalid");
      parts.push({ mediaId: `part-${String(part.index).padStart(6, "0")}`, startMs: part.startMs, durationMs: part.durationMs,
        bytes: fs.statSync(partFile).size, sha256: digest });
    }
    const frames = readLines(path.join(directory, "frames.jsonl"), (value) => RecordingFrameSchema.parse(value));
    const policy = readNativePolicy(path.join(directory, "policy.json")).policy;
    const counts = new Map<string, number>();
    for (const frame of frames) {
      const part = parts.find((item) => item.mediaId === frame.partId);
      if (!frame.qpc || (frame.window && !("hwnd" in frame.window))) throw new Error("task_frame_platform_invalid");
      if ((frame.repeated && !frame.sourceTicks) || (frame.sourceTicks && (!frame.window || BigInt(frame.sourceTicks) < BigInt(media.qpcOrigin)
        || BigInt(frame.sourceTicks) > BigInt(frame.qpc) || (!frame.repeated && frame.sourceTicks !== frame.qpc)))) throw new Error("task_frame_source_clock_invalid");
      const expectedMs = Number(BigInt(frame.qpc) - BigInt(media.qpcOrigin)) * 1000 / Number(media.qpcFrequency);
      if (!part || Math.abs(expectedMs - frame.timeMs) > 2 || frame.timeMs < part.startMs - 2 || frame.timeMs > part.startMs + part.durationMs + 2
        || frame.partFrame !== (counts.get(frame.partId) ?? 0)) throw new Error("task_frame_clock_invalid");
      counts.set(frame.partId, frame.partFrame + 1);
      if (frame.window && !authorizedRule(policy, frame.window)) throw new Error("task_frame_window_invalid");
      if (frame.transform && (frame.transform.offsetX < 0 || frame.transform.offsetY < 0 || frame.transform.scale > 1
        || frame.transform.offsetX + frame.transform.sourceWidth * frame.transform.scale > 1921
        || frame.transform.offsetY + frame.transform.sourceHeight * frame.transform.scale > 1081)) throw new Error("task_frame_transform_invalid");
    }
    if (frames.some((frame, index) => frame.index !== index || (index > 0 && frame.timeMs <= frames[index - 1]!.timeMs)
      || !parts.some((part) => part.mediaId === frame.partId) || (frame.blank ? frame.window !== null || frame.transform !== null : !frame.window || !frame.transform))) throw new Error("task_frame_index_invalid");
    const playable = fs.existsSync(path.join(directory, "recording.mp4")) && fs.statSync(path.join(directory, "recording.mp4")).size > 0;
    return { durationMs: media.durationMs, qpc: { origin: media.qpcOrigin, frequency: media.qpcFrequency },
      video: playable ? { mediaId: "recording", width: 1920, height: 1080, fps: 15, audio: false } : null,
      parts, gaps: media.gaps, videoIntegrity: media.complete && playable ? "complete" : parts.length ? "partial" : "missing",
      timelineCompleteness: media.complete ? "complete" : "partial", error: media.error };
  }
  recover(directory: string): Promise<RecordingResult> { return this.finishFiles(directory); }
  async exportFlow(directory: string, session: RecordingSession, events: RecordingEvent[], destination: string): Promise<string[]> {
    return exportOpenAdaptFlow({ directory, session, events, destination,
      extract: () => this.run(["export-task-frames", "--output-dir", directory, "--export-dir", destination]) });
  }
}
class NativeTaskHandle implements TaskRecordingHandle {
  private readonly startup = deferred<void>();
  private readonly done = deferred<RecordingResult>();
  readonly ready = this.startup.promise;
  readonly finished = this.done.promise;
  private timer: NodeJS.Timeout;
  private killTimer: NodeJS.Timeout | null = null;
  private pending: { kind: string; ack: ReturnType<typeof deferred<void>>; timer: NodeJS.Timeout } | null = null;
  private state = "starting";
  private buffer = Buffer.alloc(0);
  private sessionId: string | null = null;
  private sequence = 0;
  private lastMs = 0;
  private anchor = performance.now();
  private clock: string | null = null;
  private failure = false;
  private overflow = false;
  private unsupported = 0;
  private stoppedReason: string | null = null;
  private readonly normalizer = new SnapshotNormalizer();
  constructor(private readonly child: ChildProcessWithoutNullStreams,
    private readonly onEvent: Parameters<TaskRecordingDriver["start"]>[0]["onEvent"], private readonly policyFile: string,
    private readonly finalize: () => Promise<RecordingResult>) {
    this.timer = setTimeout(() => this.fail(), 12_000);
    child.on("error", () => this.fail()); child.stdin.on("error", () => { if (!this.stoppedReason) this.fail(); });
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        let newline: number;
        while ((newline = this.buffer.indexOf(10)) >= 0) {
          if (newline > 8 * 1024 * 1024) throw new Error();
          const line = new TextDecoder("utf8", { fatal: true }).decode(this.buffer.subarray(0, newline));
          this.buffer = this.buffer.subarray(newline + 1);
          this.receive(JSON.parse(line));
        }
        if (this.buffer.length > 8 * 1024 * 1024) throw new Error();
      } catch { this.fail(); }
    });
    child.stderr.on("data", () => {});
    child.stdout.on("error", () => this.fail()); child.stderr.on("error", () => this.fail());
    child.once("close", (code) => { void this.closed(code); });
  }
  timeMs(): number { return this.lastMs + Math.max(0, performance.now() - this.anchor); }
  private fail(): void {
    this.failure = true; this.startup.reject(new Error("task_recording_start_or_protocol_failed"));
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.ack.reject(new Error("task_recording_control_failed")); this.pending = null; }
    if (this.child.stdin.writable) this.child.stdin.end("stop\n");
    this.killTimer ??= setTimeout(() => this.child.kill(), 3000);
  }
  private receive(value: unknown): void {
    if (this.failure) return;
    const { event, clock } = nativeTaskEvent(value);
    const identity = `${clock.qpcOrigin}:${clock.qpcFrequency}`;
    if (clock.unsupportedActions < this.unsupported) throw new Error("task_counter_invalid");
    if ((this.clock && this.clock !== identity) || (this.sessionId && this.sessionId !== event.sessionId) || event.sequence !== this.sequence + 1
      || event.monotonicMs < this.lastMs || this.stoppedReason) throw new Error("task_protocol_order_invalid");
    this.sessionId = event.sessionId; this.clock = identity; this.sequence = event.sequence; this.lastMs = event.monotonicMs; this.anchor = performance.now();
    if (clock.unsupportedActions > this.unsupported) {
      this.overflow = true; this.unsupported = clock.unsupportedActions;
      this.onEvent({ timeMs: event.monotonicMs, timestamp: event.timestamp, origin: "control", type: "unsupported_input", window: null });
    }
    if (this.state === "starting") {
      if (event.kind !== "session.started" || event.collector.pid !== this.child.pid || event.collector.testHooks || event.options.parentPid !== process.pid
        || !event.options.inputHooks || event.options.seconds !== 1200 || event.policyRevision !== readNativePolicy(this.policyFile).revision) throw new Error();
      clearTimeout(this.timer); this.state = "recording"; this.startup.resolve(); return;
    }
    if (event.kind === "snapshot") {
      if (this.state === "paused") throw new Error("task_capture_while_paused");
      if (event.snapshot.status !== "ok") { this.normalizer.reset(); return; }
      const { policy, revision } = readNativePolicy(this.policyFile);
      // For task recording, QPC is authoritative. UTC may jump while a query is in flight.
      const checked = { ...event, snapshot: { ...event.snapshot,
        actions: event.snapshot.actions?.map((action) => ({ ...action, timestamp: event.timestamp })) } };
      const normalized = this.normalizer.normalizeEvents(checked, policy, revision);
      if (!event.context) throw new Error("task_window_missing");
      const { title: _title, generation: _generation, minimized: _minimized, ...context } = event.context;
      void _title; void _generation; void _minimized;
      const window = WindowsRecordingWindowSchema.parse(context);
      if (event.snapshot.actionOverflow) {
        this.overflow = true;
        this.onEvent({ timeMs: event.monotonicMs, timestamp: event.timestamp, origin: "control", type: "input_overflow", window: null });
      }
      for (const record of normalized) {
        const index = record.details?.actionIndex;
        if (typeof index !== "number") continue;
        const raw = event.snapshot.actions![index]!;
        const { type, timestamp, injected, ...action } = raw;
        const { unit: _unit, ...safe } = action as typeof action & { unit?: string }; void _unit;
        this.onEvent({ timeMs: Number(BigInt(clock.actionQpc[index]!) - BigInt(clock.qpcOrigin)) * 1000 / Number(clock.qpcFrequency),
          qpc: clock.actionQpc[index], timestamp, origin: "native", type, injected, window, action: safe });
      }
      return;
    }
    if (event.kind === "session.paused" || event.kind === "session.resumed") {
      this.normalizer.reset();
      if (!this.pending || this.pending.kind !== event.kind) throw new Error();
      this.state = event.kind === "session.paused" ? "paused" : "recording";
      clearTimeout(this.pending.timer); this.pending.ack.resolve(); this.pending = null; return;
    }
    if (event.kind === "error" && event.fatal) { this.fail(); return; }
    if (event.kind === "session.stopped") {
      this.stoppedReason = event.reason;
      if (!event.hooksDetached) this.failure = true;
    }
  }
  private async closed(code: number | null): Promise<void> {
    clearTimeout(this.timer); if (this.killTimer) clearTimeout(this.killTimer);
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.ack.reject(new Error("task_recording_closed")); this.pending = null; }
    if (this.state === "starting") this.startup.reject(new Error("task_recording_start_failed"));
    let result: RecordingResult;
    try { result = await this.finalize(); }
    catch { result = { durationMs: this.lastMs, qpc: null, parts: [], gaps: [], video: null, videoIntegrity: "missing", timelineCompleteness: "partial", error: "task_media_finalize_failed" }; }
    if (code !== 0 || this.failure || this.buffer.length || !this.stoppedReason) {
      result.timelineCompleteness = "partial"; result.error ??= "task_recording_interrupted";
    }
    if (this.overflow) result.timelineCompleteness = "partial";
    result.endReason = this.stoppedReason === "duration_elapsed" ? "duration_limit" : this.stoppedReason === "parent_exited" ? "process_exit" : "user_stopped";
    this.state = "closed"; this.done.resolve(result);
  }
  private command(verb: "pause" | "resume"): Promise<void> {
    if (this.pending || this.state !== (verb === "pause" ? "recording" : "paused")) return Promise.reject(new RecordingError(409, "recording_control_busy"));
    const ack = deferred<void>();
    this.pending = { kind: verb === "pause" ? "session.paused" : "session.resumed", ack, timer: setTimeout(() => this.fail(), 5000) };
    this.child.stdin.write(`${verb}\n`); return ack.promise;
  }
  pause(): Promise<void> { return this.command("pause"); }
  resume(): Promise<void> { return this.command("resume"); }
  stop(): Promise<RecordingResult> {
    if (this.state !== "closed" && !this.stoppedReason && this.child.stdin.writable) this.child.stdin.end("stop\n");
    if (this.state !== "closed") this.killTimer ??= setTimeout(() => this.child.kill(), 5000);
    return this.finished;
  }
}
