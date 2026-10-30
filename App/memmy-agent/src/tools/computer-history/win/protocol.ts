import { z } from "zod";
import { checkpointId, checkpointTime } from "../core/recorder-checkpoint.js";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const time = z.number().finite().nonnegative();
const decimal = z.string().regex(/^[1-9][0-9]*$/u).max(20).refine((value) => BigInt(value) <= 0xffffffffffffffffn);
const key = z.string().regex(/^[0-9a-f]{16}$/u);
const code = z.string().regex(/^[a-z0-9_]+$/u).max(80);
const controlType = z.enum(["Button", "Calendar", "CheckBox", "ComboBox", "Edit", "Hyperlink", "Image",
  "ListItem", "List", "Menu", "MenuBar", "MenuItem", "ProgressBar", "RadioButton", "ScrollBar",
  "Slider", "Spinner", "StatusBar", "Tab", "TabItem", "Text", "ToolBar", "ToolTip", "Tree", "TreeItem",
  "Custom", "Group", "Thumb", "DataGrid", "DataItem", "Document", "SplitButton", "Window", "Pane",
  "Header", "HeaderItem", "Table", "TitleBar", "Separator", "SemanticZoom", "AppBar"]);
const nodeSchema = z.object({ key, parentKey: key.nullable(), runtimeId: z.string().max(512), controlType,
  automationId: z.string().max(256), depth: count.max(64), focused: z.boolean(), providerOffscreen: z.boolean(),
  className: z.string().max(256).optional(),
  password: z.boolean().nullable(), redaction: z.enum(["sensitive_id", "password", "edit_control", "unknown_password", "unknown_password_structural"]).optional(),
  documentStatus: z.enum(["available", "label_only", "read_failed"]).optional(),
  name: z.string().max(20000).optional(), text: z.string().max(20000).optional(),
  visibleText: z.string().max(20000).optional(), value: z.string().max(20000).optional(),
  bounds: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
  missing: z.array(z.enum(["name", "text", "visibleText", "value", "bounds", "runtimeId", "automationId"])).max(7).optional(),
}).strict();
const contextSchema = z.object({ hwnd: decimal, pid: count.min(1).max(0xffffffff), processStart: decimal,
  executable: z.string().min(1).max(32768), dpi: count.max(10000),
  bounds: z.object({ left: z.number().int(), top: z.number().int(), right: z.number().int(), bottom: z.number().int() }).strict(),
  minimized: z.boolean(), title: z.string().max(1024).optional(), generation: count,
}).strict();
const stats = z.object({ visited: count, emitted: count, redacted: count, foreignSkipped: count,
  missingProperties: count, workerElapsedMs: time }).strict();
const actionTime = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u).refine((value) => Number.isFinite(Date.parse(value)));
const navigationKey = /^(?:Control\+)?(?:Alt\+)?(?:Shift\+)?(?:Meta\+)?(?:Backspace|Tab|Enter|Escape|PageUp|PageDown|End|Home|ArrowLeft|ArrowUp|ArrowRight|ArrowDown|Delete|F(?:[1-9]|1[0-2]))$/u;
const shortcutKey = /^(?:Control\+(?:Shift\+)?[ACVXYZSFPTWNLR]|(?:Shift\+)?Meta\+[DELR])$/u;
const actionBase = { timestamp: actionTime, injected: z.boolean() };
const action = z.discriminatedUnion("type", [
  z.object({ ...actionBase, type: z.literal("mouse_click"), button: z.enum(["left", "right"]), x: z.number().int().min(-2147483648).max(2147483647), y: z.number().int().min(-2147483648).max(2147483647) }).strict(),
  z.object({ ...actionBase, type: z.literal("scroll"), direction: z.enum(["up", "down", "left", "right"]), delta: z.number().int().min(-32768).max(32767).refine((value) => value !== 0) }).strict(),
  z.object({ ...actionBase, type: z.literal("key_press"), key: z.string().max(80).refine((value) => navigationKey.test(value) || shortcutKey.test(value)) }).strict(),
  z.object({ ...actionBase, type: z.literal("text_input"), pressCount: z.literal(1), redacted: z.literal(true), unit: z.literal("key_press") }).strict(),
]);
const ok = { status: z.literal("ok"), reason: z.null(), focusKey: key.nullable(), truncated: z.boolean(),
  truncation: z.array(z.enum(["max_nodes", "max_visited", "max_depth", "max_text", "budget_ms", "traversal_error"])).max(6),
  stats, elapsedMs: time, actions: z.array(action).max(64).optional(), actionOverflow: z.boolean().optional() };
const snapshotSchema = z.union([
  z.object({ ...ok, mode: z.literal("full"), nodes: z.array(nodeSchema).max(5000) }).strict(),
  z.object({ ...ok, mode: z.literal("delta"), added: z.array(nodeSchema).max(5000), removed: z.array(key).max(5000), unchangedCount: count.max(5000) }).strict(),
  z.object({ status: z.enum(["blocked", "unavailable"]), reason: code, elapsedMs: time }).strict(),
]);
const segment = z.object({ index: count, file: z.string().max(32768) }).strict();
const counters = z.object({
  triggers: z.object({ accepted: count, coalesced: count, dropped: count, discarded: count, ignoredBackground: count, ignoredPaused: count }).strict(),
  queries: z.object({ started: count, ok: count, blocked: count, unavailable: count, timedOut: count, cancelled: count,
    truncated: count, contextChanged: count, policyChanged: count, unchanged: count, suppressedRepeats: count }).strict(),
  control: z.object({ pauses: count, resumes: count, rejected: count }).strict(),
  hooks: z.object({ callbacks: count, callbackMaxMs: time }).strict(), events: count,
}).strict();
const envelope = { protocol: z.literal("memmy.windows.computer-history"), version: z.literal(1), platform: z.literal("windows"),
  sessionId: z.string().regex(/^[0-9a-f]{32}$/u), sequence: count.min(1),
  timestamp: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u).refine((value) => Number.isFinite(Date.parse(value))),
  monotonicMs: time };
const schema = z.discriminatedUnion("kind", [
  z.object({ ...envelope, kind: z.literal("session.started"),
    collector: z.object({ version: z.string().max(80), pid: count.min(1).max(0xffffffff), testHooks: z.boolean() }).strict(),
    policyRevision: z.string().regex(/^[0-9a-f]{64}$/u),
    options: z.object({ seconds: count.min(1).max(86400), rotateSeconds: count.min(1).max(86400), sampleMs: count.min(200).max(60000),
      inputHooks: z.boolean(), parentPid: count.min(1).max(0xffffffff).nullable() }).strict(), segment: segment.nullable() }).strict(),
  z.object({ ...envelope, kind: z.literal("snapshot"), context: contextSchema.nullable(), snapshot: snapshotSchema,
    trigger: z.object({ kinds: z.array(code).max(32), count }).strict() }).strict(),
  z.object({ ...envelope, kind: z.literal("session.paused"), alreadyPaused: z.boolean() }).strict(),
  z.object({ ...envelope, kind: z.literal("session.resumed"), alreadyRunning: z.boolean() }).strict(),
  z.object({ ...envelope, kind: z.literal("session.checkpoint"), id: checkpointId, captureSequence: count, complete: z.boolean() }).strict(),
  z.object({ ...envelope, kind: z.literal("capture.gap"), code, from: checkpointTime, through: checkpointTime }).strict(),
  z.object({ ...envelope, kind: z.literal("segment.started"), segment, counters }).strict(),
  z.object({ ...envelope, kind: z.literal("error"), code, fatal: z.boolean(), channel: z.enum(["stdout", "file"]).optional() }).strict(),
  z.object({ ...envelope, kind: z.literal("session.stopped"), reason: code, hooksDetached: z.boolean(), counters }).strict(),
]);
export type NativeEvent = z.infer<typeof schema>;
export type NativeNode = z.infer<typeof nodeSchema>;
export type NativeContext = z.infer<typeof contextSchema>;
export type NativeSnapshotEvent = Extract<NativeEvent, { kind: "snapshot" }>;

export function parseNativeEvent(input: unknown): NativeEvent {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error("windows_protocol_invalid");
  return parsed.data;
}

export class NativeStreamReader {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private session: string | null = null;
  private sequence = 0;
  private monotonic = 0;
  constructor(private readonly maxLineBytes = 8 * 1024 * 1024 + 65536) {}
  feed(chunk: Buffer): NativeEvent[] {
    const events: NativeEvent[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset);
      const part = chunk.subarray(offset, end < 0 ? chunk.length : end);
      this.bytes += part.length;
      if (this.bytes > this.maxLineBytes) throw new Error("windows_protocol_line_too_large");
      if (part.length) this.chunks.push(Buffer.from(part));
      if (end < 0) break;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(this.chunks, this.bytes));
        const event = parseNativeEvent(JSON.parse(text));
        if ((this.session && this.session !== event.sessionId) || event.sequence !== this.sequence + 1
            || event.monotonicMs < this.monotonic) throw new Error();
        this.session = event.sessionId;
        this.sequence = event.sequence;
        this.monotonic = event.monotonicMs;
        events.push(event);
      } catch { throw new Error("windows_protocol_invalid"); }
      this.chunks = [];
      this.bytes = 0;
      offset = end + 1;
    }
    return events;
  }
  end(): void {
    if (this.bytes) throw new Error("windows_protocol_incomplete_line");
  }
}
