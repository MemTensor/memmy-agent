import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { EventCaptureSessionSchema, type EventCaptureSession } from "@memmy/local-api-contracts";
import type { EventCaptureSource, EventCaptureSubscription, CaptureCheckpoint } from "../computer-history/core/event-capture-source.js";
import { writeJsonAtomic } from "../../utils/atomic-json.js";
import { BrowserCaptureRequestSchema, type BrowserCaptureProvider, type BrowserCaptureRequest } from "../computer-history/browser-event-capture.js";

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const controls = /^recording_(?:started|stopped|paused|resumed|checkpoint|gap)$/;
const maxBytes = 64 * 1024 * 1024;
type Active = { session: EventCaptureSession; subscription: EventCaptureSubscription;
  positions: Map<string, number>; skipLeading: Set<string>; fd: number; bytes: number;
  stopping?: Promise<EventCaptureSession> };

/** Durable, owner/conversation-scoped snapshots of the shared authorized stream. */
export class PluginEventSessions {
  private readonly active = new Map<string, Active>();
  private readonly failed = new Map<string, EventCaptureSession>();
  private readonly starting = new Map<string, { session: EventCaptureSession; controller: AbortController }>();
  private pending: Promise<unknown> = Promise.resolve();
  private polling: Promise<void> | null = null;
  private readonly timer: ReturnType<typeof setInterval>;
  private closing = false;
  constructor(private readonly options: { dataRoot: string; source: EventCaptureSource; browser?: BrowserCaptureProvider; now?: () => number }) {
    fs.mkdirSync(options.dataRoot, { recursive: true });
    // A Host crash never resumes acquisition. Keep the partial evidence.
    for (const owner of fs.readdirSync(options.dataRoot, { withFileTypes: true })) {
      if (!owner.isDirectory() || owner.isSymbolicLink()) continue;
      const root = path.join(options.dataRoot, owner.name, "event-sessions");
      if (!fs.existsSync(root)) continue;
      for (const folder of fs.readdirSync(root)) {
        try {
          const session = this.read(owner.name, folder);
          if (["starting", "recording", "finalizing"].includes(session.state)) {
            session.state = "failed"; session.availability = "partial"; session.error = "capture_interrupted";
            session.endedAt = this.now(); this.save(session);
          }
        } catch { /* Never advertise invalid manifests. */ }
      }
    }
    this.timer = setInterval(() => { void this.poll(); }, 1_000); this.timer.unref();
  }
  private poll(): Promise<void> {
    if (this.polling) return this.polling;
    const pass = this.serial(async () => {
      for (const active of [...this.active.values()]) {
        if (active.session.state !== "recording") continue;
        try { await this.collect(active); }
        catch (error) { await this.fail(active, error); }
      }
    }).catch(() => undefined);
    this.polling = pass;
    void pass.finally(() => { if (this.polling === pass) this.polling = null; });
    return pass;
  }
  private now() { return new Date(this.options.now?.() ?? Date.now()).toISOString(); }
  isBusy(owner: string) { return [...this.active.values(), ...this.starting.values()].some(active => active.session.pluginId === owner); }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.catch(() => undefined).then(operation); this.pending = next; return next;
  }
  private folder(owner: string, id: string) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(owner) || !idPattern.test(id)) throw new Error("capture_invalid_identity");
    const root = path.resolve(this.options.dataRoot, owner), folder = path.join(root, "event-sessions", id);
    for (const target of [root, path.dirname(folder), folder]) if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error("capture_invalid_path");
    return folder;
  }
  private read(owner: string, id: string) {
    const failed = this.failed.get(id); if (failed?.pluginId === owner) return structuredClone(failed);
    const file = path.join(this.folder(owner, id), "session.json"), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 200_000) throw new Error("capture_invalid_manifest");
    const session = EventCaptureSessionSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (session.id !== id || session.pluginId !== owner) throw new Error("capture_invalid_owner");
    return session;
  }
  private save(session: EventCaptureSession) {
    writeJsonAtomic(path.join(this.folder(session.pluginId, session.id), "session.json"), EventCaptureSessionSchema.parse(session));
  }
  private authorized(owner: string, conversationId: string, id: string) {
    const session = this.read(owner, id);
    if (session.conversationId !== conversationId) throw new Error("capture_not_found_in_conversation");
    return session;
  }
  list(owner: string, conversationId: string): EventCaptureSession[] {
    const root = path.dirname(this.folder(owner, "00000000-0000-0000-0000-000000000000"));
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).flatMap(id => {
      try { const session = this.read(owner, id); return session.conversationId === conversationId ? [session] : []; } catch { return []; }
    }).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  start(owner: string, conversationId: string, goal: string, consent: boolean, browser?: BrowserCaptureRequest) {
    return this.serial(async () => {
      if (this.closing) throw new Error("capture_shutting_down");
      if (consent !== true || !goal.trim() || goal.length > 2_000) throw new Error("capture_goal_and_consent_required");
      const duplicate = [...this.active.values(), ...this.starting.values()].find(a => a.session.pluginId === owner && a.session.conversationId === conversationId);
      if (duplicate) return structuredClone(duplicate.session);
      if (browser) BrowserCaptureRequestSchema.parse(browser);
      let subscription: (EventCaptureSubscription & { browserCapture?: EventCaptureSession["browserCapture"] }) | undefined;
      let fd: number | undefined;
      let session: EventCaptureSession | undefined;
      const controller = new AbortController();
      try {
        session = { schemaVersion: 1, id: randomUUID(), pluginId: owner, conversationId,
          goal: goal.trim(), state: "starting", startedAt: this.now(), endedAt: null, eventCount: 0, eventTypes: {}, applications: [],
          availability: "pending", eventsSha256: null, limitations: [], error: null, ranges: [],
          ...(browser ? { browserCapture: { browser: browser.name, scope: "teaching-window-and-popups" as const } } : {}) };
        fs.mkdirSync(this.folder(owner, session.id), { recursive: true, mode: 0o700 });
        this.starting.set(session.id, { session, controller }); this.save(session);
        if (browser && !this.options.browser) throw new Error("browser_capture_unavailable: update the desktop Host");
        subscription = browser ? await this.options.browser!.acquire({ sessionId: session.id, directory: this.folder(owner, session.id), request: browser, signal: controller.signal })
          : await this.options.source.acquireEventCapture();
        controller.signal.throwIfAborted();
        const initial = await subscription.checkpoint({ from: this.now() });
        controller.signal.throwIfAborted();
        if (!initial.running) throw new Error("capture_not_running");
        session.state = "recording"; session.startedAt = this.now();
        session.captureIntegrity = initial.captureIntegrity;
        session.browserCapture = subscription.browserCapture;
        session.availability = !initial.rangeEvaluated && initial.complete === false ? "partial" : "pending";
        session.limitations = initial.rangeEvaluated ? initial.limitations.filter(value => !/coverage is incomplete|observer is still starting|checkpoint could not be confirmed/i.test(value)) : initial.limitations;
        fd = fs.openSync(path.join(this.folder(owner, session.id), "events.jsonl"), "wx", 0o600);
        this.save(session);
        const skipLeading = new Set<string>();
        for (const stream of initial.streams) if (stream.size) {
          const input = fs.openSync(stream.file, "r"), last = Buffer.alloc(1);
          try { fs.readSync(input, last, 0, 1, stream.size - 1); if (last[0] !== 10) skipLeading.add(stream.id); }
          finally { fs.closeSync(input); }
        }
        this.active.set(session.id, { session, subscription, fd, bytes: 0, skipLeading, positions: new Map(initial.streams.map(s => [s.id, s.size])) });
        return structuredClone(session);
      } catch (error) {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* Subscription cleanup still runs after a file error. */ } }
        if (session) {
          if (session.state !== "cancelled") { session.state = "failed"; session.availability = "unavailable"; session.endedAt = this.now(); }
          if (session.state !== "cancelled") {
            session.error = error instanceof Error ? error.message : "capture_start_failed";
            this.failed.set(session.id, session);
          }
          try { this.save(session); } catch { /* The in-memory terminal state remains authoritative until disk recovers. */ }
        }
        await subscription?.release();
        if (session?.state === "cancelled") return structuredClone(session);
        throw error;
      } finally {
        if (session) this.starting.delete(session.id);
      }
    });
  }
  private async collect(active: Active, checkpoint?: CaptureCheckpoint) {
    const point = checkpoint ?? await active.subscription.checkpoint({ from: active.session.startedAt,
      ...(active.session.endedAt ? { through: active.session.endedAt } : {}) });
    if (point.captureIntegrity) active.session.captureIntegrity = structuredClone(point.captureIntegrity);
    active.session.limitations = [...new Set([...active.session.limitations, ...point.limitations])];
    if (point.complete === false) active.session.availability = "partial";
    const start = Date.parse(active.session.startedAt), end = Date.parse(active.session.endedAt ?? this.now());
    if (end < start) throw new Error("capture_clock_changed");
    for (const stream of point.streams) {
      let position = active.positions.get(stream.id) ?? 0;
      if (stream.size < position || stream.size - position > maxBytes) throw new Error("capture_source_range_invalid");
      if (stream.size === position) continue;
      const stat = fs.lstatSync(stream.file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("capture_source_invalid");
      const bytes = Buffer.alloc(stream.size - position), fd = fs.openSync(stream.file, "r");
      try {
        let read = 0;
        while (read < bytes.length) { const n = fs.readSync(fd, bytes, read, bytes.length - read, position + read); if (!n) throw new Error("capture_source_truncated"); read += n; }
      } finally { fs.closeSync(fd); }
      let input = bytes;
      if (active.skipLeading.has(stream.id)) {
        const newline = input.indexOf(10);
        if (newline < 0) { active.positions.set(stream.id, stream.size); continue; }
        position += newline + 1; input = input.subarray(newline + 1); active.skipLeading.delete(stream.id);
      }
      const complete = input.lastIndexOf(10) + 1;
      let consumed = 0;
      for (const line of input.subarray(0, complete).toString("utf8").split("\n").slice(0, -1)) {
        const lineBytes = Buffer.byteLength(line, "utf8") + 1;
        if (!line) { consumed += lineBytes; continue; }
        const event = JSON.parse(line);
        if (event.recordType !== "human_event" || typeof event.eventType !== "string" || controls.test(event.eventType)) { consumed += lineBytes; continue; }
        const at = Date.parse(event.timestamp);
        if (!Number.isFinite(at)) throw new Error("capture_event_timestamp_invalid");
        // A native timestamp can lead the Host clock by a few milliseconds.
        // Keep its byte position for the next poll instead of silently losing it.
        // A final stop has a fixed cutoff and may discard post-cutoff records.
        if (at > end && !active.session.endedAt) break;
        consumed += lineBytes;
        if (at < start || at > end) continue;
        const envelope = { index: active.session.eventCount, source: { stream: stream.id, sequence: event.sequence }, event };
        const output = Buffer.from(JSON.stringify(envelope) + "\n");
        if (active.bytes + output.length > maxBytes || active.session.eventCount >= 100_000) throw new Error("capture_evidence_limit_reached");
        let written = 0;
        while (written < output.length) {
          const count = fs.writeSync(active.fd, output, written, output.length - written);
          if (!count) throw new Error("capture_evidence_write_failed"); written += count;
        }
        active.bytes += output.length; active.session.eventCount++;
        active.session.eventTypes[event.eventType] = (active.session.eventTypes[event.eventType] ?? 0) + 1;
        const app = event.application?.name ?? event.application?.bundleId ?? event.application?.executable;
        if (typeof app === "string" && !active.session.applications.includes(app)) active.session.applications.push(app);
      }
      const range = active.session.ranges.find(r => r.stream === stream.id);
      if (range) range.endByte = position + consumed;
      else active.session.ranges.push({ stream: stream.id, startByte: position, endByte: position + consumed });
      position += consumed; active.positions.set(stream.id, position);
      if (active.session.endedAt && complete !== input.length) {
        active.session.availability = "partial"; active.session.limitations.push("An incomplete trailing source record was excluded.");
      }
    }
    if (!point.running && active.session.state === "recording") throw new Error("capture_source_stopped");
    this.save(active.session);
  }
  stop(owner: string, conversationId: string, id: string, cancel = false) {
    // Validate ownership before freezing a boundary, even while a checkpoint
    // is in flight. The first accepted stop owns the cutoff and cancellation.
    let saved: EventCaptureSession;
    try { saved = this.authorized(owner, conversationId, id); }
    catch (error) { return Promise.reject(error); }
    const starting = this.starting.get(id);
    if (starting) {
      starting.controller.abort(new Error("capture_start_cancelled"));
      starting.session.state = "cancelled"; starting.session.endedAt = this.now(); starting.session.availability = "empty";
      this.save(starting.session); return Promise.resolve(structuredClone(starting.session));
    }
    const active = this.active.get(id);
    if (!active) return Promise.resolve(saved);
    if (active.stopping) return active.stopping;
    active.session.endedAt ??= this.now(); active.session.state = "finalizing";
    this.save(active.session);
    const stopping = this.serial(async () => {
      if (!this.active.has(id)) return this.read(owner, id);
      try {
        const point = await active.subscription.checkpoint({ from: active.session.startedAt, through: active.session.endedAt! });
        if (point.captureIntegrity) active.session.captureIntegrity = structuredClone(point.captureIntegrity);
        active.session.limitations = [...new Set([...active.session.limitations, ...point.limitations])];
        if (point.complete !== true) {
          active.session.availability = "partial";
          const limitation = point.captureIntegrity
            ? point.boundaryConfirmed ? "Browser recording was saved with coverage gaps." : "Browser recording end boundary could not be confirmed."
            : point.boundaryConfirmed ? "Capture coverage is incomplete for this fragment." : "Native-to-disk completion was not confirmed.";
          if (!active.session.limitations.includes(limitation)) active.session.limitations.push(limitation);
        }
        await this.collect(active, point);
        if (!point.running) throw new Error("capture_source_stopped");
        fs.fsyncSync(active.fd); fs.closeSync(active.fd); active.fd = -1;
        active.session.eventsSha256 = this.evidenceHash(active.session);
        active.session.state = cancel ? "cancelled" : "ready";
        if (active.session.captureIntegrity) active.session.captureIntegrity.snapshotSaved = true;
        if (active.session.availability !== "partial") active.session.availability = active.session.eventCount ? "available" : "empty";
        this.save(active.session); return structuredClone(active.session);
      } catch (error) { await this.fail(active, error); return this.read(owner, id); }
      finally { if (this.active.delete(id)) await active.subscription.release(); }
    });
    active.stopping = stopping;
    return stopping;
  }
  private evidenceHash(session: EventCaptureSession) {
    const file = path.join(this.folder(session.pluginId, session.id), "events.jsonl"), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error("capture_evidence_invalid");
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  readEvents(owner: string, conversationId: string, id: string, offset = 0, limit = 100) {
    const session = this.authorized(owner, conversationId, id);
    if (session.state !== "ready" || !session.eventsSha256 || session.availability === "empty") throw new Error("capture_ready_events_required");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("capture_invalid_cursor");
    if (this.evidenceHash(session) !== session.eventsSha256) throw new Error("capture_evidence_hash_mismatch");
    if (session.captureIntegrity?.proofSha256) {
      const proof = path.join(this.folder(owner, id), "capture-proof.jsonl"), stat = fs.lstatSync(proof);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024
        || createHash("sha256").update(fs.readFileSync(proof)).digest("hex") !== session.captureIntegrity.proofSha256) throw new Error("capture_proof_hash_mismatch");
    }
    const records = fs.readFileSync(path.join(this.folder(owner, id), "events.jsonl"), "utf8").trim().split("\n");
    const events: unknown[] = []; let bytes = 0;
    for (const line of records.slice(offset, offset + limit)) {
      if (bytes + Buffer.byteLength(line) > 2_000_000 && events.length) break;
      if (Buffer.byteLength(line) > 2_000_000) throw new Error("capture_event_too_large_for_context");
      events.push(JSON.parse(line)); bytes += Buffer.byteLength(line);
    }
    const nextOffset = offset + events.length < records.length ? offset + events.length : null;
    return { session, events, nextOffset };
  }
  async invoke(owner: string, conversationId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (input.action === "browser-options") {
      if (!this.options.browser) throw new Error("browser_capture_unavailable: update the desktop Host");
      return this.options.browser.profiles() as Record<string, unknown>;
    }
    if (input.action === "start") return this.start(owner, conversationId, String(input.goal ?? ""), input.consent === true,
      input.browser === undefined ? undefined : BrowserCaptureRequestSchema.parse(input.browser));
    if (input.action === "status" || input.action === "list") return { sessions: this.list(owner, conversationId) };
    if (typeof input.session_id !== "string") throw new Error("capture_session_id_required");
    if (input.action === "stop" || input.action === "cancel") return this.stop(owner, conversationId, input.session_id, input.action === "cancel");
    if (input.action === "read") return this.readEvents(owner, conversationId, input.session_id, Number(input.offset ?? 0), Number(input.limit ?? 100));
    throw new Error("capture_unknown_action");
  }
  private async fail(active: Active, error: unknown) {
    active.session.state = "failed"; active.session.availability = "partial"; active.session.endedAt ??= this.now();
    if (active.session.captureIntegrity) active.session.captureIntegrity.snapshotSaved = false;
    active.session.error = error instanceof Error ? error.message : "capture_failed";
    this.failed.set(active.session.id, structuredClone(active.session));
    this.active.delete(active.session.id);
    try {
      if (active.fd >= 0) { try { fs.fsyncSync(active.fd); } finally { fs.closeSync(active.fd); active.fd = -1; } }
      this.save(active.session);
    } finally { await active.subscription.release(); }
  }
  release(owner: string) {
    for (const item of this.starting.values()) if (item.session.pluginId === owner) item.controller.abort(new Error("capture_plugin_stopped"));
    return this.serial(async () => {
    const results = await Promise.allSettled([...this.active.values()].filter(active => active.session.pluginId === owner)
      .map(active => this.fail(active, new Error("capture_plugin_stopped"))));
    const error = results.find((result): result is PromiseRejectedResult => result.status === "rejected"); if (error) throw error.reason;
  }); }
  async close() { this.closing = true; clearInterval(this.timer);
    for (const item of this.starting.values()) item.controller.abort(new Error("capture_host_stopped"));
    await this.serial(async () => {
    await Promise.allSettled([...this.active.values()].map(active => this.fail(active, new Error("capture_host_stopped"))));
  }); }
}
