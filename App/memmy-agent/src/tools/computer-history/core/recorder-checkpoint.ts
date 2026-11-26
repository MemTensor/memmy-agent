import { z } from "zod";

export const checkpointId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);

/** Internal writer handoff; the native collector and its coverage ledger stay alive. */
export const recorderRotationRequest = z.object({ kind: z.literal("rotate"), id: checkpointId,
  eventsFile: z.string().min(1).max(4096), title: z.string().max(200),
}).strict();
export const recorderRotationResult = z.union([
  z.object({ id: checkpointId, complete: z.boolean() }).strict(),
  z.object({ id: checkpointId, complete: z.literal(false), retrySync: z.literal(true) }).strict(),
]);
