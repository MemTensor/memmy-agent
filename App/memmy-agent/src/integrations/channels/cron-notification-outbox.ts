import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface CronNotificationPayload extends Record<string, unknown> {
  deliveryId: string;
  chat_id: string;
}

interface OutboxStore {
  version: 1;
  entries: CronNotificationPayload[];
}

function isPayload(value: unknown): value is CronNotificationPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.deliveryId === "string" && payload.deliveryId.trim().length > 0 &&
    typeof payload.chat_id === "string" && payload.chat_id.trim().length > 0;
}

/** Pending cron notifications survive gateway restarts until the GUI receives them. */
export class CronNotificationOutbox {
  static readonly maxEntries = 256;
  readonly storePath: string;

  constructor(storePath: string) {
    this.storePath = path.resolve(storePath);
  }

  private read(): OutboxStore {
    let content: string;
    try {
      content = fs.readFileSync(this.storePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: [] };
      throw error;
    }
    try {
      const value: unknown = JSON.parse(content);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid store");
      const store = value as Record<string, unknown>;
      if (store.version !== 1 || !Array.isArray(store.entries) ||
        store.entries.length > CronNotificationOutbox.maxEntries || !store.entries.every(isPayload)) {
        throw new Error("invalid store");
      }
      const entries = store.entries as CronNotificationPayload[];
      if (new Set(entries.map((entry) => entry.deliveryId)).size !== entries.length) throw new Error("duplicate IDs");
      return { version: 1, entries };
    } catch (cause) {
      // Preserve the original file. Replacing corruption with an empty queue
      // would silently discard notifications that the user has not received.
      throw new Error(`cron notification outbox is corrupt at ${this.storePath}; file preserved`, { cause });
    }
  }

  private write(store: OutboxStore): void {
    const content = JSON.stringify(store, null, 2);
    const directory = path.dirname(this.storePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | null = null;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, content, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      // The source and target are in the same directory. Node's rename replaces
      // the existing file on macOS and Windows without a delete-before-write gap.
      fs.renameSync(temporary, this.storePath);
      if (os.platform() !== "win32") {
        let directoryFd: number | null = null;
        try {
          directoryFd = fs.openSync(directory, "r");
          fs.fsyncSync(directoryFd);
        } catch {
          // Directory fsync is unavailable on some supported filesystems.
        } finally {
          if (directoryFd != null) {
            try { fs.closeSync(directoryFd); } catch { /* The atomic replacement already completed. */ }
          }
        }
      }
    } catch (error) {
      if (fd != null) {
        try { fs.closeSync(fd); } catch { /* Preserve the original error. */ }
      }
      try { fs.unlinkSync(temporary); } catch { /* The rename may already have consumed it. */ }
      throw error;
    }
  }

  enqueue(payload: CronNotificationPayload): void {
    if (!isPayload(payload)) throw new Error("cron notification requires a deliveryId and chat_id");
    // Copy the wire data before retaining it, and fail before touching the store
    // if the caller supplied a circular or otherwise non-serializable payload.
    const copy: unknown = JSON.parse(JSON.stringify(payload));
    if (!isPayload(copy)) throw new Error("cron notification requires a deliveryId and chat_id");
    const store = this.read();
    const index = store.entries.findIndex((entry) => entry.deliveryId === copy.deliveryId);
    if (index < 0) store.entries.push(copy);
    else store.entries[index] = copy;
    if (store.entries.length > CronNotificationOutbox.maxEntries) {
      store.entries.splice(0, store.entries.length - CronNotificationOutbox.maxEntries);
    }
    this.write(store);
  }

  list(): CronNotificationPayload[] {
    // Read on demand rather than cache, so a later instance or another channel
    // object sees notifications and acknowledgements already saved to disk.
    return this.read().entries;
  }

  remove(deliveryId: string): boolean {
    const store = this.read();
    const index = store.entries.findIndex((entry) => entry.deliveryId === deliveryId);
    if (index < 0) return false;
    store.entries.splice(index, 1);
    this.write(store);
    return true;
  }
}
