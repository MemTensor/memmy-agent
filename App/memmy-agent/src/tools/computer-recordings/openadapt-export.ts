import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import JSZip from "jszip";
import crypto from "node:crypto";
import { OperationEvidenceSchema, RecordingFrameSchema, type RecordingEvent, type RecordingFrame, type RecordingSession } from "@memmy/local-api-contracts";
import { readLines, writeJsonAtomic, RecordingError } from "./session-service.js";
import { buildRecordingOperationEvidence, recordingActionEvents, recordingFramePair, sameRecordingWindow } from "../computer-use/operation-evidence.js";
import { enrichOperationVisualEvidence } from "./operation-visual-evidence.js";

export function convertFlowAction(event: RecordingEvent, frame: RecordingFrame, width: number, height: number): Record<string, unknown> {
  if (!sameRecordingWindow(event.window, frame.window) || !frame.transform || frame.blank) throw new Error("unverified_window");
  const action = event.action;
  if (event.type === "text_input") throw new Error("text_not_retained");
  if (event.type === "key_press" && action?.key) {
    const pieces = action.key.split("+");
    const key = pieces.pop()!;
    const names: Record<string, string> = { Control: "ctrl", Alt: "alt", Shift: "shift", Meta: "win", Command: "cmd", Option: "alt" };
    if (pieces.some((item) => !names[item])) throw new Error("unsupported_key");
    return pieces.length ? { kind: "hotkey", modifiers: pieces.map((item) => names[item]), key } : { kind: "key", key };
  }
  if (event.type === "scroll" && action?.delta && action.direction) {
    const magnitude = action.deltaUnit === "pixels" ? Math.abs(action.delta) : Math.abs(action.delta) / 120 * 100;
    return { kind: "scroll", dx: action.direction === "left" ? -magnitude : action.direction === "right" ? magnitude : 0,
      dy: action.direction === "up" ? -magnitude : action.direction === "down" ? magnitude : 0 };
  }
  if (event.type === "mouse_click" && action && typeof action.x === "number" && typeof action.y === "number") {
    const transform = frame.transform;
    const sx = action.x - transform.sourceLeft, sy = action.y - transform.sourceTop;
    if (sx < 0 || sy < 0 || sx >= transform.sourceWidth || sy >= transform.sourceHeight) throw new Error("coordinate_outside_window");
    const x = Math.round(transform.offsetX + sx * transform.scale), y = Math.round(transform.offsetY + sy * transform.scale);
    if (x < 0 || y < 0 || x >= width || y >= height) throw new Error("coordinate_outside_canvas");
    return { kind: action.button === "right" ? "right_click" : "click", x, y };
  }
  throw new Error("unsupported_action");
}
export async function exportOpenAdaptFlow(input: {
  directory: string; destination: string; session: RecordingSession; events: RecordingEvent[]; extract: () => Promise<void>;
}): Promise<string[]> {
  const { directory, destination, session, events } = input;
  const frames = fs.existsSync(path.join(directory, "frames.jsonl")) ? readLines(path.join(directory, "frames.jsonl"), (value) => RecordingFrameSchema.parse(value)) : [];
  const evidence = buildRecordingOperationEvidence({ session, events, frames,
    eventsText: events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    framesText: fs.existsSync(path.join(directory, "frames.jsonl")) ? fs.readFileSync(path.join(directory, "frames.jsonl"), "utf8") : "" });
  const missing: string[] = [];
  const converted: Record<string, unknown>[] = [];
  const requests: { i: number; phase: "before" | "after"; frameId: number; partId: string; partFrame: number }[] = [];
  const provenance: Record<string, unknown>[] = [];
  if (session.videoIntegrity !== "complete") missing.push("video_incomplete");
  if (session.timelineCompleteness !== "complete") missing.push("input_timeline_incomplete");
  if (events.some((event) => event.type === "unsupported_input")) missing.push("unsupported_native_actions");
  if (evidence.unresolvedEvents.some((event) => event.reason === "unsupported_or_incomplete_input")
    && !missing.includes("unsupported_native_actions")) missing.push("unsupported_native_actions");
  const nativeEvents = recordingActionEvents(events);
  if (!nativeEvents.length) missing.push("no_supported_native_actions");
  if (nativeEvents.length > 1000) throw new RecordingError(422, "export_action_limit_exceeded");
  const width = session.video?.width ?? 1920, height = session.video?.height ?? 1080;
  for (const event of nativeEvents) {
    const { before, after, missing: frameError } = recordingFramePair(event, frames, session);
    try {
      if (frameError || !before || !after) throw new Error(frameError ?? "necessary_frame_missing");
      const action = convertFlowAction(event, before, width, height);
      const step = evidence.steps.find((step) => step.evidence.eventIds.includes(event.id));
      if (step?.anchor?.structural) action.structural = step.anchor.structural;
      const i = converted.length;
      converted.push({ i, ...action, t: event.timeMs / 1000, viewport_before: [width, height], viewport_after: [width, height] });
      requests.push({ i, phase: "before", frameId: before.index, partId: before.partId, partFrame: before.partFrame },
        { i, phase: "after", frameId: after.index, partId: after.partId, partFrame: after.partFrame });
      provenance.push({ eventId: event.id, flowIndex: i, beforeFrame: before.index, afterFrame: after.index });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "conversion_failed";
      missing.push(`${event.id}:${reason}`); provenance.push({ eventId: event.id, refused: reason });
    }
  }
  // A package with omitted actions is evidence, never a shortened executable demonstration.
  const complete = missing.length === 0;
  writeJsonAtomic(path.join(destination, "meta.json"), { id: session.id.replaceAll("-", ""), created_at: session.createdAt,
    viewport: [width, height], coordinate_space: "window_pixels", app_url: null, params: {}, secret_params: [], memmy_complete: complete });
  fs.writeFileSync(path.join(destination, "events.jsonl"), complete ? converted.map((event) => JSON.stringify(event)).join("\n") + "\n" : "", { flag: "wx", mode: 0o600 });
  fs.writeFileSync(path.join(destination, "memmy-source-events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  writeJsonAtomic(path.join(destination, "memmy-export-manifest.json"), {
    schemaVersion: 1, sourceRecordingId: session.id, sourceFormat: "memmy-task-recording-v1", target: "openadapt-flow-1.35.1",
    upstreamCommit: "6e4e4ed0fe4addedd7c38ced44176b42bc40165a", complete, executionAdmission: "not_admitted", replayable: false,
    videoIntegrity: session.videoIntegrity, timelineCompleteness: session.timelineCompleteness, taskEndReason: session.taskEndReason,
    coordinateSpace: "window_pixels", missing, conversions: provenance, gaps: session.gaps,
    qpc: session.qpc, clock: session.clock ?? (session.qpc ? { kind: "qpc", ...session.qpc } : null), platform: session.platform, sourceParts: session.parts,
    idleSpans: session.idleSpans ?? [], sourceTimeMeaning: "elapsed execution time; video presentation time omits idle spans",
    sourceEventsSha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(destination, "memmy-source-events.jsonl"))).digest("hex"),
    afterFrameMeaning: "next verified sampled frame; not a settled-state or business-success assertion",
  });
  let templates: string[] = [];
  if (complete && requests.length) {
    writeJsonAtomic(path.join(destination, "frame-requests.json"), requests);
    await input.extract();
    for (const request of requests) {
      const file = path.join(destination, "frames", `${String(request.i).padStart(4, "0")}_${request.phase}.png`);
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error("export_frame_invalid");
      const fd = fs.openSync(file, "r");
      const header = Buffer.alloc(24);
      try { if (fs.readSync(fd, header, 0, 24, 0) !== 24) throw new Error(); } finally { fs.closeSync(fd); }
      if (header.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || header.readUInt32BE(16) !== width || header.readUInt32BE(20) !== height) throw new Error("export_frame_invalid");
    }
    templates = enrichOperationVisualEvidence({ evidence, directory: destination, width, height,
      assets: provenance.filter((item) => typeof item.flowIndex === "number").map((item) => ({ eventId: String(item.eventId), i: Number(item.flowIndex) })) });
  }
  writeJsonAtomic(path.join(destination, "operation-evidence.json"), OperationEvidenceSchema.parse(evidence));
  const archive = new JSZip();
  for (const name of ["meta.json", "events.jsonl", "memmy-source-events.jsonl", "memmy-export-manifest.json", "operation-evidence.json", ...templates]) archive.file(name, fs.createReadStream(path.join(destination, name)));
  if (complete) for (const request of requests) {
    const name = `frames/${String(request.i).padStart(4, "0")}_${request.phase}.png`;
    archive.file(name, fs.createReadStream(path.join(destination, name)));
  }
  await pipeline(archive.generateNodeStream({ streamFiles: true, compression: "STORE" }), fs.createWriteStream(path.join(destination, "openadapt-flow.zip"), { flags: "wx", mode: 0o600 }));
  return missing;
}
