import crypto from "node:crypto";
import { OperationEvidenceSchema, recordingVideoTime, type OperationEvidence, type OperationEvidenceStep,
  type OperationStructuralLocator, type RecordingEvent, type RecordingFrame, type RecordingSession } from "@memmy/local-api-contracts";
import { redactSensitive } from "../computer-history/core/redaction.js";
import { reusableHumanActions, type JsonRecord } from "../computer-history/core/summarize-history.js";

const actions = new Set(["mouse_click", "key_press", "text_input", "scroll"]);
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
function clean(value: unknown, max = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = redactSensitive(value).replace(/[\r\n\t]+/gu, " ").trim();
  return text && !text.includes("[REDACTED]") ? text.slice(0, max) : undefined;
}
const alignment = { format: "openadapt-flow-1.35.1", upstreamCommit: "6e4e4ed0fe4addedd7c38ced44176b42bc40165a",
  regionFormat: "x_y_width_height" } as const;

export function sameRecordingWindow(a: RecordingEvent["window"], b: RecordingEvent["window"]): boolean {
  if (!a || !b || a.pid !== b.pid || a.processStart !== b.processStart || JSON.stringify(a.bounds) !== JSON.stringify(b.bounds)) return false;
  if ("hwnd" in a && "hwnd" in b) return a.hwnd === b.hwnd && a.dpi === b.dpi && a.executable.toLowerCase() === b.executable.toLowerCase();
  return "windowId" in a && "windowId" in b && a.windowId === b.windowId && a.bundleId === b.bundleId && a.scale === b.scale && a.executable === b.executable;
}

export function recordingActionEvents(events: RecordingEvent[]): RecordingEvent[] {
  return events.filter((event) => event.origin === "native" && actions.has(event.type))
    .sort((a, b) => a.timeMs - b.timeMs || a.sequence - b.sequence);
}

export function recordingFramePair(event: RecordingEvent, frames: RecordingFrame[], session: RecordingSession) {
  const before = frames.findLast((frame) => !frame.repeated && frame.timeMs <= event.timeMs);
  const after = frames.find((frame) => !frame.repeated && frame.timeMs > event.timeMs);
  let missing: string | null = null;
  if (!before || !after || event.timeMs - before.timeMs > 200 || after.timeMs - event.timeMs > 200) missing = "necessary_frame_missing";
  else if (before.blank || after.blank || !sameRecordingWindow(before.window, after.window)
    || !sameRecordingWindow(before.window, event.window)) missing = "frame_identity_mismatch";
  else if (session.gaps.some((gap) => gap.startMs <= after.timeMs && gap.endMs >= before.timeMs)) missing = "frame_crosses_gap";
  return { before, after, missing };
}

/** OpenAdapt's Region and click_point use canvas pixels, never desktop coordinates. */
export function recordingCanvasPoint(event: RecordingEvent, frame: RecordingFrame, width: number, height: number): [number, number] | null {
  const { x, y } = event.action ?? {}, transform = frame.transform;
  if (typeof x !== "number" || typeof y !== "number" || !transform || frame.blank || !sameRecordingWindow(event.window, frame.window)) return null;
  const sx = x - transform.sourceLeft, sy = y - transform.sourceTop;
  if (sx < 0 || sy < 0 || sx >= transform.sourceWidth || sy >= transform.sourceHeight) return null;
  const point: [number, number] = [Math.round(transform.offsetX + sx * transform.scale), Math.round(transform.offsetY + sy * transform.scale)];
  return point[0] >= 0 && point[1] >= 0 && point[0] < width && point[1] < height ? point : null;
}

function emptyStep(id: string, eventIds: string[], action: OperationEvidenceStep["action"]): OperationEvidenceStep {
  return { id, intent: `Observed ${action}; intended business outcome requires review.`, action, text: null, param: null, field_label: null,
    anchor: null, expect: [], evidence: { eventIds, timestamp: null, timeMs: null, application: null, window: null,
      before: null, after: null, targetBasis: "unavailable", targetCandidates: [], observationBeforeId: null, observationAfterId: null,
      effectStatus: "unavailable", executionVerified: false, targetTemplate: null, visualChange: null, missing: [] } };
}

function actionKind(type: string, button?: string, key?: string): OperationEvidenceStep["action"] {
  return type === "mouse_click" ? button === "right" ? "right_click" : "click"
    : type === "text_input" ? "type" : type === "scroll" ? "scroll" : key?.includes("+") ? "hotkey" : "key";
}

function retainKey(step: OperationEvidenceStep, key: string | undefined): void {
  key = clean(key, 80);
  if (!key) { step.evidence.missing.push("key_not_retained"); return; }
  const pieces = key.split("+"), last = pieces.pop()!;
  const modifiers: Record<string, string> = { Control: "ctrl", Alt: "alt", Shift: "shift", Meta: "win", Command: "cmd", Option: "alt",
    control: "ctrl", ctrl: "ctrl", alt: "alt", shift: "shift", meta: "win", cmd: "cmd", command: "cmd", option: "alt" };
  if (!last || pieces.some((piece) => !modifiers[piece])) { step.evidence.missing.push("unsupported_key"); return; }
  const aliases: Record<string, string> = { return: "Enter", enter: "Enter", tab: "Tab", escape: "Escape", delete: "Backspace",
    backspace: "Backspace", space: "Space", left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown" };
  const resolved = aliases[last] ?? last;
  const mappedModifiers = pieces.map((piece) => modifiers[piece]);
  if (!/^(?:Enter|Tab|Escape|Backspace|Delete|Space|Home|End|PageUp|PageDown|Arrow(?:Left|Right|Up|Down)|F(?:[1-9]|1[0-9]|2[0-4]))$/u.test(resolved)
    && !(resolved.length === 1 && mappedModifiers.some((modifier) => ["ctrl", "cmd", "win"].includes(modifier)))) {
    step.evidence.missing.push("unsupported_key"); return;
  }
  step.key = resolved;
  if (pieces.length) step.modifiers = pieces.map((piece) => modifiers[piece]);
  if (step.key.toLowerCase() === "v" && step.modifiers?.some((modifier) => modifier === "ctrl" || modifier === "cmd")) {
    step.evidence.missing.push("clipboard_value_not_retained");
  }
}

function frameReference(frame: RecordingFrame | undefined, session: RecordingSession) {
  return frame ? { index: frame.index, timeMs: frame.timeMs, videoTimeMs: frame.videoTimeMs ?? recordingVideoTime(frame.timeMs, session.idleSpans),
    partId: frame.partId, partFrame: frame.partFrame, ticks: frame.qpc ?? frame.monotonicTicks ?? null, sourceTicks: frame.sourceTicks ?? null } : null;
}

function structuralTarget(event: RecordingEvent, observation: RecordingEvent | undefined): OperationStructuralLocator | null {
  if (!observation?.observation || observation.observation.truncated) return null;
  const { x, y } = event.action ?? {};
  const nodes = observation.observation.nodes.filter((node) => {
    if (!node.name && !node.automation_id) return false;
    if (event.type !== "mouse_click") return node.focused;
    return typeof x === "number" && typeof y === "number" && node.bounds
      && x >= node.bounds[0] && y >= node.bounds[1] && x < node.bounds[0] + node.bounds[2] && y < node.bounds[1] + node.bounds[3];
  }).sort((a, b) => (a.bounds ? a.bounds[2] * a.bounds[3] : Infinity) - (b.bounds ? b.bounds[2] * b.bounds[3] : Infinity));
  const node = nodes[0];
  if (!node || (nodes.length > 1 && (event.type !== "mouse_click"
    || !node.bounds || !nodes[1]!.bounds || node.bounds[2] * node.bounds[3] === nodes[1]!.bounds![2] * nodes[1]!.bounds![3]))) return null;
  const name = clean(node.name), automation_id = clean(node.automation_id, 256);
  if (observation.observation.nodes.filter((candidate) => candidate.role === node.role
    && (!automation_id || clean(candidate.automation_id, 256) === automation_id)
    && (!name || clean(candidate.name) === name)).length !== 1) return null;
  return name || automation_id ? { role: node.role, ...(name ? { name } : {}), ...(automation_id ? { automation_id } : {}) } : null;
}

export function buildRecordingOperationEvidence(input: { session: RecordingSession; events: RecordingEvent[]; frames: RecordingFrame[];
  eventsText?: string; framesText?: string }): OperationEvidence {
  const { session, events, frames } = input;
  if (frames.some((frame, index) => frame.index !== index || (index > 0 && frame.timeMs <= frames[index - 1]!.timeMs))) {
    throw new Error("operation_evidence_frame_index_invalid");
  }
  const actionEvents = recordingActionEvents(events);
  if (actionEvents.length > 1000) throw new Error("operation_evidence_action_limit_exceeded");
  const observations = events.filter((event) => event.observation).sort((a, b) => a.timeMs - b.timeMs || a.sequence - b.sequence);
  const width = session.video?.width ?? 1920, height = session.video?.height ?? 1080;
  const steps = actionEvents.map((event, index) => {
    const step = emptyStep(`step-${String(index + 1).padStart(4, "0")}`, [event.id], actionKind(event.type, event.action?.button, event.action?.key));
    const e = step.evidence;
    Object.assign(e, { timestamp: event.timestamp, timeMs: event.timeMs, window: event.window,
      application: event.window ? "bundleId" in event.window ? event.window.bundleId : event.window.executable : null });
    const pair = recordingFramePair(event, frames, session);
    if (pair.missing) e.missing.push(pair.missing);
    // Invalid/blank/repeated evidence never becomes an anchor or a postcondition.
    if (!pair.missing) { e.before = frameReference(pair.before, session); e.after = frameReference(pair.after, session); }
    const next = actionEvents[index + 1], previous = actionEvents[index - 1];
    const observationFits = (row: RecordingEvent) => sameRecordingWindow(row.window, event.window)
      && !session.gaps.some((gap) => gap.startMs <= Math.max(row.timeMs, event.timeMs) && gap.endMs >= Math.min(row.timeMs, event.timeMs));
    const before = observations.findLast((row) => row.timeMs <= event.timeMs && event.timeMs - row.timeMs <= 200
      && (!previous || row.timeMs > previous.timeMs) && observationFits(row));
    const after = observations.find((row) => row.timeMs > event.timeMs && row.timeMs - event.timeMs <= 200
      && (!next || row.timeMs < next.timeMs) && observationFits(row));
    e.observationBeforeId = before?.id ?? null; e.observationAfterId = after?.id ?? null;
    const structural = structuralTarget(event, before);
    if (structural) e.targetCandidates.push({ basis: "pre_action_uia", structural });
    const point = !pair.missing && pair.before ? recordingCanvasPoint(event, pair.before, width, height) : null;
    if (event.type === "mouse_click" || structural) {
      step.anchor = { structural, template: null, region: null, click_point: point, ocr_text: null, landmarks: [] };
      e.targetBasis = structural ? "pre_action_uia" : point ? "visual_point" : "unavailable";
    }
    if (structural?.name) step.intent = `${step.action} ${JSON.stringify(structural.name)}; verify the resulting application state.`;
    if (!structural) e.missing.push("structural_target_unavailable");
    if (step.anchor) e.missing.push("ocr_not_extracted", "landmarks_not_extracted");
    if (event.type === "text_input") { e.missing.push("text_not_retained", "parameter_binding_required"); step.field_label = structural?.name ?? null; }
    if (event.type === "key_press") retainKey(step, event.action?.key);
    if (event.type === "scroll") {
      const magnitude = Math.round(Math.abs(event.action?.delta ?? 0) * (event.action?.deltaUnit === "pixels" ? 1 : 100 / 120));
      step.scroll_dx = event.action?.direction === "left" ? -magnitude : event.action?.direction === "right" ? magnitude : 0;
      step.scroll_dy = event.action?.direction === "up" ? -magnitude : event.action?.direction === "down" ? magnitude : 0;
      e.missing.push("scroll_outcome_requires_next_target");
    }
    if (before?.observation && after?.observation && !before.observation.truncated && !after.observation.truncated
      && event.type !== "scroll" && event.type !== "text_input") {
      const names = (row: RecordingEvent) => new Set(row.observation!.nodes.map((node) => clean(node.name)).filter((name): name is string => !!name));
      const oldNames = names(before), newNames = names(after);
      step.expect = [...[...newNames].filter((name) => !oldNames.has(name)).slice(0, 8).map((text) => ({ kind: "text_present" as const, text })),
        ...[...oldNames].filter((name) => !newNames.has(name)).slice(0, 8).map((text) => ({ kind: "text_absent" as const, text }))];
      if (step.expect.length) e.effectStatus = "candidate";
    }
    if (next && pair.after && pair.after.timeMs >= next.timeMs) e.missing.push("after_frame_contains_later_action");
    e.missing.push("business_effect_unverified");
    if (!step.expect.length) e.missing.push("postcondition_unavailable");
    return step;
  });
  return OperationEvidenceSchema.parse({ schemaVersion: 1, status: "candidate", source: { kind: "task_recording", id: session.id,
    eventsSha256: digest(input.eventsText ?? JSON.stringify(events)), framesSha256: digest(input.framesText ?? JSON.stringify(frames)),
    clock: session.clock ?? (session.qpc ? { kind: "qpc", ...session.qpc } : null) },
    alignment: { ...alignment, coordinateSpace: "recorded_canvas_pixels" }, executionAdmission: "not_admitted", replayable: false, assets: [], steps,
    unresolvedEvents: events.filter((event) => event.origin === "ocu" || (event.origin === "native" && !actions.has(event.type) && !event.observation)
      || /incomplete|overflow|unsupported/u.test(event.type)).map((event) => ({ eventId: event.id, type: event.type,
      reason: event.origin === "ocu" ? "tool_arguments_and_result_not_retained" : "unsupported_or_incomplete_input" })),
    missing: [...(!steps.length ? ["no_supported_actions"] : []), ...(session.videoIntegrity !== "complete" ? ["video_incomplete"] : []),
      ...(session.timelineCompleteness !== "complete" ? ["input_timeline_incomplete"] : [])] });
}

/** Legacy History keeps its policy: metadata only, with no invented screenshots or effects. */
export function buildHistoryOperationEvidence(input: { records: JsonRecord[]; sourceId: string; eventsText?: string }): OperationEvidence {
  const humanEvents = input.records.filter((record) => record.recordType === "human_event");
  const steps: OperationEvidenceStep[] = [];
  const unresolvedEvents: OperationEvidence["unresolvedEvents"] = [];
  const items = humanEvents.flatMap((event, index) => event.eventType === "key_press" && Array.isArray(event.details?.keys) && event.details.keys.length
    ? event.details.keys.map((key: unknown) => ({ event, index, key: typeof key === "string" ? key : undefined }))
    : [{ event, index, key: undefined as string | undefined }]);
  for (const { index, event, key } of items) {
    const eventId = `${input.sourceId}:${typeof event.sequence === "number" ? event.sequence : index + 1}`;
    if (!actions.has(event.eventType)) {
      if (!["recording_started", "recording_stopped", "accessibility_snapshot"].includes(event.eventType)) {
        unresolvedEvents.push({ eventId, type: clean(event.eventType, 100) ?? "unknown", reason: "context_event_not_an_executable_action" });
      }
      continue;
    }
    const details = event.details ?? {};
    const step = emptyStep(`step-${String(steps.length + 1).padStart(4, "0")}`, [eventId], actionKind(event.eventType, details.button, key));
    if (event.eventType !== "text_input") step.intent = (reusableHumanActions([event])[0] ?? step.intent).slice(0, 1000);
    step.evidence.timestamp = clean(event.timestamp, 100) ?? null;
    step.evidence.application = clean(event.application?.id ?? event.application?.bundleId ?? event.application?.executable, 500) ?? null;
    // Hook snapshots are acquired after input. They cannot identify its target.
    const ax = details.source !== "low_level_hook" ? details.accessibility : undefined;
    const locator = (node: JsonRecord | undefined): OperationStructuralLocator | null => {
      if (!node || node.redacted || node.redaction || node.password === true || /password|secure/iu.test(String(node.role ?? ""))) return null;
      const role = clean(node.role, 80), name = clean(node.title ?? node.description), automation_id = clean(node.identifier, 256);
      return name || automation_id ? { ...(role ? { role } : {}), ...(name ? { name } : {}), ...(automation_id ? { automation_id } : {}) } : null;
    };
    if (ax && !ax.redaction && !ax.redacted && ax.password !== true) {
      const candidates: Array<{ node: JsonRecord | undefined; basis: OperationEvidenceStep["evidence"]["targetCandidates"][number]["basis"] }> = [
        { node: ax, basis: "hit_test" }, { node: ax.focused, basis: "focused_context" },
        ...(Array.isArray(ax.descendants) ? ax.descendants.slice(0, 8).map((node: JsonRecord) => ({ node, basis: "descendant_context" as const })) : []),
        ...(Array.isArray(ax.ancestors) ? ax.ancestors.slice(0, 6).map((node: JsonRecord) => ({ node, basis: "ancestor_context" as const })) : []),
      ];
      for (const candidate of candidates) {
        const structural = locator(candidate.node);
        if (structural) step.evidence.targetCandidates.push({ basis: candidate.basis, structural });
      }
    }
    // Legacy focused/descendant nodes are post-action context. Preserve them,
    // but never promote them into the structural target used for a click.
    const structural = event.eventType === "mouse_click" && /^(?:AX)?(?:Button|RadioButton|CheckBox|PopUpButton|TextField|TextArea|ComboBox|Link|MenuItem|TabButton|Slider|Incrementor|SearchField)$/u.test(String(ax?.role ?? ""))
      ? locator(ax) : null;
    if (structural) {
      step.anchor = { structural, template: null, region: null, click_point: null, ocr_text: null, landmarks: [] };
      step.evidence.targetBasis = "action_accessibility";
    } else if (ax) step.intent = `Observed ${step.action}; retained accessibility context does not verify its target.`;
    if (event.eventType === "key_press") retainKey(step, key);
    if (event.eventType === "key_press" && step.key) step.intent = `Press ${[...(step.modifiers ?? []), step.key].join("+")}; verify the resulting state.`;
    if (event.eventType === "text_input") {
      step.field_label = step.evidence.targetCandidates.find((candidate) => candidate.basis === "focused_context")?.structural.name ?? null;
      step.evidence.missing.push("parameter_binding_required");
    }
    if (!step.anchor) step.evidence.missing.push("structural_target_unavailable");
    step.evidence.missing.push("video_frames_unavailable", "postcondition_unavailable", "business_effect_unverified");
    steps.push(step);
  }
  return OperationEvidenceSchema.parse({ schemaVersion: 1, status: "candidate", source: { kind: "computer_history", id: input.sourceId,
    eventsSha256: digest(input.eventsText ?? JSON.stringify(input.records)), framesSha256: null, clock: null },
    alignment: { ...alignment, coordinateSpace: "unavailable" }, executionAdmission: "not_admitted", replayable: false,
    assets: [], steps, unresolvedEvents, missing: [...(!steps.length ? ["no_supported_actions"] : []), "video_frames_unavailable"] });
}
