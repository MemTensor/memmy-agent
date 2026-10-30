import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { MacRecordingWindowSchema, RecordingClockSchema, RecordingEventSchema, RecordingFrameSchema, RecordingGapSchema,
  RecordingPermissionsSchema, type RecordingConfiguration, type RecordingEvent, type RecordingPermission, type RecordingSession } from "@memmy/local-api-contracts";
import { ensureNativeHistoryHelper } from "../computer-history/mac/native-helper.js";
import { ObservationSettingsStore } from "../computer-history/mac/settings-store.js";
import { BROWSER_BUNDLE_IDS, evaluateObservation, parseObservationSettings } from "../computer-history/core/observation-settings.js";
import { macPermissionSettingsGuide } from "../computer-use/mac-permission-settings.js";
import { readLines, RecordingError, type RecordingResult, type TaskRecordingDriver, type TaskRecordingHandle } from "./session-service.js";
import { exportOpenAdaptFlow } from "./openadapt-export.js";

const execute = promisify(execFile);
const decimal = z.string().regex(/^[0-9]+$/u).max(24);
const appSchema = z.object({ bundleId: z.string().min(1).max(256), name: z.string().min(1).max(256), pid: z.number().int().positive(),
  processStart: decimal, executable: z.string().min(1).max(4096) }).strict();
const configurationSchema = z.object({ supported: z.boolean(), permissions: RecordingPermissionsSchema, applications: z.array(appSchema).max(1024) }).strict();
const policySchema = z.object({ version: z.literal(1), parentPid: z.number().int().positive(), maxDurationMs: z.literal(1_200_000),
  applications: z.array(appSchema.omit({ name: true })).min(1).max(32) }).strict();
const envelopeSchema = z.object({ protocol: z.literal("memmy.macos.task-recording"), version: z.literal(1), sessionId: z.string().uuid(),
  pid: z.number().int().positive(), parentPid: z.number().int().positive(), policySha256: z.string().regex(/^[0-9a-f]{64}$/u),
  sequence: z.number().int().positive(), kind: z.enum(["started", "heartbeat", "input", "paused", "resumed", "stopped", "error"]),
  ticks: decimal, clock: RecordingClockSchema, timeMs: z.number().finite().nonnegative().max(1_201_000), timestamp: z.string().max(100),
  event: z.object({ type: z.string().max(100), ticks: decimal, window: MacRecordingWindowSchema, action: RecordingEventSchema.shape.action }).strict().optional(),
  inputIncomplete: z.boolean(),
  reason: z.enum(["user_stopped", "duration_limit", "process_exit", "capture_failed"]).optional(),
}).strict();
const mediaSchema = z.object({ version: z.literal(1), platform: z.literal("macos"), durationMs: z.number().finite().nonnegative().max(1_200_200),
  clock: RecordingClockSchema, width: z.literal(1920), height: z.literal(1080), complete: z.boolean(), error: z.string().nullable(),
  gaps: z.array(RecordingGapSchema), parts: z.array(z.object({ index: z.number().int().min(1).max(999999), startMs: z.number().finite().nonnegative(),
    durationMs: z.number().finite().positive(), bytes: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/u) }).strict()).max(121),
}).strict();
const unsupported = new Set(["com.apple.loginwindow", "com.apple.ScreenSaver.Engine", "com.apple.systempreferences", "com.apple.controlcenter",
  "com.apple.notificationcenterui", "com.apple.SecurityAgent", "com.microsoft.rdc.macos", "com.microsoft.rdc.mac", "com.microsoft.WindowsApp",
  "com.teamviewer.TeamViewer", "com.anydesk.AnyDesk", "com.citrix.receiver.icaviewer.mac", "com.parallels.desktop.console"]);
export function macRecordingApplicationSupported(bundleId: string): boolean {
  return ![...BROWSER_BUNDLE_IDS].some((id) => bundleId.toLowerCase() === id || bundleId.toLowerCase().startsWith(`${id}.`))
    && !unsupported.has(bundleId) && !/remote.?desktop|teamviewer|anydesk|citrix|vmware|parallels/iu.test(bundleId);
}
const clockMs = (ticks: string, clock: { origin: string; frequency: string }) => Number(BigInt(ticks) - BigInt(clock.origin)) * 1000 / Number(clock.frequency);
export function nativeMacTaskMessage(value: unknown) {
  const message = envelopeSchema.parse(value);
  if (message.clock.kind !== "mach_host" || message.clock.frequency !== "1000000000" || Math.abs(clockMs(message.ticks, message.clock) - message.timeMs) > 2
    || BigInt(message.ticks) < BigInt(message.clock.origin) || (message.kind === "input") !== !!message.event
    || (message.kind === "stopped") !== !!message.reason || (message.event && (BigInt(message.event.ticks) < BigInt(message.clock.origin)
      || BigInt(message.event.ticks) > BigInt(message.ticks)))) throw new Error("mac_task_protocol_invalid");
  return message;
}
function authorized(window: z.infer<typeof MacRecordingWindowSchema>, policy: z.infer<typeof policySchema>): boolean {
  return macRecordingApplicationSupported(window.bundleId) && policy.applications.some((app) => app.pid === window.pid && app.bundleId === window.bundleId
    && app.processStart === window.processStart && app.executable === window.executable);
}
function readJson(file: string): unknown {
  const info = fs.lstatSync(file);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 4 * 1024 * 1024) throw new Error("mac_task_metadata_invalid");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
/** Validate sealed media independently of the helper's success exit status. */
export async function readMacTaskMedia(directory: string): Promise<RecordingResult> {
  const media = mediaSchema.parse(readJson(path.join(directory, "native-media.json")));
  if (media.clock.kind !== "mach_host" || media.clock.frequency !== "1000000000") throw new Error("mac_task_clock_invalid");
  const policy = policySchema.parse(readJson(path.join(directory, "policy.json")));
  const parts: RecordingResult["parts"] = [];
  if (fs.lstatSync(path.join(directory, "parts")).isSymbolicLink()) throw new Error("mac_task_part_invalid");
  for (const part of media.parts) {
    if (part.index !== parts.length + 1 || (parts.length && Math.abs(part.startMs - (parts.at(-1)!.startMs + parts.at(-1)!.durationMs)) > 2)) throw new Error("mac_task_part_order_invalid");
    const file = path.join(directory, "parts", `${String(part.index).padStart(6, "0")}.mp4`);
    const info = fs.lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile() || info.size !== part.bytes) throw new Error("mac_task_part_invalid");
    const hash = crypto.createHash("sha256");
    for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
    if (hash.digest("hex") !== part.sha256) throw new Error("mac_task_part_hash_invalid");
    parts.push({ mediaId: `part-${String(part.index).padStart(6, "0")}`, startMs: part.startMs, durationMs: part.durationMs, bytes: part.bytes, sha256: part.sha256 });
  }
  const frames = readLines(path.join(directory, "frames.jsonl"), (value) => RecordingFrameSchema.parse(value));
  const counts = new Map<string, number>();
  for (const [index, frame] of frames.entries()) {
    const part = parts.find((item) => item.mediaId === frame.partId);
    if (!frame.monotonicTicks || frame.qpc || frame.index !== index || (index > 0 && frame.timeMs <= frames[index - 1]!.timeMs)
      || !part || frame.partFrame !== (counts.get(frame.partId) ?? 0) || Math.abs(clockMs(frame.monotonicTicks, media.clock) - frame.timeMs) > 2
      || frame.timeMs < part.startMs - 2 || frame.timeMs >= part.startMs + part.durationMs + 2) throw new Error("mac_task_frame_clock_invalid");
    counts.set(frame.partId, frame.partFrame + 1);
    if (frame.blank ? frame.window !== null || frame.transform !== null : !frame.window || !frame.transform) throw new Error("mac_task_frame_invalid");
    if (frame.window && (!frame.sourceTicks || BigInt(frame.sourceTicks) > BigInt(frame.monotonicTicks)
      || (!frame.repeated && frame.sourceTicks !== frame.monotonicTicks))) throw new Error("mac_task_frame_source_clock_invalid");
    if (frame.window && (!("windowId" in frame.window) || !authorized(frame.window, policy))) throw new Error("mac_task_frame_window_invalid");
    if (frame.transform && (frame.transform.offsetX < 0 || frame.transform.offsetY < 0 || frame.transform.scale > 4
      || frame.transform.offsetX + frame.transform.sourceWidth * frame.transform.scale > 1921
      || frame.transform.offsetY + frame.transform.sourceHeight * frame.transform.scale > 1081)) throw new Error("mac_task_frame_transform_invalid");
  }
  if (parts.some((part) => !counts.has(part.mediaId))) throw new Error("mac_task_frames_missing");
  const file = path.join(directory, "recording.mp4");
  const playable = fs.existsSync(file) && !fs.lstatSync(file).isSymbolicLink() && fs.statSync(file).isFile() && fs.statSync(file).size > 0;
  return { durationMs: media.durationMs, clock: media.clock, qpc: null, parts, gaps: media.gaps,
    video: playable ? { mediaId: "recording", width: 1920, height: 1080, fps: 15, audio: false } : null,
    videoIntegrity: media.complete && playable ? "complete" : parts.length ? "partial" : "missing",
    timelineCompleteness: media.complete ? "complete" : "partial", error: media.error };
}
export class MacTaskRecordingDriver implements TaskRecordingDriver {
  constructor(private readonly binary?: string, private readonly store = new ObservationSettingsStore()) {}
  private settings() {
    if (!fs.existsSync(this.store.filePath)) return this.store.read();
    try { return parseObservationSettings(readJson(this.store.filePath)); }
    catch { throw new RecordingError(422, "recording_observation_policy_invalid"); }
  }
  private helper(): Promise<string> {
    return this.binary ? Promise.resolve(this.binary) : ensureNativeHistoryHelper(fileURLToPath(new URL("../computer-history/mac/task-recorder.swift", import.meta.url)), "task-recorder");
  }
  private async run(args: string[], timeout = 120_000): Promise<string> {
    const { stdout } = await execute(await this.helper(), args, { timeout, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  }
  private async discover(args: string[] = []) {
    return configurationSchema.parse(JSON.parse(await this.run(["--configuration", ...args], 60_000)));
  }
  async configuration(): Promise<RecordingConfiguration> {
    const native = await this.discover();
    const settings = this.settings();
    const applications = new Map<string, RecordingConfiguration["applications"][number]>();
    for (const app of native.applications) applications.set(app.bundleId, { id: app.bundleId, name: app.name, running: true,
      supported: macRecordingApplicationSupported(app.bundleId), allowed: evaluateObservation(settings, { bundleId: app.bundleId }).observe });
    return { platform: "macos", supported: native.supported, minimumSystemVersion: "12.3", permissions: native.permissions, applications: [...applications.values()] };
  }
  async openPermission(permission: RecordingPermission, mode: "request" | "settings"): Promise<RecordingConfiguration> {
    if (mode === "request") await this.discover([`--request-${permission}`]);
    else if (!await macPermissionSettingsGuide.show("task-recording", permission, true)) throw new RecordingError(503, "mac_recording_settings_unavailable");
    return this.configuration();
  }
  async start(input: Parameters<TaskRecordingDriver["start"]>[0]): Promise<TaskRecordingHandle> {
    const native = await this.discover();
    if (!native.supported) throw new RecordingError(422, "mac_task_recording_requires_macos_12_3");
    if (Object.values(native.permissions).some((value) => !value)) throw new RecordingError(422, "mac_task_recording_permissions_required");
    const settings = this.settings();
    if (new Set(input.applications).size !== input.applications.length || input.applications.some((id) => !macRecordingApplicationSupported(id)
      || !evaluateObservation(settings, { bundleId: id }).observe)) throw new RecordingError(422, "recording_application_not_authorized");
    const applications = native.applications.filter((app) => input.applications.includes(app.bundleId)).map(({ name: _name, ...app }) => { void _name; return app; });
    if (input.applications.some((id) => !applications.some((app) => app.bundleId === id))) throw new RecordingError(422, "recording_application_unavailable");
    const policy = policySchema.parse({ version: 1, parentPid: process.pid, maxDurationMs: 1_200_000, applications });
    const policyFile = path.join(input.directory, "policy.json");
    fs.writeFileSync(policyFile, JSON.stringify(policy), { flag: "wx", mode: 0o600 });
    const hash = crypto.createHash("sha256").update(fs.readFileSync(policyFile)).digest("hex");
    const child = spawn(await this.helper(), ["--record-task", "--output-dir", input.directory], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const handle = new MacTaskHandle(child, hash, policy, input.onEvent, () => this.finishFiles(input.directory));
    try { await handle.ready; return handle; } catch (error) { await handle.finished; throw error; }
  }
  private async finishFiles(directory: string): Promise<RecordingResult> {
    try { await this.run(["--finalize-task", "--output-dir", directory]); }
    catch { if (!fs.existsSync(path.join(directory, "native-media.json"))) throw new Error("mac_task_finalize_failed"); }
    return readMacTaskMedia(directory);
  }
  recover(directory: string): Promise<RecordingResult> { return this.finishFiles(directory); }
  exportFlow(directory: string, session: RecordingSession, events: RecordingEvent[], destination: string): Promise<string[]> {
    return exportOpenAdaptFlow({ directory, session, events, destination,
      extract: async () => { await this.run(["--export-task-frames", "--output-dir", directory, "--export-dir", destination]); } });
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {}); return { promise, resolve, reject };
}
class MacTaskHandle implements TaskRecordingHandle {
  private readonly startup = deferred<void>();
  private readonly done = deferred<RecordingResult>();
  readonly ready = this.startup.promise;
  readonly finished = this.done.promise;
  private state = "starting";
  private buffer = Buffer.alloc(0);
  private sequence = 0;
  private sessionId: string | null = null;
  private clock: string | null = null;
  private lastMs = 0;
  private anchor = performance.now();
  private failure = false;
  private partial = false;
  private reason: RecordingSession["taskEndReason"] = null;
  private pending: { kind: string; ack: ReturnType<typeof deferred<void>>; timer: NodeJS.Timeout } | null = null;
  private readonly startupTimer: NodeJS.Timeout;
  private watchdog: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly policyHash: string,
    private readonly policy: z.infer<typeof policySchema>, private readonly onEvent: Parameters<TaskRecordingDriver["start"]>[0]["onEvent"],
    private readonly finalize: () => Promise<RecordingResult>) {
    this.startupTimer = setTimeout(() => this.fail(), 15_000);
    child.on("error", () => this.fail()); child.stdin.on("error", () => { if (!this.reason) this.fail(); });
    child.stderr.on("data", () => {}); child.stderr.on("error", () => this.fail());
    child.stdout.on("error", () => this.fail());
    child.stdout.on("data", (bytes: Buffer) => {
      try {
        this.buffer = Buffer.concat([this.buffer, bytes]);
        let newline: number;
        while ((newline = this.buffer.indexOf(10)) >= 0) {
          if (newline > 64 * 1024) throw new Error();
          const line = new TextDecoder("utf8", { fatal: true }).decode(this.buffer.subarray(0, newline));
          this.buffer = this.buffer.subarray(newline + 1); this.receive(JSON.parse(line));
        }
        if (this.buffer.length > 64 * 1024) throw new Error();
      } catch { this.fail(); }
    });
    child.once("close", (code) => { void this.closed(code); });
  }
  timeMs(): number { return this.lastMs + Math.max(0, performance.now() - this.anchor); }
  private fail(): void {
    this.failure = true; this.startup.reject(new Error("mac_task_start_or_protocol_failed"));
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.ack.reject(new Error("mac_task_control_failed")); this.pending = null; }
    if (this.child.stdin.writable) this.child.stdin.end("stop\n");
    this.killTimer ??= setTimeout(() => this.child.kill("SIGKILL"), 5000);
  }
  private receive(value: unknown): void {
    if (this.failure) return;
    const message = nativeMacTaskMessage(value), clock = JSON.stringify(message.clock);
    if (message.pid !== this.child.pid || message.parentPid !== process.pid || message.policySha256 !== this.policyHash
      || (this.sessionId && this.sessionId !== message.sessionId) || (this.clock && this.clock !== clock)
      || message.sequence !== this.sequence + 1 || message.timeMs < this.lastMs || this.reason) throw new Error("mac_task_order_invalid");
    this.sequence = message.sequence; this.sessionId = message.sessionId; this.clock = clock; this.lastMs = message.timeMs; this.anchor = performance.now();
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.fail(), 20_000);
    if (message.inputIncomplete && !this.partial) this.onEvent({ origin: "control", type: "input_timeline_incomplete", timeMs: message.timeMs,
      monotonicTicks: message.ticks, timestamp: message.timestamp, window: null });
    this.partial ||= message.inputIncomplete;
    if (this.state === "starting") {
      if (message.kind !== "started") throw new Error("mac_task_start_invalid");
      clearTimeout(this.startupTimer); this.state = "recording"; this.startup.resolve(); return;
    }
    if (message.kind === "input" && message.event) {
      if (this.state !== "recording" || !authorized(message.event.window, this.policy)) throw new Error("mac_task_input_invalid");
      if (message.event.type === "unsupported_input") this.partial = true;
      const { ticks, ...event } = message.event;
      this.onEvent({ ...event, origin: "native", timeMs: clockMs(ticks, message.clock), monotonicTicks: ticks, timestamp: message.timestamp });
    } else if (message.kind === "paused" || message.kind === "resumed") {
      if (this.pending?.kind !== message.kind) throw new Error("mac_task_control_invalid");
      this.state = message.kind === "paused" ? "paused" : "recording";
      clearTimeout(this.pending.timer); this.pending.ack.resolve(); this.pending = null;
    } else if (message.kind === "error") this.fail();
    else if (message.kind === "stopped") this.reason = message.reason!;
    else if (message.kind !== "heartbeat") throw new Error("mac_task_message_invalid");
  }
  private async closed(code: number | null): Promise<void> {
    clearTimeout(this.startupTimer); if (this.watchdog) clearTimeout(this.watchdog); if (this.killTimer) clearTimeout(this.killTimer);
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.ack.reject(new Error("mac_task_closed")); this.pending = null; }
    if (this.state === "starting") this.startup.reject(new Error("mac_task_start_failed"));
    let result: RecordingResult;
    try { result = await this.finalize(); }
    catch { result = { durationMs: this.lastMs, qpc: null, parts: [], gaps: [], video: null, videoIntegrity: "missing", timelineCompleteness: "partial", error: "mac_task_finalize_failed" }; }
    if (this.partial) result.timelineCompleteness = "partial";
    if (code !== 0 || this.failure || this.buffer.length || !this.reason) { result.timelineCompleteness = "partial"; result.error ??= "mac_task_interrupted"; }
    result.endReason = this.reason ?? "capture_failed"; this.state = "closed"; this.done.resolve(result);
  }
  private command(verb: "pause" | "resume"): Promise<void> {
    if (this.pending || this.state !== (verb === "pause" ? "recording" : "paused")) return Promise.reject(new RecordingError(409, "recording_control_busy"));
    const ack = deferred<void>();
    this.pending = { kind: verb === "pause" ? "paused" : "resumed", ack, timer: setTimeout(() => this.fail(), 5000) };
    this.child.stdin.write(`${verb}\n`); return ack.promise;
  }
  pause(): Promise<void> { return this.command("pause"); }
  resume(): Promise<void> { return this.command("resume"); }
  stop(): Promise<RecordingResult> {
    if (this.state !== "closed" && !this.reason && this.child.stdin.writable) this.child.stdin.end("stop\n");
    if (this.state !== "closed") this.killTimer ??= setTimeout(() => this.child.kill("SIGKILL"), 20_000);
    return this.finished;
  }
}
