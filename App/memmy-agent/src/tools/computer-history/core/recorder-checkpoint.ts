import { z } from "zod";

export const checkpointId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
export const checkpointTime = z.string().datetime({ precision: 3 });
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const checkpointRequest = z.object({ kind: z.literal("checkpoint"), id: checkpointId,
  from: checkpointTime.optional(), through: checkpointTime.optional(),
}).strict().refine(value => value.through === undefined || (value.from !== undefined && Date.parse(value.through) >= Date.parse(value.from)));

/** Content-free, durable position in the sanitized stream, never a caller-supplied path. */
export const checkpointWatermark = z.object({ nativeSessionId: z.string().regex(/^[0-9a-f]{32}$/u),
  nativeSequence: count.min(1), captureSequence: count.min(1), recordingSequence: count.min(1), bytes: count.min(1),
}).strict();
export const persistedCheckpoint = z.object({ id: checkpointId, complete: z.boolean(), rangeEvaluated: z.boolean(),
  through: checkpointTime, watermark: checkpointWatermark,
  issues: z.array(z.string().regex(/^[a-z_]+$/u).max(80)).max(32),
}).strict();
export type PersistedCheckpoint = z.infer<typeof persistedCheckpoint>;

/** Internal writer handoff; the native collector and its coverage ledger stay alive. */
export const recorderRotationRequest = z.object({ kind: z.literal("rotate"), id: checkpointId,
  eventsFile: z.string().min(1).max(4096), title: z.string().max(200),
}).strict();
export const recorderRotationResult = z.object({ id: checkpointId, complete: z.boolean() }).strict();

export const recordingCheckpointRecord = z.object({ recordType: z.literal("human_event"), sequence: count.min(1),
  eventType: z.literal("recording_checkpoint"), timestamp: checkpointTime,
  details: z.object({ checkpointId, nativeSessionId: z.string().regex(/^[0-9a-f]{32}$/u),
    nativeSequence: count.min(1), captureSequence: count.min(1) }).strict(),
}).strict();

export const recordingGapRecord = z.object({ recordType: z.literal("human_event"), sequence: count.min(1),
  eventType: z.literal("recording_gap"), timestamp: checkpointTime,
  details: z.object({ nativeSessionId: z.string().regex(/^[0-9a-f]{32}$/u), nativeSequence: count.min(1),
    code: z.string().regex(/^[a-z0-9_]+$/u).max(80), from: checkpointTime, through: checkpointTime }).strict(),
}).strict();
