import fs from "node:fs";
import path from "node:path";
import { redactSensitive } from "./redaction.js";

export interface HistoryApplication {
  id?: string;
  platform?: "macOS" | "windows";
  name?: string;
  executable?: string;
  bundleId?: string; // compatibility with existing macOS recordings
}

export function applicationId(application?: HistoryApplication): string | undefined {
  return application?.id ?? application?.bundleId;
}

export interface CaptureNode {
  key: string;
  parentKey: string | null;
  controlType: string;
  name?: string;
  text?: string;
  visibleText?: string;
  value?: string;
  valueSource?: "uia.value" | "uia.legacy_value" | "msaa.value" | "msaa.name";
  redaction?: string;
  documentStatus?: "available" | "label_only" | "read_failed";
  /** Assigned by the validated adapter, not by the native provider. Full text is context, not visibility evidence. */
  documentContext?: "vscode.editor" | "uia.document";
  /** Adapter-verified sources, not a filename or a persistent document identity. */
  documentEvidence?: {
    adapter: "vscode.editor" | "word.document" | "uia.text";
    labelKind: "editor_label" | "document_label";
    labelSource: "uia.name";
    textSource: "uia.document_range";
    visibleTextSource?: "uia.visible_ranges";
    providerFocused: boolean;
  };
  providerOffscreen: boolean;
}

export interface HistoryEvent {
  eventType: string;
  timestamp: string;
  application?: HistoryApplication;
  details?: Record<string, unknown>;
  accessibility?: { mode: "full"; truncated: boolean; nodes: CaptureNode[] };
}

export function scrubRecord<T>(value: T): T {
  if (typeof value === "string") return redactSensitive(value) as T;
  if (Array.isArray(value)) return value.map(scrubRecord) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubRecord(item)])) as T;
  }
  return value;
}

// One owner, one append-only file; only sanitized normalized records reach disk.
export class RecordingWriter {
  private readonly fd: number;
  private sequence = 0;
  private closed = false;
  constructor(readonly file: string, metadata: { recordingId: string; title: string; platform: "macOS" | "windows" }, append = false) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let existing = false;
    try { this.fd = fs.openSync(file, "wx", 0o600); }
    catch (error) {
      if (!append || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const prior = fs.lstatSync(file);
      if (!prior.isFile() || prior.isSymbolicLink()) throw new Error("recording_append_invalid");
      this.fd = fs.openSync(file, "a+", 0o600);
      try {
        const info = fs.fstatSync(this.fd);
        if (!info.isFile() || info.ino !== prior.ino || info.dev !== prior.dev || info.size < 2) throw new Error();
        const first = Buffer.alloc(Math.min(65536, info.size)); fs.readSync(this.fd, first, 0, first.length, 0);
        const newline = first.indexOf(10); if (newline < 0) throw new Error();
        const header = JSON.parse(first.subarray(0, newline).toString("utf8"));
        const tail = Buffer.alloc(Math.min(65536, info.size)); fs.readSync(this.fd, tail, 0, tail.length, info.size - tail.length);
        if (tail.at(-1) !== 10) throw new Error();
        const last = tail.subarray(tail.lastIndexOf(10, tail.length - 2) + 1, tail.length - 1);
        const event = JSON.parse(last.toString("utf8"));
        if (header.recordType !== "human_history_metadata" || header.schemaVersion !== 1 || header.platform !== metadata.platform
            || event.recordType !== "human_event" || event.eventType !== "recording_stopped" || !Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new Error();
        this.sequence = event.sequence;
        existing = true;
      } catch { fs.closeSync(this.fd); this.closed = true; throw new Error("recording_append_invalid"); }
    }
    if (existing) return;
    try {
      this.write({ recordType: "human_history_metadata", schemaVersion: 1, ...metadata,
        createdAt: new Date().toISOString(), screenshots: false, audio: false });
    } catch (error) { fs.closeSync(this.fd); this.closed = true; throw error; }
  }
  append(event: HistoryEvent): void {
    this.write({ recordType: "human_event", sequence: this.sequence + 1, ...event });
    ++this.sequence;
  }
  complete(event: HistoryEvent): void {
    if (this.closed) throw new Error("recording_closed");
    const previousSize = fs.fstatSync(this.fd).size;
    try {
      this.append(event);
      fs.fsyncSync(this.fd);
    } catch {
      // A failed final write/flush must not leave an apparently successful stop marker.
      fs.ftruncateSync(this.fd, previousSize);
      throw new Error("recording_completion_failed");
    } finally { this.closed = true; fs.closeSync(this.fd); }
  }
  private write(record: unknown): void {
    if (this.closed) throw new Error("recording_closed");
    const bytes = Buffer.from(`${JSON.stringify(scrubRecord(record))}\n`, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(this.fd, bytes, offset, bytes.length - offset);
      if (!written) throw new Error("recording_write_failed");
      offset += written;
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { fs.fsyncSync(this.fd); } finally { fs.closeSync(this.fd); }
  }
}
