import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComputerHistoryDemoService } from "../../../../src/tools/computer-history/mac/computer-history-api.js";

const segmentId = "2026-09-13T00-00-00Z";
const id = `${segmentId}-10min-summary`;
let root: string;
let directory: string;
let historyFile: string;
let service: ComputerHistoryDemoService;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "history-pin-boundary-"));
  directory = path.join(root, "recordings", "segments", segmentId);
  historyFile = path.join(root, "histories", `${id}.md`);
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(path.dirname(historyFile), { recursive: true });
  fs.writeFileSync(path.join(directory, "metadata.json"), JSON.stringify({ startedAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(directory, "events.jsonl"), "{}\n");
  fs.writeFileSync(historyFile, "---\ntitle: Captured\nsource_type: captured\nsummary_state: ready\nstatus: completed\n---\n\nRecorded work.\n");
  service = new ComputerHistoryDemoService({
    recordingDirectory: path.join(root, "recordings"), historyDirectory: path.join(root, "histories"),
    workflowDirectory: path.join(root, "workflows"), observationSettingsFile: path.join(root, "settings.json"),
  });
});
afterEach(async () => { await service.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });

describe("pinning is confined to stored recording segments", () => {
  it.each(["../../outside-10min-summary", "/tmp/outside-10min-summary", "2026-09-31T00-00-00Z-10min-summary", "2026-09-13T00-01-00Z-10min-summary"])("rejects a noncanonical id %s", (invalid) => {
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    const marker = path.join(outside, ".pinned");
    fs.writeFileSync(marker, "keep");
    expect(() => service.pinSegment(invalid, true)).toThrow(/canonical/);
    expect(() => service.pinSegment(invalid, false)).toThrow(/canonical/);
    expect(fs.readFileSync(marker, "utf8")).toBe("keep");
  });

  it("requires an actual captured history and raw event file", () => {
    fs.rmSync(historyFile);
    expect(() => service.pinSegment(id, true)).toThrow(/captured history/);
    fs.writeFileSync(historyFile, "---\nsource_type: imported\n---\ncontext");
    expect(() => service.pinSegment(id, true)).toThrow(/captured history/);
    fs.writeFileSync(historyFile, "---\nsource_type: captured\n---\nwork");
    fs.rmSync(path.join(directory, "events.jsonl"));
    expect(() => service.pinSegment(id, true)).toThrow(/raw events/);
    expect(fs.existsSync(path.join(directory, ".pinned"))).toBe(false);
  });

  it("rejects a canonical segment whose directory is an outside symlink", () => {
    const outside = path.join(root, "outside");
    fs.renameSync(directory, outside);
    fs.symlinkSync(outside, directory, "dir");
    fs.writeFileSync(path.join(outside, ".pinned"), "keep");
    expect(() => service.pinSegment(id, true)).toThrow(/no longer on disk/);
    expect(() => service.pinSegment(id, false)).toThrow(/no longer on disk/);
    expect(fs.readFileSync(path.join(outside, ".pinned"), "utf8")).toBe("keep");
  });

  it("never follows a pin marker symlink to truncate its target", () => {
    const outside = path.join(root, "outside-file");
    fs.writeFileSync(outside, "must survive");
    const marker = path.join(directory, ".pinned");
    fs.symlinkSync(outside, marker);
    expect(() => service.pinSegment(id, true)).toThrow(/regular file/);
    expect(fs.readFileSync(outside, "utf8")).toBe("must survive");
    service.pinSegment(id, false);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(outside, "utf8")).toBe("must survive");
  });

  it("keeps ordinary pin and unpin idempotent", () => {
    service.pinSegment(id, true);
    expect(service.pinSegment(id, true).histories[0].pinned).toBe(true);
    service.pinSegment(id, false);
    expect(service.pinSegment(id, false).histories[0].pinned).toBe(false);
  });
});
