import fs from "node:fs";
import path from "node:path";
import type { recorderRotationRequest, recorderRotationResult } from "./recorder-checkpoint.js";
import type { z } from "zod";

type RotationRequest = z.infer<typeof recorderRotationRequest>;
type RotationResult = z.infer<typeof recorderRotationResult>;

interface SegmentHooks {
  metadata(title: string, createdAt: string): unknown;
  flushPending(): Promise<void>;
  onSegmentChanged(): void;
}

function appendJsonLine(file: string | number, payload: unknown): void {
  fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
}

/** Both native collectors serialize their input and checkpoint requests on this queue. */
export function createRecorderWriter(initialOutput: string, hooks: SegmentHooks) {
  const segmentsDirectory = path.dirname(path.dirname(initialOutput));
  let output = initialOutput;
  let sequence = 0;
  let processing = Promise.resolve();
  let pendingStopSync: string | null = null;
  // Only the candidate file belongs exclusively to the recorder until ACK.
  // Keep its original size until rollback succeeds, including across retries.
  let rollback: { file: string; size: number } | null = null;

  function restoreCandidate(): void {
    if (!rollback) return;
    fs.truncateSync(rollback.file, rollback.size);
    rollback = null;
  }

  function boundary<T>(task: () => Promise<T>, onError?: () => void): Promise<T> {
    const result = processing.then(task);
    processing = result.then(() => undefined, () => onError?.());
    return result;
  }

  function enqueue(task: () => Promise<void>): void {
    processing = processing.then(task);
  }

  function syncPrevious(): void {
    if (!pendingStopSync) return;
    const fd = fs.openSync(pendingStopSync, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    pendingStopSync = null;
  }

  async function rotate({ eventsFile, title, id }: RotationRequest, native?: { through: string; persist: () => string }): Promise<void> {
    const next = path.resolve(eventsFile);
    if (pendingStopSync) {
      if (next !== output) throw new Error("Previous checkpoint is awaiting sync");
      syncPrevious();
      return;
    }
    const dir = path.dirname(next);
    const existing = fs.lstatSync(next, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) throw new Error("Invalid output segment");
    if (native) {
      if (next === output || !path.isAbsolute(eventsFile)) throw new Error("Invalid recorder output");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!fs.lstatSync(dir).isDirectory()) throw new Error("Invalid output segment");
      fs.chmodSync(dir, 0o700);
      if (existing) fs.chmodSync(next, 0o600);
    } else if (path.basename(next) !== "events.jsonl" || path.dirname(dir) !== segmentsDirectory
      || !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/u.test(path.basename(dir)) || !fs.lstatSync(dir).isDirectory()) {
      throw new Error("Invalid output segment");
    }
    restoreCandidate();
    if (next !== output) {
      await hooks.flushPending();
      const timestamp = native?.through ?? new Date().toISOString();
      const nativeSessionId = native?.persist();
      const marker = (eventType: string, eventSequence: number) => ({
        recordType: "human_event", sequence: eventSequence, eventType, timestamp,
        details: nativeSessionId
          ? { ...(eventType === "recording_stopped" ? { reason: "segment_rotation" } : {}), nativeSessionId, collectorContinues: true }
          : { reason: "segment_rotation", checkpointId: id },
      });
      try {
        const fd = fs.openSync(next, "a", 0o600);
        try {
          rollback = { file: next, size: fs.fstatSync(fd).size };
          appendJsonLine(fd, hooks.metadata(title, timestamp));
          appendJsonLine(fd, marker("recording_started", sequence + 2));
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }

        const oldFd = fs.openSync(output, "a");
        try {
          appendJsonLine(oldFd, marker("recording_stopped", sequence + 1));
          // Both markers exist. Later input belongs in next, even if closing or
          // syncing the old file fails. A retry must only finish the old sync.
          rollback = null;
          pendingStopSync = output;
          output = next;
          sequence += 2;
          hooks.onSegmentChanged();
        } finally { fs.closeSync(oldFd); }
      } catch (error) {
        restoreCandidate();
        throw error;
      }
    }
    syncPrevious();
  }

  return {
    get output() { return output; },
    get sequence() { return sequence; },
    nextSequence() { return ++sequence; },
    append(payload: unknown) { appendJsonLine(output, payload); },
    enqueue,
    boundary,
    awaitingSync(request: RotationRequest) { return !!pendingStopSync && path.resolve(request.eventsFile) === output; },
    nativeRotation(request: RotationRequest, through: string, persist: () => string) {
      return boundary(async () => {
        try { await rotate(request, { through, persist }); }
        catch (error) {
          if (pendingStopSync) return { retrySync: true as const };
          throw error;
        }
      });
    },
    drain() { return processing; },
    checkpoint(request: RotationRequest, acknowledge: (result: RotationResult) => void) {
      // Enqueue immediately so new native input cannot overtake a buffered key flush.
      processing = processing.then(async () => {
        await rotate(request);
        acknowledge({ id: request.id, complete: true });
      }).catch(() => {
        acknowledge(pendingStopSync
          ? { id: request.id, complete: false, retrySync: true }
          : { id: request.id, complete: false });
      });
    },
  };
}
