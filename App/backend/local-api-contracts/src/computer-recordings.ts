import { z } from "zod";

const time = z.number().finite().nonnegative();
const id = z.string().uuid();
const bounds = z.object({ left: z.number().finite(), top: z.number().finite(), right: z.number().finite(), bottom: z.number().finite() }).strict();
export const WindowsRecordingWindowSchema = z.object({
  hwnd: z.string().regex(/^[1-9][0-9]*$/u), pid: z.number().int().positive(), processStart: z.string().regex(/^[1-9][0-9]*$/u),
  executable: z.string().min(1), dpi: z.number().int().nonnegative(), bounds,
}).strict();
export const MacRecordingWindowSchema = z.object({
  platform: z.literal("macos"), windowId: z.number().int().positive(), pid: z.number().int().positive(),
  processStart: z.string().regex(/^[1-9][0-9]*$/u), executable: z.string().min(1), bundleId: z.string().min(1),
  scale: z.number().finite().positive().max(4), bounds,
}).strict();
export const RecordingWindowSchema = z.union([WindowsRecordingWindowSchema, MacRecordingWindowSchema]);
const ticks = z.string().regex(/^[0-9]+$/u).max(24);
export const RecordingClockSchema = z.object({ kind: z.enum(["qpc", "mach_host"]), origin: ticks,
  frequency: ticks.refine((value) => BigInt(value) > 0n),
}).strict();
export const RecordingGapSchema = z.object({ startMs: time, endMs: time,
  reason: z.enum(["paused", "unauthorized", "unavailable", "capture_failed", "missing_tail"]),
}).strict().refine((gap) => gap.endMs >= gap.startMs);
export const RecordingPartSchema = z.object({ mediaId: z.string().regex(/^part-[0-9]{6}$/u),
  startMs: time, durationMs: time, bytes: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();
export const RecordingEventSchema = z.object({
  id: z.string().min(1).max(120), sequence: z.number().int().positive(), timeMs: time, timestamp: z.string(),
  origin: z.enum(["native", "ocu", "control"]), type: z.string().min(1).max(100),
  qpc: ticks.optional(), monotonicTicks: ticks.optional(), window: RecordingWindowSchema.nullable(), injected: z.boolean().optional(),
  action: z.object({ button: z.enum(["left", "right"]).optional(), x: z.number().finite().optional(), y: z.number().finite().optional(),
    key: z.string().max(80).optional(), direction: z.enum(["up", "down", "left", "right"]).optional(), delta: z.number().int().optional(),
    deltaUnit: z.enum(["wheel120", "pixels"]).optional(), pressCount: z.number().int().positive().optional(), redacted: z.literal(true).optional(),
    tool: z.string().max(100).optional(), status: z.enum(["started", "finished", "failed", "unknown"]).optional(),
  }).strict().optional(),
}).strict();
export const RecordingFrameSchema = z.object({
  index: z.number().int().nonnegative(), timeMs: time, qpc: ticks.optional(), monotonicTicks: ticks.optional(),
  sourceTicks: ticks.optional(), repeated: z.boolean().optional(),
  gapReason: z.enum(["paused", "unauthorized", "unavailable", "capture_failed"]).optional(),
  partId: z.string().regex(/^part-[0-9]{6}$/u), partFrame: z.number().int().nonnegative(),
  window: RecordingWindowSchema.nullable(), blank: z.boolean(),
  transform: z.object({ sourceWidth: z.number().int().positive(), sourceHeight: z.number().int().positive(),
    offsetX: z.number().finite(), offsetY: z.number().finite(), scale: z.number().finite().positive(),
    sourceLeft: z.number().finite(), sourceTop: z.number().finite(),
  }).strict().nullable(),
}).strict().refine((frame) => (frame.qpc === undefined) !== (frame.monotonicTicks === undefined), "exactly one native frame clock is required");
export const RecordingSessionSchema = z.object({
  schemaVersion: z.literal(1), id, title: z.string().min(1).max(200), platform: z.enum(["windows", "macos"]),
  source: z.enum(["human", "agent"]), state: z.enum(["starting", "recording", "paused", "finalizing", "ready", "failed"]),
  createdAt: z.string(), stoppedAt: z.string().nullable(), durationMs: time, applications: z.array(z.string().min(1)).min(1).max(32),
  agent: z.object({ runId: z.string().min(1).max(120), chatId: z.string().min(1), messageId: z.string().min(1) }).strict().nullable(), pinned: z.boolean(),
  videoIntegrity: z.enum(["complete", "partial", "missing"]), timelineCompleteness: z.enum(["complete", "partial"]),
  taskEndReason: z.enum(["user_stopped", "completed", "cancelled", "duration_limit", "app_exit", "process_exit", "capture_failed"]).nullable(),
  error: z.string().nullable(), qpc: z.object({ origin: z.string().regex(/^[0-9]+$/u), frequency: z.string().regex(/^[1-9][0-9]*$/u) }).strict().nullable(),
  clock: RecordingClockSchema.optional(),
  video: z.object({ mediaId: z.literal("recording"), width: z.number().int().positive().max(1920), height: z.number().int().positive().max(1080),
    fps: z.number().positive().max(15), audio: z.literal(false) }).strict().nullable(),
  parts: z.array(RecordingPartSchema), gaps: z.array(RecordingGapSchema),
  privacy: z.object({ rawVisibleFrames: z.literal(true), audio: z.literal(false), localOnly: z.literal(true), retentionHours: z.literal(48) }).strict(),
}).strict();
export const RecordingStartSchema = z.object({ title: z.string().trim().min(1).max(200),
  applications: z.array(z.string().min(1)).min(1).max(32), consent: z.literal(true),
}).strict();
export const RecordingPermissionsSchema = z.object({ accessibility: z.boolean(), inputMonitoring: z.boolean(), screenRecording: z.boolean() }).strict();
export const RecordingConfigurationSchema = z.object({ platform: z.enum(["windows", "macos"]), supported: z.boolean(),
  applications: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), running: z.boolean(), allowed: z.boolean(), supported: z.boolean() }).strict()),
  permissions: RecordingPermissionsSchema.nullable(), minimumSystemVersion: z.string().optional(),
}).strict();
export const RecordingExportResultSchema = z.object({
  id: z.string().uuid(), recordingId: id, state: z.enum(["processing", "ready", "failed"]),
  format: z.literal("openadapt-flow-1.35.1"), executionAdmission: z.literal("not_admitted"),
  replayable: z.literal(false), missing: z.array(z.string()), error: z.string().nullable(),
}).strict();
export type RecordingSession = z.infer<typeof RecordingSessionSchema>;
export type RecordingEvent = z.infer<typeof RecordingEventSchema>;
export type RecordingFrame = z.infer<typeof RecordingFrameSchema>;
export type RecordingGap = z.infer<typeof RecordingGapSchema>;
export type RecordingPart = z.infer<typeof RecordingPartSchema>;
export type RecordingExportResult = z.infer<typeof RecordingExportResultSchema>;
export type RecordingStart = z.infer<typeof RecordingStartSchema>;
export type RecordingConfiguration = z.infer<typeof RecordingConfigurationSchema>;
export type RecordingPermissions = z.infer<typeof RecordingPermissionsSchema>;
export type RecordingPermission = keyof RecordingPermissions;
