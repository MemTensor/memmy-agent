import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openMemoryAgentSourceScanStore } from "../src/agent-source/scan-store.js";
import { openSourceCheckpoints, publishSourceCheckpoints } from "../src/agent-source/source-checkpoints.js";

const roots: string[] = [];
const close: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of close.splice(0)) fn();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const checkpoint = (i: number, sourceId = "fixture") => ({
  sourceId, conversationId: String(i).padStart(5, "0"), lastMessageId: `m${i}`,
  lastCreatedAt: "2026-10-20", contentHash: `hash${i}`, updatedAt: "2026-10-20"
});
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "checkpoint-batches-")); roots.push(root);
  const store = await openMemoryAgentSourceScanStore(join(root, "job.sqlite"), {
    jobId: "job", sourceId: "fixture", mode: "full", phase: "ingest",
    createdAt: "2026-10-20", updatedAt: "2026-10-20"
  });
  const path = join(root, "checkpoints.sqlite");
  const checkpoints = openSourceCheckpoints(path);
  close.push(() => store.close(), () => checkpoints.close());
  return { store, checkpoints, path };
}

describe("bounded checkpoint publication", () => {
  it("pages in stable order, scopes sources, and writes no more than 100 rows per transaction", async () => {
    const { store, checkpoints } = await setup();
    for (let i = 204; i >= 0; i--) store.saveCheckpoint(checkpoint(i));
    store.saveCheckpoint(checkpoint(999, "other"));
    const page = store.checkpointPage("fixture");
    expect(page).toHaveLength(100);
    expect(page[0]).toEqual(checkpoint(0));
    expect(checkpoints.saveCheckpointBatch(Array.from({ length: 205 }, (_, i) => checkpoint(i)))).toBeLessThanOrEqual(100);
    expect(checkpoints.getCheckpoint("fixture", checkpoint(100).conversationId)).toBeNull();
    const batches = vi.spyOn(checkpoints, "saveCheckpointBatch");
    const cooperate = vi.fn(async () => {});
    await publishSourceCheckpoints(store, checkpoints, "fixture", cooperate);
    expect(batches.mock.calls.every(([rows]) => rows.length <= 100)).toBe(true);
    expect(cooperate).toHaveBeenCalledTimes(batches.mock.calls.length + 1);
    for (let i = 0; i < 205; i++) expect(checkpoints.getCheckpoint("fixture", checkpoint(i).conversationId)).toEqual(checkpoint(i));
    expect(checkpoints.getCheckpoint("other", checkpoint(999).conversationId)).toBeNull();
  });

  it("ends a slow batch at the time budget and resumes from the last committed row", async () => {
    const { store, checkpoints } = await setup();
    for (let i = 0; i < 5; i++) store.saveCheckpoint(checkpoint(i));
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock += 17);
    const batches = vi.spyOn(checkpoints, "saveCheckpointBatch");
    await publishSourceCheckpoints(store, checkpoints, "fixture", async () => {});
    expect(batches.mock.results.map(result => result.value)).toEqual([1, 1, 1, 1, 1]);
    expect(checkpoints.getCheckpoint("fixture", checkpoint(4).conversationId)).toEqual(checkpoint(4));
  });

  it("processes an event-loop cancellation between batches, retaining only committed rows", async () => {
    const { store, checkpoints } = await setup();
    for (let i = 0; i < 205; i++) store.saveCheckpoint(checkpoint(i));
    const controller = new AbortController();
    const write = checkpoints.saveCheckpointBatch;
    let committed = 0;
    vi.spyOn(checkpoints, "saveCheckpointBatch").mockImplementation(rows => {
      const count = write(rows); committed += count;
      setImmediate(() => controller.abort(new Error("cancelled")));
      return count;
    });
    await expect(publishSourceCheckpoints(store, checkpoints, "fixture", async () => controller.signal.throwIfAborted()))
      .rejects.toThrow("cancelled");
    expect(committed).toBeGreaterThan(0);
    expect(committed).toBeLessThanOrEqual(100);
    expect(checkpoints.getCheckpoint("fixture", checkpoint(committed - 1).conversationId)).not.toBeNull();
    expect(checkpoints.getCheckpoint("fixture", checkpoint(committed).conversationId)).toBeNull();
    vi.restoreAllMocks();
    await publishSourceCheckpoints(store, checkpoints, "fixture", async () => {});
    expect(checkpoints.getCheckpoint("fixture", checkpoint(204).conversationId)).toEqual(checkpoint(204));
  });

  it("rolls back a failed batch without losing previously committed checkpoints", async () => {
    const { checkpoints } = await setup();
    vi.spyOn(performance, "now").mockReturnValue(0);
    checkpoints.saveCheckpointBatch([checkpoint(0)]);
    const invalid = { ...checkpoint(2), contentHash: null } as unknown as ReturnType<typeof checkpoint>;
    expect(() => checkpoints.saveCheckpointBatch([checkpoint(1), invalid])).toThrow();
    expect(checkpoints.getCheckpoint("fixture", checkpoint(0).conversationId)).toEqual(checkpoint(0));
    expect(checkpoints.getCheckpoint("fixture", checkpoint(1).conversationId)).toBeNull();
  });

  it.each([100, 205])("recovers %i committed rows after an abrupt process exit and safely republishes", async count => {
    const { store, checkpoints, path } = await setup();
    for (let i = 0; i < 205; i++) store.saveCheckpoint(checkpoint(i));
    const moduleUrl = new URL("../src/agent-source/source-checkpoints.ts", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { openSourceCheckpoints } from ${JSON.stringify(moduleUrl)};
      const db = openSourceCheckpoints(${JSON.stringify(path)});
      const rows = ${JSON.stringify(Array.from({ length: count }, (_, i) => checkpoint(i)))};
      let offset = 0;
      while (offset < rows.length) offset += db.saveCheckpointBatch(rows.slice(offset, offset + 100));
      process.kill(process.pid, "SIGKILL");
    `], { encoding: "utf8", timeout: 10000 });
    expect(child.error).toBeUndefined();
    expect(child.signal, child.stderr).toBe("SIGKILL");
    expect(checkpoints.getCheckpoint("fixture", checkpoint(count - 1).conversationId)).toEqual(checkpoint(count - 1));
    if (count < 205) expect(checkpoints.getCheckpoint("fixture", checkpoint(count).conversationId)).toBeNull();
    await publishSourceCheckpoints(store, checkpoints, "fixture", async () => {});
    for (let i = 0; i < 205; i++) expect(checkpoints.getCheckpoint("fixture", checkpoint(i).conversationId)).toEqual(checkpoint(i));
  });
});
