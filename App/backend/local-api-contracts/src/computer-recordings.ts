import { z } from "zod";

const time = z.number().finite().nonnegative();
export const RecordingIdleSpanSchema = z.object({ startMs: time, endMs: time }).strict().refine((span) => span.endMs > span.startMs);
export const RecordingIdleSpansSchema = z.array(RecordingIdleSpanSchema).max(12000).refine((spans) =>
  spans.every((span, index) => index === 0 || span.startMs >= spans[index - 1]!.endMs), "idle spans must be ordered and disjoint");
/** Source timestamps remain intact; only the video's presentation clock skips idle spans. */
export function recordingVideoTime(sourceMs: number, spans: readonly { startMs: number; endMs: number }[] = []): number {
  return Math.max(0, sourceMs - spans.reduce((total, span) => total + Math.max(0, Math.min(sourceMs, span.endMs) - span.startMs), 0));
}
export function recordingSourceTime(videoMs: number, spans: readonly { startMs: number; endMs: number }[] = []): number {
  let source = videoMs;
  for (const span of spans) { if (source < span.startMs) break; source += span.endMs - span.startMs; }
  return source;
}
/** An event during omitted waiting belongs to the retained static image, before the next change. */
export function recordingEventVideoTime(sourceMs: number, spans: readonly { startMs: number; endMs: number }[] = []): number {
  const video = recordingVideoTime(sourceMs, spans);
  return Math.max(0, video - (spans.some(span => sourceMs >= span.startMs && sourceMs < span.endMs) ? 1 : 0));
}
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
/** Provider observations are evidence, not an assertion that an input hit a node. */
export const RecordingObservationSchema = z.object({ source: z.literal("windows_uia"), truncated: z.boolean(),
  nodes: z.array(z.object({ key: z.string().max(128), role: z.string().max(80), name: z.string().max(240).optional(),
    automation_id: z.string().max(256).optional(), bounds: z.tuple([z.number().finite(), z.number().finite(),
      z.number().finite().positive(), z.number().finite().positive()]).optional(), focused: z.boolean(),
  }).strict()).max(256),
}).strict();
export const RecordingEventSchema = z.object({
  id: z.string().min(1).max(120), sequence: z.number().int().positive(), timeMs: time, timestamp: z.string(),
  origin: z.enum(["native", "ocu", "control"]), type: z.string().min(1).max(100),
  qpc: ticks.optional(), monotonicTicks: ticks.optional(), window: RecordingWindowSchema.nullable(), injected: z.boolean().optional(),
  observation: RecordingObservationSchema.optional(),
  action: z.object({ button: z.enum(["left", "right"]).optional(), x: z.number().finite().optional(), y: z.number().finite().optional(),
    key: z.string().max(80).optional(), direction: z.enum(["up", "down", "left", "right"]).optional(), delta: z.number().int().optional(),
    deltaUnit: z.enum(["wheel120", "pixels"]).optional(), pressCount: z.number().int().positive().optional(), redacted: z.literal(true).optional(),
    tool: z.string().max(100).optional(), status: z.enum(["started", "finished", "failed", "unknown"]).optional(),
  }).strict().optional(),
}).strict();
export const RecordingFrameSchema = z.object({
  index: z.number().int().nonnegative(), timeMs: time, qpc: ticks.optional(), monotonicTicks: ticks.optional(),
  videoTimeMs: time.optional(),
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
  idleSpans: RecordingIdleSpansSchema.optional(),
  idlePaused: z.boolean().optional(), recordedDurationMs: time.optional(),
  video: z.object({ mediaId: z.literal("recording"), width: z.number().int().positive().max(1920), height: z.number().int().positive().max(1080),
    fps: z.number().positive().max(15), audio: z.literal(false), durationMs: time.optional() }).strict().nullable(),
  parts: z.array(RecordingPartSchema), gaps: z.array(RecordingGapSchema),
  privacy: z.object({ rawVisibleFrames: z.literal(true), audio: z.literal(false), localOnly: z.literal(true), retentionHours: z.literal(48) }).strict(),
}).strict();
export const RecordingStartSchema = z.object({ title: z.string().trim().min(1).max(200),
  applications: z.array(z.string().min(1)).min(1).max(32), consent: z.literal(true), skipIdle: z.boolean().optional(),
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

// The field names inside a step match Flow 1.35.1's Step / Anchor /
// StructuralLocator / Postcondition. The enclosing artifact is explicitly a
// candidate, not a Flow executable bundle or a claim of verified effects.
const point = z.tuple([z.number().finite(), z.number().finite()]);
const region = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(),
  z.number().int().positive(), z.number().int().positive()]);
const asset = z.string().regex(/^(?:frames|templates)\/[a-zA-Z0-9_-]+\.png$/u);
export const OperationStructuralLocatorSchema = z.object({ selector: z.string().max(500).optional(),
  role: z.string().max(80).optional(), name: z.string().max(240).optional(),
  automation_id: z.string().max(256).optional(), window_name: z.string().max(240).optional(),
}).strict();
const evidenceFrame = z.object({ index: z.number().int().nonnegative(), timeMs: time, videoTimeMs: time,
  partId: z.string(), partFrame: z.number().int().nonnegative(), ticks: ticks.nullable(), sourceTicks: ticks.nullable(),
}).strict();
export const OperationEvidenceStepSchema = z.object({
  id: z.string(), intent: z.string().max(1000), action: z.enum(["click", "right_click", "type", "key", "hotkey", "scroll"]),
  text: z.null(), param: z.null(), key: z.string().max(80).optional(), modifiers: z.array(z.string()).optional(),
  scroll_dx: z.number().int().optional(), scroll_dy: z.number().int().optional(), field_label: z.string().max(240).nullable(),
  anchor: z.object({ structural: OperationStructuralLocatorSchema.nullable(), template: asset.nullable(),
    region: region.nullable(), click_point: point.nullable(), ocr_text: z.null(),
    landmarks: z.array(z.object({ relation: z.enum(["left_of", "right_of", "above", "below"]),
      ocr_text: z.string(), distance_px: z.number().int().nonnegative() }).strict()).max(2),
  }).strict().nullable(),
  expect: z.array(z.object({ kind: z.enum(["text_present", "text_absent"]), text: z.string().min(1).max(240) }).strict()).max(16),
  evidence: z.object({ eventIds: z.array(z.string()), timestamp: z.string().nullable(), timeMs: time.nullable(),
    application: z.string().nullable(), window: RecordingWindowSchema.nullable(),
    before: evidenceFrame.nullable(), after: evidenceFrame.nullable(),
    targetBasis: z.enum(["action_accessibility", "pre_action_uia", "visual_point", "unavailable"]),
    targetCandidates: z.array(z.object({ basis: z.enum(["hit_test", "focused_context", "descendant_context", "ancestor_context", "pre_action_uia"]),
      structural: OperationStructuralLocatorSchema }).strict()).max(16),
    observationBeforeId: z.string().nullable(), observationAfterId: z.string().nullable(),
    effectStatus: z.enum(["candidate", "unavailable"]), executionVerified: z.literal(false),
    targetTemplate: z.object({ stddev: z.number().finite().nonnegative(), discriminative: z.boolean() }).strict().nullable(),
    visualChange: z.object({ changedPixels: z.number().int().nonnegative(), changedFraction: z.number().min(0).max(1),
      region: region.nullable(), afterTemplate: asset.nullable(), stability: z.literal("unverified"),
    }).strict().nullable(),
    missing: z.array(z.string()),
  }).strict(),
}).strict();
export const OperationEvidenceSchema = z.object({ schemaVersion: z.literal(1), status: z.literal("candidate"),
  source: z.object({ kind: z.enum(["computer_history", "task_recording"]), id: z.string(),
    eventsSha256: z.string().regex(/^[a-f0-9]{64}$/u), framesSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
    clock: RecordingClockSchema.nullable(),
  }).strict(),
  alignment: z.object({ format: z.literal("openadapt-flow-1.35.1"),
    upstreamCommit: z.literal("6e4e4ed0fe4addedd7c38ced44176b42bc40165a"),
    coordinateSpace: z.enum(["recorded_canvas_pixels", "unavailable"]), regionFormat: z.literal("x_y_width_height"),
  }).strict(),
  executionAdmission: z.literal("not_admitted"), replayable: z.literal(false),
  assets: z.array(z.object({ path: asset, sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    width: z.number().int().positive().max(1920), height: z.number().int().positive().max(1080) }).strict()),
  steps: z.array(OperationEvidenceStepSchema).max(1000),
  unresolvedEvents: z.array(z.object({ eventId: z.string(), type: z.string(), reason: z.string() }).strict()),
  missing: z.array(z.string()),
}).strict();
export type OperationEvidence = z.infer<typeof OperationEvidenceSchema>;
export type OperationEvidenceStep = z.infer<typeof OperationEvidenceStepSchema>;
export type OperationStructuralLocator = z.infer<typeof OperationStructuralLocatorSchema>;
export type RecordingObservation = z.infer<typeof RecordingObservationSchema>;
