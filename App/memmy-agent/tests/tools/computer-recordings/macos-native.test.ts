import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterEach, expect, test } from "vitest";
const directories: string[] = [];
const { PNG } = createRequire(import.meta.url)("pngjs");
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

test.runIf(process.platform === "darwin")("native AVFoundation media preserves color, sample timestamps, sealed fragments and a recoverable prefix", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-mac-media-native-")); directories.push(directory);
  const source = fileURLToPath(new URL("../../../src/tools/computer-history/mac/task-recorder.swift", import.meta.url));
  const binary = path.join(directory, "task-recorder-test");
  execFileSync("xcrun", ["--sdk", "macosx", "swiftc", "-O", "-D", "MEMMY_RECORDING_TESTS", "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos11.0`,
    "-module-cache-path", path.join(directory, "modules"), "-o", binary, source, "-Xlinker", "-weak_framework", "-Xlinker", "ScreenCaptureKit"], { timeout: 120_000 });
  const probe = JSON.parse(execFileSync(binary, ["--configuration"], { encoding: "utf8", timeout: 15_000 }));
  expect(probe).toMatchObject({ supported: true, permissions: { accessibility: expect.any(Boolean), inputMonitoring: expect.any(Boolean), screenRecording: expect.any(Boolean) } });
  const media = path.join(directory, "media"); fs.mkdirSync(media);
  expect(JSON.parse(execFileSync(binary, ["--self-test", "--output-dir", media], { encoding: "utf8", timeout: 60_000 })))
    .toEqual({ nativeMediaTests: "passed", parts: 2, frames: 6 });
  const manifest = JSON.parse(fs.readFileSync(path.join(media, "native-media.json"), "utf8"));
  expect(manifest).toMatchObject({ platform: "macos", complete: false, durationMs: 10220, width: 1920, height: 1080 });
  expect(manifest.parts.map((part: { startMs: number; durationMs: number }) => [part.startMs, part.durationMs])).toEqual([[0, 10010], [10010, 210]]);
  const frames = fs.readFileSync(path.join(media, "frames.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(frames.map((frame) => frame.timeMs)).toEqual([0, 70, 140, 10010, 10080, 10150]);
  expect(frames.every((frame) => !frame.qpc && frame.monotonicTicks)).toBe(true);
  expect(frames.map((frame) => frame.blank)).toEqual([false, false, false, false, true, false]);
  expect(manifest.gaps).toEqual([{ startMs: 10080, endMs: 10150, reason: "paused" }]);
  for (const name of ["0000_before.png", "0000_after.png"]) {
    const png = PNG.sync.read(fs.readFileSync(path.join(media, "exports", "native-test", "frames", name)));
    expect([png.width, png.height]).toEqual([1920, 1080]);
    expect(png.data[0]).toBeGreaterThan(200); expect(png.data[2]).toBeLessThan(40);
    const bottom = (1080 - 1) * 1920 * 4;
    expect(png.data[bottom]).toBeLessThan(40); expect(png.data[bottom + 2]).toBeGreaterThan(200);
  }
}, 180_000);
