import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import type { OperationEvidence } from "@memmy/local-api-contracts";

interface Pixels { width: number; height: number; data: Buffer }
const { PNG } = createRequire(import.meta.url)("pngjs") as { PNG: {
  sync: { read(bytes: Buffer): Pixels; write(pixels: Pixels): Buffer };
} };

function readPng(directory: string, relative: string, width: number, height: number): Pixels {
  const file = path.join(directory, relative), info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024 || fs.realpathSync(file) !== file) throw new Error("evidence_frame_invalid");
  const bytes = fs.readFileSync(file);
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
    || bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) throw new Error("evidence_frame_invalid");
  const pixels = PNG.sync.read(bytes);
  if (pixels.width !== width || pixels.height !== height || pixels.data.length !== width * height * 4) throw new Error("evidence_frame_invalid");
  return pixels;
}

function crop(pixels: Pixels, [x, y, width, height]: [number, number, number, number]): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row++) pixels.data.copy(data, row * width * 4,
    ((row + y) * pixels.width + x) * 4, ((row + y) * pixels.width + x + width) * 4);
  return PNG.sync.write({ width, height, data });
}

function targetRegion(pixels: Pixels, [cx, cy]: [number, number]) {
  let result: { region: [number, number, number, number]; stddev: number } | undefined;
  // Same bounded growth ladder and minimum contrast as pinned Flow 1.35.1.
  for (const [wantW, wantH] of [[160, 64], [240, 96], [320, 128], [480, 192], [640, 256]]) {
    const w = Math.min(wantW!, pixels.width), h = Math.min(wantH!, pixels.height);
    const x = Math.min(pixels.width - w, Math.max(0, Math.round(cx - w / 2)));
    const y = Math.min(pixels.height - h, Math.max(0, Math.round(cy - h / 2)));
    let sum = 0, squares = 0;
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
      const i = (row * pixels.width + col) * 4;
      const gray = 0.299 * pixels.data[i]! + 0.587 * pixels.data[i + 1]! + 0.114 * pixels.data[i + 2]!;
      sum += gray; squares += gray * gray;
    }
    result = { region: [x, y, w, h], stddev: Math.sqrt(Math.max(0, squares / (w * h) - (sum / (w * h)) ** 2)) };
    if (result.stddev >= 5) break;
  }
  return result!;
}

/** Local, deterministic image evidence. It does not infer text, intent or business success. */
export function enrichOperationVisualEvidence(input: { evidence: OperationEvidence; directory: string; width: number; height: number;
  assets: Array<{ eventId: string; i: number }> }): string[] {
  const { evidence, directory, width, height } = input;
  const templates = path.join(directory, "templates");
  fs.mkdirSync(templates, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(templates) !== templates || !fs.lstatSync(templates).isDirectory()) throw new Error("evidence_templates_invalid");
  const files: string[] = [];
  for (const asset of input.assets) {
    const step = evidence.steps.find((candidate) => candidate.evidence.eventIds.includes(asset.eventId));
    if (!step?.evidence.before || !step.evidence.after) continue;
    const stem = String(asset.i).padStart(4, "0");
    const before = readPng(directory, `frames/${stem}_before.png`, width, height);
    const after = readPng(directory, `frames/${stem}_after.png`, width, height);
    if (step.anchor?.click_point) {
      const { region, stddev } = targetRegion(before, step.anchor.click_point);
      const relative = `templates/${step.id}.png`;
      fs.writeFileSync(path.join(directory, relative), crop(before, region), { flag: "wx", mode: 0o600 });
      step.anchor.region = region; step.anchor.template = relative; files.push(relative);
      step.evidence.targetTemplate = { stddev, discriminative: stddev >= 5 };
      if (stddev < 5) step.evidence.missing.push("target_template_low_variance");
    }
    let changedPixels = 0, left = width, top = height, right = -1, bottom = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (Math.max(Math.abs(before.data[i]! - after.data[i]!), Math.abs(before.data[i + 1]! - after.data[i + 1]!),
        Math.abs(before.data[i + 2]! - after.data[i + 2]!)) < 25) continue;
      changedPixels++; left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
    const region: [number, number, number, number] | null = changedPixels ? [left, top, right - left + 1, bottom - top + 1] : null;
    let afterTemplate: string | null = null;
    if (region && step.action !== "scroll" && !step.evidence.missing.includes("after_frame_contains_later_action")) {
      afterTemplate = `templates/${step.id}_observed_after.png`;
      fs.writeFileSync(path.join(directory, afterTemplate), crop(after, region), { flag: "wx", mode: 0o600 });
      files.push(afterTemplate); step.evidence.effectStatus = "candidate";
    }
    step.evidence.visualChange = { changedPixels, changedFraction: changedPixels / (width * height), region, afterTemplate, stability: "unverified" };
  }
  for (const relative of [...files, ...input.assets.flatMap(({ i }) => [
    `frames/${String(i).padStart(4, "0")}_before.png`, `frames/${String(i).padStart(4, "0")}_after.png`,
  ])]) {
    const bytes = fs.readFileSync(path.join(directory, relative));
    evidence.assets.push({ path: relative, sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
  }
  return files;
}
