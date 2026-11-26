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

  function enqueue(task: () => Promise<void>): void {
    processing = processing.then(task);
  }

  async function rotate({ eventsFile, title, id }: RotationRequest): Promise<void> {
    const next = path.resolve(eventsFile);
    const dir = path.dirname(next);
    const existing = fs.lstatSync(next, { throwIfNoEntry: false });
    if (path.basename(next) !== "events.jsonl" || path.dirname(dir) !== segmentsDirectory
      || !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/u.test(path.basename(dir))
      || !fs.lstatSync(dir).isDirectory() || (existing && !existing.isFile())) {
      throw new Error("Invalid output segment");
    }
    if (pendingStopSync && next !== output) throw new Error("Previous checkpoint is awaiting sync");
    restoreCandidate();
    if (next !== output) {
      await hooks.flushPending();
      const timestamp = new Date().toISOString();
      const marker = (eventType: string, eventSequence: number) => ({
        recordType: "human_event", sequence: eventSequence, eventType, timestamp,
        details: { reason: "segment_rotation", checkpointId: id },
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
    if (pendingStopSync) {
      const fd = fs.openSync(pendingStopSync, "r+");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      pendingStopSync = null;
    }
  }

  return {
    get output() { return output; },
    get sequence() { return sequence; },
    nextSequence() { return ++sequence; },
    append(payload: unknown) { appendJsonLine(output, payload); },
    enqueue,
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
