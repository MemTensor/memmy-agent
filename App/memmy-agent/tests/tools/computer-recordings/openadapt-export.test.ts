import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { convertFlowAction } from "../../../src/tools/computer-recordings/openadapt-export.js";
import { flowFixture, sampleEvent, sampleFrames, sampleSession } from "./flow-fixture.js";
import type { RecordingFrame } from "@memmy/local-api-contracts";
const roots: string[] = [];
const root = () => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-flow-export-")); roots.push(directory); return directory; };
afterEach(() => { for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
describe("OpenAdapt Flow export", () => {
  it("writes the real upstream layout with verified frames and no execution admission", async () => {
    const { destination, missing, extractions } = await flowFixture(root());
    expect(missing).toEqual([]); expect(extractions).toBe(1);
    const events = fs.readFileSync(path.join(destination, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toEqual([{ i: 0, kind: "click", x: 10, y: 20, t: 0.1, viewport_before: [64, 64], viewport_after: [64, 64] }]);
    const manifest = JSON.parse(fs.readFileSync(path.join(destination, "memmy-export-manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ complete: true, replayable: false, executionAdmission: "not_admitted", target: "openadapt-flow-1.35.1" });
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(destination, "openadapt-flow.zip")));
    expect(zip.file("frames/0000_before.png")).not.toBeNull(); expect(zip.file("frames/0000_after.png")).not.toBeNull(); expect(zip.file("recording.db")).toBeNull();
  });
  it("converts physical coordinates using the retained source-to-canvas transform", () => {
    const frame = { ...sampleFrames[0]!, transform: { ...sampleFrames[0]!.transform!, offsetX: 40, offsetY: 20, scale: 0.5 } };
    expect(convertFlowAction(sampleEvent, frame, 1920, 1080)).toEqual({ kind: "click", x: 45, y: 30 });
    expect(() => convertFlowAction({ ...sampleEvent, action: { x: 0, y: 0 } }, frame, 1920, 1080)).toThrow("coordinate_outside_window");
  });
  it("maps keys and wheel units explicitly", () => {
    expect(convertFlowAction({ ...sampleEvent, type: "key_press", action: { key: "Control+Shift+A" } }, sampleFrames[0]!, 64, 64))
      .toEqual({ kind: "hotkey", modifiers: ["ctrl", "shift"], key: "A" });
    expect(convertFlowAction({ ...sampleEvent, type: "scroll", action: { direction: "up", delta: 120 } }, sampleFrames[0]!, 64, 64)).toEqual({ kind: "scroll", dx: 0, dy: -100 });
  });
  it("maps macOS point coordinates, Command shortcuts and pixel scrolling without Windows unit assumptions", async () => {
    const window = { platform: "macos" as const, pid: 123, windowId: 55, processStart: "1770000000123456", bundleId: "test.memmy.Editor",
      executable: "/Applications/Editor.app/Contents/MacOS/Editor", scale: 2, bounds: { left: -1200, top: 100, right: -1168, bottom: 132 } };
    const frame: RecordingFrame = { ...sampleFrames[0]!, qpc: undefined, monotonicTicks: "100095000000", sourceTicks: "100095000000", repeated: false, window,
      transform: { sourceWidth: 32, sourceHeight: 32, offsetX: 0, offsetY: 0, scale: 2, sourceLeft: -1200, sourceTop: 100 } };
    const event = { ...sampleEvent, qpc: undefined, monotonicTicks: "100100000000", window, action: { button: "left" as const, x: -1190, y: 120 } };
    expect(convertFlowAction(event, frame, 64, 64)).toEqual({ kind: "click", x: 20, y: 40 });
    expect(convertFlowAction({ ...event, type: "key_press", action: { key: "Command+Shift+a" } }, frame, 64, 64)).toEqual({ kind: "hotkey", modifiers: ["cmd", "shift"], key: "a" });
    expect(convertFlowAction({ ...event, type: "scroll", action: { deltaUnit: "pixels", direction: "up", delta: 24 } }, frame, 64, 64)).toEqual({ kind: "scroll", dx: 0, dy: -24 });
    const session = { ...sampleSession, platform: "macos" as const, qpc: null, clock: { kind: "mach_host" as const, origin: "100000000000", frequency: "1000000000" } };
    const { destination, missing } = await flowFixture(root(), [event], [frame, { ...frame, index: 1, timeMs: 110, partFrame: 1, monotonicTicks: "100110000000", sourceTicks: "100110000000" }], session);
    expect(missing).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(destination, "memmy-export-manifest.json"), "utf8"))).toMatchObject({ platform: "macos", clock: session.clock, qpc: null });
  });
  it("refuses repeated display frames as fresh after-action evidence", async () => {
    const frames = [sampleFrames[0]!, { ...sampleFrames[1]!, repeated: true, sourceTicks: "100000000000" }];
    const { missing, destination, extractions } = await flowFixture(root(), [sampleEvent], frames);
    expect(missing).toContain(`${sampleEvent.id}:necessary_frame_missing`); expect(extractions).toBe(0);
    expect(fs.readFileSync(path.join(destination, "events.jsonl"), "utf8")).toBe("");
  });
  it.each(["text", "missing_frame", "gap", "identity", "overflow", "unsupported"])("produces an explicit evidence package for %s without shortening the executable trace", async (failure) => {
    let events = [sampleEvent], frames = sampleFrames, session = sampleSession;
    if (failure === "text") events = [...events, { ...sampleEvent, id: "example:2", sequence: 2, type: "text_input", action: { pressCount: 1, redacted: true } }];
    if (failure === "missing_frame") frames = [sampleFrames[0]!];
    if (failure === "gap") session = { ...session, gaps: [{ startMs: 98, endMs: 102, reason: "unauthorized" }] };
    if (failure === "identity") frames = [sampleFrames[0]!, { ...sampleFrames[1]!, window: { ...sampleFrames[1]!.window!, processStart: "134000000000000001" } }];
    if (failure === "overflow") session = { ...session, timelineCompleteness: "partial" };
    if (failure === "unsupported") events = [...events, { ...sampleEvent, id: "example:2", sequence: 2, origin: "control", type: "unsupported_input" }];
    const { destination, missing, extractions } = await flowFixture(root(), events, frames, session);
    expect(missing.length).toBeGreaterThan(0); expect(extractions).toBe(0);
    expect(fs.readFileSync(path.join(destination, "events.jsonl"), "utf8")).toBe("");
    expect(fs.readFileSync(path.join(destination, "memmy-source-events.jsonl"), "utf8").trim().split("\n")).toHaveLength(events.length);
    expect(JSON.parse(fs.readFileSync(path.join(destination, "memmy-export-manifest.json"), "utf8"))).toMatchObject({ complete: false, replayable: false });
  });
});
