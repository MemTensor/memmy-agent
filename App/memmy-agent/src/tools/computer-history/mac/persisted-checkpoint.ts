import fs from "node:fs";
import { z } from "zod";
import { checkpointId, checkpointTime, checkpointWatermark, recordingCheckpointRecord,
  type PersistedCheckpoint } from "../core/recorder-checkpoint.js";

const nativeCheckpoint = z.object({ kind: z.literal("session.checkpoint"), id: checkpointId,
  complete: z.boolean(), nativeSessionId: checkpointWatermark.shape.nativeSessionId,
  nativeSequence: checkpointWatermark.shape.nativeSequence,
  issues: z.array(z.string().regex(/^[a-z_]+$/).max(80)).max(32).default([]) });

/** Called inside the normalization queue, at the native marker, before later events. */
export function persistMacCheckpoint(input: {
  file: string; event: Record<string, unknown>; through: string; sequence: number;
}): Pick<PersistedCheckpoint, "through" | "watermark" | "issues"> {
  const native = nativeCheckpoint.parse(input.event), through = checkpointTime.parse(input.through);
  const record = recordingCheckpointRecord.parse({ recordType: "human_event", sequence: input.sequence,
    eventType: "recording_checkpoint", timestamp: through, details: { checkpointId: native.id,
      nativeSessionId: native.nativeSessionId, nativeSequence: native.nativeSequence,
      // macOS has one ordered native stream, with no intermediate supervisor.
      captureSequence: native.nativeSequence } });
  const fd = fs.openSync(input.file, "a");
  try {
    fs.writeFileSync(fd, JSON.stringify(record) + "\n");
    fs.fsyncSync(fd);
    return { through, watermark: checkpointWatermark.parse({ nativeSessionId: native.nativeSessionId,
      nativeSequence: native.nativeSequence, captureSequence: native.nativeSequence,
      recordingSequence: record.sequence, bytes: fs.fstatSync(fd).size }),
      issues: [...new Set([...native.issues, ...(!native.complete ? ["native_checkpoint_incomplete"] : [])])] };
  } finally { fs.closeSync(fd); }
}
