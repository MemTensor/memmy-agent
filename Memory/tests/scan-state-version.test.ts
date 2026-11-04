import { withUnrestrictedScanPermit } from "./fixtures/scan-admission-fixture.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentSourceExecutor } from "../src/agent-source/runtime.js";
import { nextScanGeneration } from "../src/agent-source/scan-version.js";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import type { MemoryService } from "../src/service/memory-service.js";
import { routeAgentSourceScan } from "../src/server/agent-source-api.js";
const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), "scan-version-")); roots.push(path); return path; };
afterEach(() => { roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
it("increments the durable epoch and fails closed on corrupt generation storage", () => {
  const directory = root(); expect(nextScanGeneration(directory)).toBe(1); expect(nextScanGeneration(directory)).toBe(2);
  writeFileSync(join(directory, "state-generation.json"), "null"); expect(() => nextScanGeneration(directory)).toThrow("Invalid scan state generation");
});
it("orders pause/resume/cancel, keeps snapshots immutable and rejects controls from old pages", async () => {
  const directory = root(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const detect = vi.fn(async () => { await gate; return true; });
  const executor = createAgentSourceExecutor({ configPath: join(directory, "config.yaml"), service: { withAgentSourceScanPermit: withUnrestrictedScanPermit } as MemoryService,
    sourceRegistry: createSourceRegistry([{ descriptor: { sourceId: "fixture", displayName: "Fixture", builtin: true, dataPath: directory }, detect, async *scan() {} }]), resolveAgentSkillRoot: () => null });
  try {
    const idle = executor.scanStatus(); expect(idle.status).toBe("idle");
    const first = await executor.startScan({ sourceId: "fixture", expectedVersion: idle.version });
    await vi.waitFor(() => expect(detect).toHaveBeenCalledOnce());
    const running = executor.scanStatus();
    expect(executor.scanStatus()).toEqual(running);
    running.version!.sequence = -1;
    expect(executor.scanStatus().version!.sequence).toBeGreaterThan(0);
    await expect(executor.startScan({ sourceId: "fixture", expectedVersion: idle.version })).rejects.toMatchObject({ code: "conflict" });
    const expectedExecution = { jobId: first.jobId, attemptId: first.attemptId };
    const paused = await executor.pauseScan({ expectedExecution });
    expect(paused.snapshot).toMatchObject({ status: "paused", attemptId: first.attemptId });
    expect((await executor.pauseScan({ expectedExecution })).snapshot.version).toEqual(paused.snapshot.version);
    const resumed = await executor.startScan({ sourceId: "fixture", expectedExecution });
    expect(resumed.attemptId).toBe(first.attemptId);
    expect(resumed.version!.sequence).toBeGreaterThan(paused.snapshot.version!.sequence);
    expect((await executor.pauseScan({ expectedExecution, expectedVersion: paused.snapshot.version })).outcome).toBe("conflict");
    expect((await executor.cancelScan({ expectedVersion: paused.snapshot.version })).outcome).toBe("conflict");
    expect(executor.scanStatus().running).toBe(true);
    const cancel = executor.cancelScan({ expectedExecution, expectedVersion: resumed.version }); release();
    const cancelled = await cancel;
    expect(cancelled.snapshot).toMatchObject({ status: "cancelled", jobId: first.jobId, attemptId: first.attemptId });
    expect(cancelled.snapshot.version!.sequence).toBeGreaterThan(resumed.version!.sequence);
    expect((await executor.cancelScan({ expectedExecution })).snapshot).toEqual(cancelled.snapshot);
    const second = await executor.startScan({ sourceId: "fixture", expectedVersion: cancelled.snapshot.version });
    expect(second.attemptId).not.toBe(first.attemptId);
    expect((await executor.cancelScan({ expectedExecution })).outcome).toBe("conflict");
    expect((await executor.pauseScan({ expectedExecution })).outcome).toBe("conflict");
    await vi.waitFor(() => expect(executor.scanStatus().completedAt).not.toBeNull());
    const done = executor.scanStatus();
    expect((await executor.pauseScan({ expectedExecution: { jobId: second.jobId, attemptId: second.attemptId } })).snapshot).toEqual(done);
    expect((await executor.cancelScan({ expectedExecution: { jobId: second.jobId, attemptId: second.attemptId } })).snapshot).toEqual(done);
  } finally { release(); await executor.dispose(); }
});
it.each([{ expectedExecution: null }, { expectedExecution: { jobId: 42 } }, { expectedVersion: { generation: -1, sequence: 0 } }])("validates controls at the Memory HTTP boundary: %j", async body => {
  const executor = { pauseScan: vi.fn(), startScan: vi.fn() } as unknown as ReturnType<typeof createAgentSourceExecutor>;
  await expect(routeAgentSourceScan(executor, "POST", new URL("http://localhost/api/v1/agent-sources/scan/stop"), body)).rejects.toMatchObject({ code: "invalid_argument" });
  expect(executor.pauseScan).not.toHaveBeenCalled();
});
