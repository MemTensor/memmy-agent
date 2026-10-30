import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { RecordingSessionSchema, type RecordingEvent, type RecordingFrame } from "@memmy/local-api-contracts";
import { exportOpenAdaptFlow } from "../../../src/tools/computer-recordings/openadapt-export.js";
const { PNG } = createRequire(import.meta.url)("pngjs");
export const windowIdentity = { hwnd: "1234", pid: 100, processStart: "134000000000000000", executable: "C:\\Apps\\Fixture.exe", dpi: 96,
  bounds: { left: 100, top: 200, right: 164, bottom: 264 } };
export const sampleEvent: RecordingEvent = { id: "example:1", sequence: 1, timeMs: 100, timestamp: "2026-10-13T00:00:00.100Z", origin: "native",
  qpc: "1001000", window: windowIdentity, type: "mouse_click", injected: false, action: { x: 110, y: 220, button: "left" } };
export const sampleFrames: RecordingFrame[] = [95, 150].map((timeMs, index) => ({ index, timeMs, qpc: String(1000000 + timeMs * 10), partId: "part-000001", partFrame: index,
  window: windowIdentity, blank: false, transform: { sourceWidth: 64, sourceHeight: 64, offsetX: 0, offsetY: 0, scale: 1, sourceLeft: 100, sourceTop: 200 } }));
export const sampleSession = RecordingSessionSchema.parse({ schemaVersion: 1, id: "2e887c14-ef13-48f3-b9b1-2efbc1e89537", title: "Controlled fixture", platform: "windows",
  source: "human", state: "ready", createdAt: "2026-10-13T00:00:00Z", stoppedAt: "2026-10-13T00:00:01Z", durationMs: 1000,
  applications: [windowIdentity.executable], agent: null, pinned: false, videoIntegrity: "complete", timelineCompleteness: "complete", taskEndReason: "user_stopped", error: null,
  qpc: { origin: "1000000", frequency: "10000" }, video: { mediaId: "recording", width: 64, height: 64, fps: 15, audio: false },
  parts: [], gaps: [], privacy: { rawVisibleFrames: true, audio: false, localOnly: true, retentionHours: 48 } });
export async function flowFixture(root: string, events: RecordingEvent[] = [sampleEvent], frames = sampleFrames,
  session = sampleSession) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "frames.jsonl"), frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n");
  const destination = path.join(root, "flow"); fs.mkdirSync(destination);
  let extractions = 0;
  const missing = await exportOpenAdaptFlow({ directory: root, destination, session, events, extract: async () => {
    extractions++;
    const requests = JSON.parse(fs.readFileSync(path.join(destination, "frame-requests.json"), "utf8"));
    fs.mkdirSync(path.join(destination, "frames"));
    for (const request of requests) {
      const png = new PNG({ width: 64, height: 64 });
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
        const offset = (y * 64 + x) * 4;
        const shade = ((x >> 3) + (y >> 3)) % 2 ? 220 : 35;
        png.data[offset] = shade; png.data[offset + 1] = shade; png.data[offset + 2] = shade; png.data[offset + 3] = 255;
      }
      fs.writeFileSync(path.join(destination, "frames", `${String(request.i).padStart(4, "0")}_${request.phase}.png`), PNG.sync.write(png));
    }
  } });
  return { destination, missing, extractions };
}
export async function macFlowFixture(root: string) {
  const window = { platform: "macos" as const, pid: 123, windowId: 55, processStart: "1770000000123456", bundleId: "test.memmy.Editor",
    executable: "/Applications/Editor.app/Contents/MacOS/Editor", scale: 2, bounds: { left: -1200, top: 100, right: -1168, bottom: 132 } };
  const clock = { kind: "mach_host" as const, origin: "100000000000", frequency: "1000000000" };
  const ticks = (timeMs: number) => String(BigInt(clock.origin) + BigInt(timeMs) * 1_000_000n);
  const frames: RecordingFrame[] = [95, 150, 195, 250, 295, 350].map((timeMs, index) => ({ index, timeMs, monotonicTicks: ticks(timeMs), sourceTicks: ticks(timeMs),
    repeated: false, partId: "part-000001", partFrame: index, window, blank: false,
    transform: { sourceWidth: 32, sourceHeight: 32, offsetX: 0, offsetY: 0, scale: 2, sourceLeft: -1200, sourceTop: 100 } }));
  const actions = [{ type: "mouse_click", action: { button: "left" as const, x: -1190, y: 120 } },
    { type: "key_press", action: { key: "Command+Shift+a", pressCount: 1 } },
    { type: "scroll", action: { deltaUnit: "pixels" as const, delta: 24, direction: "up" as const } }];
  const events: RecordingEvent[] = actions.map((action, index) => ({ ...sampleEvent, ...action, qpc: undefined, injected: undefined,
    id: `mac-example:${index + 1}`, sequence: index + 1, timeMs: (index + 1) * 100, monotonicTicks: ticks((index + 1) * 100), window }));
  const session = RecordingSessionSchema.parse({ ...sampleSession, platform: "macos", applications: [window.bundleId], qpc: null, clock });
  return flowFixture(root, events, frames, session);
}
