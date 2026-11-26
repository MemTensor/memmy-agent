import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { EventCaptureSessionSchema, type CaptureEndReason, type EventCaptureSession } from "@memmy/local-api-contracts";
import type { EventCaptureSource, EventCaptureSubscription, CaptureCheckpoint } from "../computer-history/core/event-capture-source.js";
import { compactEventEvidence } from "../computer-history/mac/summary-writer.js";
import { redactSensitive } from "../computer-history/mac/redaction.js";
import { writeJsonAtomic } from "../../utils/atomic-json.js";
import { BrowserCaptureRequestSchema, type BrowserCaptureProvider, type BrowserCaptureRequest } from "../computer-history/browser-event-capture.js";
import { readHistoryPermissions, type HistoryPermission, type HistoryPermissions } from "../computer-history/mac/permissions.js";

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const controls = /^recording_(?:started|stopped|paused|resumed|checkpoint|gap)$/;
const maxBytes = 64 * 1024 * 1024;
const maxDurationMs = 30 * 60 * 1_000;
type Active = { session: EventCaptureSession; subscription: EventCaptureSubscription;
  positions: Map<string, number>; skipLeading: Set<string>; fd: number; bytes: number;
  stopping?: Promise<EventCaptureSession> };
type PermissionAlert = { required: HistoryPermission[]; permissions: HistoryPermissions; at: string };

function withBrowserEnhancement(desktop: EventCaptureSubscription, browser: EventCaptureSubscription): EventCaptureSubscription {
  return {
    async checkpoint(range) {
      const primary = await desktop.checkpoint(range);
      let additional: CaptureCheckpoint;
      try { additional = await browser.checkpoint(range); }
      catch { return { ...primary, limitations: [...primary.limitations, "Browser enhancement checkpoint failed; desktop recording continues."] }; }
      return { ...primary, streams: [...primary.streams, ...additional.streams],
        complete: primary.complete === false || additional.complete === false ? false : primary.complete,
        limitations: [...primary.limitations, ...additional.limitations] };
    },
    async release() {
      const results = await Promise.allSettled([browser.release(), desktop.release()]);
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
    },
  };
}

/** One live capture globally; completed evidence remains conversation-owned. */
export class PluginEventSessions {
  private readonly active = new Map<string, Active>();
  private readonly failed = new Map<string, EventCaptureSession>();
  private readonly starting = new Map<string, { session: EventCaptureSession; controller: AbortController }>();
  private readonly permissionAlerts = new Map<string, PermissionAlert>();
  private pending: Promise<unknown> = Promise.resolve();
  private polling: Promise<void> | null = null;
  private readonly timer: ReturnType<typeof setInterval>;
  private closing = false;
  constructor(private readonly options: { dataRoot: string; source: EventCaptureSource; browser?: BrowserCaptureProvider;
    browserEnhancement?: { acquire(sessionId: string, directory: string): Promise<EventCaptureSubscription> };
    permissions?: () => Promise<HistoryPermissions>; now?: () => number }) {
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
        if ((this.options.now?.() ?? Date.now()) - Date.parse(active.session.startedAt) >= maxDurationMs) {
          void this.stop(active.session.pluginId, active.session.conversationId, active.session.id, false, "max_duration").catch(() => undefined);
          continue;
        }
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
  private liveSession() {
    return [...this.active.values(), ...this.starting.values()].find(item =>
      ["starting", "recording", "finalizing"].includes(item.session.state))?.session ?? null;
  }
  activeFor(owner: string): EventCaptureSession | null {
    const session = this.liveSession();
    return session?.pluginId === owner ? structuredClone(session) : null;
  }
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
  private discardEvidence(session: EventCaptureSession) {
    const folder = this.folder(session.pluginId, session.id);
    for (const entry of fs.readdirSync(folder)) {
      if (entry === "session.json" || entry === "events.jsonl") continue;
      fs.rmSync(path.join(folder, entry), { recursive: true, force: true });
    }
    fs.writeFileSync(path.join(folder, "events.jsonl"), "", { mode: 0o600 });
    session.eventCount = 0; session.eventTypes = {}; session.applications = [];
    session.ranges = []; session.eventsSha256 = null; session.availability = "empty";
    session.limitations = []; session.error = null;
    delete session.captureIntegrity; delete session.browserCapture;
    this.save(session);
  }
  private authorized(owner: string, _conversationId: string, id: string) {
    // Teach Mode is a user-global recorder. The source conversation remains
    // in the manifest for provenance, while an authenticated user can finish
    // or inspect the recording from any conversation.
    return this.read(owner, id);
  }
  list(owner: string, conversationId: string): EventCaptureSession[] {
    const root = path.dirname(this.folder(owner, "00000000-0000-0000-0000-000000000000"));
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).flatMap(id => {
      try { return [this.read(owner, id)]; } catch { return []; }
    }).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  start(owner: string, conversationId: string, goal: string, consent: boolean, browser?: BrowserCaptureRequest) {
    return this.serial(async () => {
      if (this.closing) throw new Error("capture_shutting_down");
      if (consent !== true || !goal.trim() || goal.length > 2_000) throw new Error("capture_goal_and_consent_required");
      const existing = this.liveSession();
      if (existing) {
        if (existing.pluginId !== owner) throw new Error("capture_busy");
        return { ...structuredClone(existing), alreadyActive: true };
      }
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
        if (!browser && this.options.browserEnhancement) {
          try {
            const enhancement = await this.options.browserEnhancement.acquire(session.id, this.folder(owner, session.id));
            subscription = withBrowserEnhancement(subscription, enhancement);
          } catch {
            session.limitations.push("Browser enhancement is unavailable; desktop recording continues.");
          }
        }
        controller.signal.throwIfAborted();
        const initial = await subscription.checkpoint({ from: this.now() });
        controller.signal.throwIfAborted();
        if (!initial.running) throw new Error("capture_not_running");
        session.state = "recording"; session.startedAt = this.now();
        this.permissionAlerts.delete(conversationId);
        session.captureIntegrity = initial.captureIntegrity;
        session.browserCapture = subscription.browserCapture;
        session.availability = !initial.rangeEvaluated && initial.complete === false ? "partial" : "pending";
        session.limitations = [...new Set([...session.limitations, ...(initial.rangeEvaluated
          ? initial.limitations.filter(value => !/coverage is incomplete|observer is still starting|checkpoint could not be confirmed/i.test(value))
          : initial.limitations)])];
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
          if (session.state !== "cancelled") { session.state = "failed"; session.availability = "unavailable"; session.endedAt = this.now(); session.endReason = "start_failed"; }
          if (session.state !== "cancelled") {
            session.error = error instanceof Error ? error.message : "capture_start_failed";
            this.failed.set(session.id, session);
          }
          try { this.save(session); } catch { /* The in-memory terminal state remains authoritative until disk recovers. */ }
        }
        await subscription?.release();
        if (session?.state === "cancelled") {
          this.discardEvidence(session);
          return structuredClone(session);
        }
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
    const gathered: Array<{ at: number; stream: string; byte: number; event: Record<string, any> }> = [];
    const positions: Array<{ stream: string; start: number; end: number }> = [];
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
        const byte = position + consumed;
        consumed += lineBytes;
        if (at < start || at > end) continue;
        gathered.push({ at, stream: stream.id, byte, event });
      }
      positions.push({ stream: stream.id, start: position, end: position + consumed });
      if (active.session.endedAt && complete !== input.length) {
        active.session.availability = "partial"; active.session.limitations.push("An incomplete trailing source record was excluded.");
      }
    }
    // Desktop and browser evidence share one time line, regardless of the order
    // their checkpoint files were returned in.
    gathered.sort((left, right) => left.at - right.at || left.stream.localeCompare(right.stream) || left.byte - right.byte);
    for (const { stream, event } of gathered) {
      const envelope = { index: active.session.eventCount, source: { stream, sequence: event.sequence }, event };
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
    for (const position of positions) {
      const range = active.session.ranges.find(r => r.stream === position.stream);
      if (range) range.endByte = position.end;
      else active.session.ranges.push({ stream: position.stream, startByte: position.start, endByte: position.end });
      active.positions.set(position.stream, position.end);
    }
    if (!point.running && active.session.state === "recording") throw new Error("capture_source_stopped");
    this.save(active.session);
  }
  private orderFinalEvidence(active: Active) {
    const file = path.join(this.folder(active.session.pluginId, active.session.id), "events.jsonl");
    const source = fs.readFileSync(file, "utf8").trim();
    if (!source) return;
    const records = source.split("\n").map(line => JSON.parse(line) as {
      index: number; event: { timestamp: string };
    });
    if (records.length !== active.session.eventCount) throw new Error("capture_evidence_count_mismatch");
    records.sort((left, right) => Date.parse(left.event.timestamp) - Date.parse(right.event.timestamp)
      || left.index - right.index);
    const ordered = Buffer.from(records.map((record, index) => JSON.stringify({ ...record, index })).join("\n") + "\n");
    if (ordered.length > maxBytes) throw new Error("capture_evidence_limit_reached");
    fs.ftruncateSync(active.fd, 0);
    for (let written = 0; written < ordered.length;) {
      const count = fs.writeSync(active.fd, ordered, written, ordered.length - written, written);
      if (!count) throw new Error("capture_evidence_write_failed");
      written += count;
    }
    active.bytes = ordered.length;
  }
  stop(owner: string, conversationId: string, id: string, cancel = false,
    reason: CaptureEndReason = cancel ? "recording_controls_cancelled" : "recording_controls_stopped") {
    // Validate ownership before freezing a boundary, even while a checkpoint
    // is in flight. The first accepted stop owns the cutoff and cancellation.
    let saved: EventCaptureSession;
    try {
      const live = this.active.get(id)?.session ?? this.starting.get(id)?.session;
      saved = live?.pluginId === owner ? structuredClone(live) : this.authorized(owner, conversationId, id);
    }
    catch (error) { return Promise.reject(error); }
    const starting = this.starting.get(id);
    if (starting) {
      starting.controller.abort(new Error("capture_start_cancelled"));
      starting.session.state = "cancelled"; starting.session.endedAt = this.now(); starting.session.availability = "empty";
      starting.session.endReason = reason;
      this.save(starting.session);
      return this.pending.then(() => this.read(owner, id));
    }
    const active = this.active.get(id);
    if (!active) return Promise.resolve(saved);
    if (active.stopping) return active.stopping;
    active.session.endedAt ??= this.now(); active.session.state = "finalizing"; active.session.endReason = reason;
    this.save(active.session);
    const stopping = this.serial(async () => {
      if (!this.active.has(id)) return this.read(owner, id);
      if (cancel) {
        try {
          if (active.fd >= 0) { fs.closeSync(active.fd); active.fd = -1; }
          await active.subscription.release();
          this.active.delete(id);
          active.session.state = "cancelled"; active.session.endReason = "recording_controls_cancelled";
          this.discardEvidence(active.session);
          return structuredClone(active.session);
        } catch (error) {
          active.session.state = "failed"; active.session.endReason = "capture_failed";
          active.session.error = error instanceof Error ? error.message : "capture_cancel_failed";
          this.save(active.session);
          throw error;
        }
      }
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
        if (!cancel) this.orderFinalEvidence(active);
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
  private readyEvidence(owner: string, conversationId: string, id: string) {
    const session = this.authorized(owner, conversationId, id);
    if (session.state !== "ready" || !session.eventsSha256 || session.availability === "empty") throw new Error("capture_ready_events_required");
    if (this.evidenceHash(session) !== session.eventsSha256) throw new Error("capture_evidence_hash_mismatch");
    if (session.captureIntegrity?.proofSha256) {
      const proof = path.join(this.folder(owner, id), "capture-proof.jsonl"), stat = fs.lstatSync(proof);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024
        || createHash("sha256").update(fs.readFileSync(proof)).digest("hex") !== session.captureIntegrity.proofSha256) throw new Error("capture_proof_hash_mismatch");
    }
    const records = fs.readFileSync(path.join(this.folder(owner, id), "events.jsonl"), "utf8").trim().split("\n");
    return { session, records };
  }
  /** Publish just one verified ready recording into the requesting conversation's workspace.
   * This is an Agent input, not an artifact: no attachment/media publication occurs. */
  publishEvidence(owner: string, conversationId: string, id: string, workspace: string) {
    const { session } = this.readyEvidence(owner, conversationId, id);
    const source = this.folder(owner, id);
    const bytes = fs.readFileSync(path.join(source, "events.jsonl"));
    if (createHash("sha256").update(bytes).digest("hex") !== session.eventsSha256) throw new Error("capture_evidence_hash_mismatch");
    // Preserve the trusted binding spelling: restricted tools compare it lexically
    // (macOS /var and /private/var may refer to the same directory).
    const root = path.resolve(workspace);
    if (!fs.statSync(root).isDirectory()) throw new Error("capture_workspace_unavailable");
    // Full digest avoids path collisions or traversal from conversation IDs. It is
    // intentionally the requesting conversation, not the original recording owner.
    const scope = createHash("sha256").update(conversationId).digest("hex");
    let parent = root;
    for (const part of [".teach-evidence", owner, scope]) {
      parent = path.join(parent, part);
      if (!fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o700 });
      const stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("capture_invalid_workspace_path");
    }
    const folder = fs.mkdtempSync(path.join(parent, `${id}-`));
    try {
      fs.writeFileSync(path.join(folder, "events.jsonl"), bytes, { flag: "wx", mode: 0o600 });
      if (session.captureIntegrity?.proofSha256) {
        const proof = fs.readFileSync(path.join(source, "capture-proof.jsonl"));
        if (createHash("sha256").update(proof).digest("hex") !== session.captureIntegrity.proofSha256) throw new Error("capture_proof_hash_mismatch");
        fs.writeFileSync(path.join(folder, "capture-proof.jsonl"), proof, { flag: "wx", mode: 0o600 });
      }
      fs.writeFileSync(path.join(folder, "session.json"), JSON.stringify({ ...session,
        evidenceFiles: { events: "events.jsonl", ...(session.captureIntegrity?.proofSha256 ? { proof: "capture-proof.jsonl" } : {}) }
      }, null, 2), { flag: "wx", mode: 0o600 });
      return { schema: "memmy.teaching-evidence-files/v1", sessionId: session.id,
        state: session.state, availability: session.availability, eventCount: session.eventCount,
        startedAt: session.startedAt, endedAt: session.endedAt, endReason: session.endReason,
        eventsSha256: session.eventsSha256, metadataPath: path.join(folder, "session.json"),
        eventsPath: path.join(folder, "events.jsonl") };
    } catch (error) { fs.rmSync(folder, { recursive: true, force: true }); throw error; }
  }
  summarize(owner: string, conversationId: string, id: string) {
    const { session, records } = this.readyEvidence(owner, conversationId, id);
    // Reuse only the pure History formatter. No History lookup, writer, model,
    // prior summaries or memory sync participates in this session-local view.
    const events = records.map(line => JSON.stringify(JSON.parse(line).event));
    const summary = { schema: "memmy.teaching-summary/v1", sessionId: id,
      eventsSha256: session.eventsSha256, eventCount: session.eventCount,
      availability: session.availability, limitations: session.limitations,
      text: redactSensitive(compactEventEvidence(events)),
      note: "Approximate, potentially sampled operation summary. Read original events by session ID and index for action evidence." };
    writeJsonAtomic(path.join(this.folder(owner, id), "summary.json"), summary);
    return summary;
  }
  readEvents(owner: string, conversationId: string, id: string, offset = 0, limit = 100) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("capture_invalid_cursor");
    const { session, records } = this.readyEvidence(owner, conversationId, id);
    const events: unknown[] = []; let bytes = 0;
    for (const line of records.slice(offset, offset + limit)) {
      if (bytes + Buffer.byteLength(line) > 2_000_000 && events.length) break;
      if (Buffer.byteLength(line) > 2_000_000) throw new Error("capture_event_too_large_for_context");
      events.push(JSON.parse(line)); bytes += Buffer.byteLength(line);
    }
    const nextOffset = offset + events.length < records.length ? offset + events.length : null;
    return { session, events, nextOffset };
  }
  /** Reads the same TCC grants the recorder needs; Windows needs no per-app grants. */
  private permissions(): Promise<HistoryPermissions> {
    if (process.platform === "win32") return Promise.resolve({ supported: true, accessibility: true, inputMonitoring: true });
    return (this.options.permissions ?? readHistoryPermissions)();
  }
  async invoke(owner: string, conversationId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (input.action === "permissions") return { ...(await this.permissions()) };
    if (input.action === "permission-alert") {
      if (input.pending !== true) { this.permissionAlerts.delete(conversationId); return { pending: false }; }
      const permissions = await this.permissions();
      const required = (["accessibility", "inputMonitoring"] as const).filter(permission => !permissions[permission]);
      // force: start already failed for lack of a grant, so keep the prompt even when
      // the fresh check passes; the user then needs Quit & Reopen.
      if (!required.length && input.force !== true) { this.permissionAlerts.delete(conversationId); return { pending: false, permissions }; }
      const alert = { required: [...required], permissions, at: this.now() };
      this.permissionAlerts.set(conversationId, alert);
      return { pending: true, ...alert };
    }
    if (input.action === "browser-options") {
      if (!this.options.browser) throw new Error("browser_capture_unavailable: update the desktop Host");
      return this.options.browser.profiles() as Record<string, unknown>;
    }
    if (input.action === "start") return this.start(owner, conversationId, String(input.goal ?? ""), input.consent === true,
      input.browser === undefined ? undefined : BrowserCaptureRequestSchema.parse(input.browser));
    if (input.action === "status" || input.action === "list") return {
      sessions: this.list(owner, conversationId),
      active: input.action === "status" ? this.activeFor(owner) : null,
      permissionAlert: this.permissionAlerts.get(conversationId) ?? null };
    if (typeof input.session_id !== "string") throw new Error("capture_session_id_required");
    if (input.action === "stop" || input.action === "cancel") return this.stop(owner, conversationId, input.session_id,
      input.action === "cancel");
    if (input.action === "summary") return this.summarize(owner, conversationId, input.session_id);
    if (input.action === "read") return this.readEvents(owner, conversationId, input.session_id, Number(input.offset ?? 0), Number(input.limit ?? 100));
    throw new Error("capture_unknown_action");
  }
  private async fail(active: Active, error: unknown, reason: CaptureEndReason = "capture_failed") {
    active.session.state = "failed"; active.session.availability = "partial"; active.session.endedAt ??= this.now();
    if (active.session.captureIntegrity) active.session.captureIntegrity.snapshotSaved = false;
    active.session.error = error instanceof Error ? error.message : "capture_failed";
    active.session.endReason = reason;
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
      .map(active => this.fail(active, new Error("capture_plugin_stopped"), "service_terminated")));
    const error = results.find((result): result is PromiseRejectedResult => result.status === "rejected"); if (error) throw error.reason;
  }); }
  async close() { this.closing = true; clearInterval(this.timer);
    for (const item of this.starting.values()) item.controller.abort(new Error("capture_host_stopped"));
    await this.serial(async () => {
    await Promise.allSettled([...this.active.values()].map(active => this.fail(active, new Error("capture_host_stopped"), "service_terminated")));
  }); }
}
