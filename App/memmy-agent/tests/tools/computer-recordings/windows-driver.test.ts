import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WindowsTaskRecordingDriver } from "../../../src/tools/computer-recordings/windows-driver.js";

const origin = 9007199254740993000n;
const window = { hwnd: "55", pid: 123, processStart: "134000000000000000", executable: "C:\\Apps\\Fixture.exe",
  dpi: 96, bounds: { left: 0, top: 0, right: 640, bottom: 480 } };
const frames = () => [0, 100].map((timeMs, index) => ({
  index, timeMs, qpc: String(origin + BigInt(timeMs) * 10n), sourceTicks: String(origin), repeated: index === 1,
  partId: "part-000001", partFrame: index, window, blank: false,
  transform: { sourceWidth: 640, sourceHeight: 480, offsetX: 0, offsetY: 0, scale: 1, sourceLeft: 0, sourceTop: 0 },
}));
let directory: string;
const writeFrames = (value: unknown[]) => fs.writeFileSync(path.join(directory, "frames.jsonl"), value.map((frame) => JSON.stringify(frame)).join("\n") + "\n");
const recover = () => new WindowsTaskRecordingDriver(path.join(directory, "absent-helper.exe")).recover(directory);
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-win-task-source-"));
  fs.mkdirSync(path.join(directory, "parts"));
  const video = Buffer.from("already finalized native media fixture");
  fs.writeFileSync(path.join(directory, "parts/000001.mp4"), video);
  fs.writeFileSync(path.join(directory, "recording.mp4"), video);
  fs.writeFileSync(path.join(directory, "policy.json"), JSON.stringify({ version: 1, applications: [
    { hwnd: window.hwnd, pid: window.pid, processStart: window.processStart, executable: window.executable },
  ] }));
  fs.writeFileSync(path.join(directory, "native-media.json"), JSON.stringify({ version: 1, durationMs: 200,
    qpcOrigin: String(origin), qpcFrequency: "10000", width: 1920, height: 1080, complete: true, error: null, gaps: [],
    parts: [{ index: 1, startMs: 0, durationMs: 200, bytes: video.length, sha256: crypto.createHash("sha256").update(video).digest("hex") }],
  }));
  writeFrames(frames());
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe("Windows task frame provenance", () => {
  it("recovers display repeats while preserving QPC precision beyond JS integers", async () => {
    expect(await recover()).toMatchObject({ qpc: { origin: String(origin), frequency: "10000" }, videoIntegrity: "complete", durationMs: 200 });
  });
  it("keeps recordings from before source timestamps were added readable", async () => {
    writeFrames(frames().map((frame) => {
      const legacy = { ...frame };
      Reflect.deleteProperty(legacy, "sourceTicks");
      Reflect.deleteProperty(legacy, "repeated");
      return legacy;
    }));
    expect(await recover()).toMatchObject({ videoIntegrity: "complete" });
  });
  it.each(["missing", "future", "before_origin", "false_fresh", "blank"] as const)("rejects %s source provenance instead of admitting it as fresh evidence", async (failure) => {
    const rows = frames();
    if (failure === "missing") Reflect.deleteProperty(rows[1]!, "sourceTicks");
    if (failure === "future") rows[1]!.sourceTicks = String(origin + 1001n);
    if (failure === "before_origin") rows[1]!.sourceTicks = String(origin - 1n);
    if (failure === "false_fresh") rows[1]!.repeated = false;
    if (failure === "blank") writeFrames([rows[0]!, { ...rows[1]!, blank: true, window: null, transform: null }]);
    else writeFrames(rows);
    await expect(recover()).rejects.toThrow("task_frame_source_clock_invalid");
  });
});
