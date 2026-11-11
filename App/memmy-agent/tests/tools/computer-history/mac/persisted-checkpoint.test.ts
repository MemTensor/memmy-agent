import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { persistMacCheckpoint } from "../../../../src/tools/computer-history/mac/persisted-checkpoint.js";
import { persistedCheckpoint, recordingCheckpointRecord } from "../../../../src/tools/computer-history/core/recorder-checkpoint.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
const id = "c892ee91-1d7c-4b43-b149-97284fe3caff";
const event = { kind: "session.checkpoint", id, complete: true, nativeSessionId: "a".repeat(32), nativeSequence: 12 };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mac-durable-boundary-")); roots.push(root);
  const file = path.join(root, "events.jsonl"); fs.writeFileSync(file, '{"text":"已授权的记录"}\n'); return file;
}
it("fsyncs the native marker and retains its exact byte position even when later events arrive", () => {
  const file = fixture(), through = "2026-10-21T01:00:00.123Z";
  const sync = vi.spyOn(fs, "fsyncSync");
  const position = persistMacCheckpoint({ file, event, through, sequence: 5 });
  const boundarySize = fs.statSync(file).size;
  fs.appendFileSync(file, '{"text":"later event outside the checkpoint"}\n');
  expect(sync).toHaveBeenCalledOnce();
  expect(position.watermark).toEqual({ nativeSessionId: "a".repeat(32), nativeSequence: 12, captureSequence: 12, recordingSequence: 5, bytes: boundarySize });
  expect(position.watermark.bytes).toBeLessThan(fs.statSync(file).size);
  expect(persistedCheckpoint.parse({ id, complete: true, rangeEvaluated: false, ...position }).through).toBe(through);
  const marker = JSON.parse(fs.readFileSync(file, "utf8").split("\n")[1]!);
  expect(recordingCheckpointRecord.parse(marker).details.checkpointId).toBe(id);
  expect(marker.application).toBeUndefined(); expect(marker.details.text).toBeUndefined();
});
it("cannot return a durable success after a failed fsync or an invalid native identity", () => {
  const file = fixture();
  const sync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("disk failure"); });
  expect(() => persistMacCheckpoint({ file, event, through: "2026-10-21T01:00:00.123Z", sequence: 1 })).toThrow("disk failure");
  sync.mockRestore();
  const size = fs.statSync(file).size;
  expect(() => persistMacCheckpoint({ file, event: { ...event, nativeSessionId: "untrusted" }, through: "2026-10-21T01:00:00.123Z", sequence: 2 })).toThrow();
  expect(fs.statSync(file).size).toBe(size);
});
