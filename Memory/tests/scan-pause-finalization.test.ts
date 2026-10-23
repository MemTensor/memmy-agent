import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { createAgentSourceExecutor } from "../src/agent-source/runtime.js";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import type { MemoryService } from "../src/service/memory-service.js";

const publication = vi.hoisted(() => ({ path: "", entered: () => {}, wait: Promise.resolve() }));
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, rename: async (...args: Parameters<typeof fs.rename>) => {
    await fs.rename(...args);
    if (args[1] === publication.path) { publication.entered(); await publication.wait; }
  } };
});

it.each(["resume", "cancel"] as const)("keeps a pause during source publication visible until %s", async action => {
  const directory = mkdtempSync(join(tmpdir(), "scan-finalization-"));
  let release!: () => void;
  publication.path = join(directory, "agent-sources.json");
  publication.wait = new Promise(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { publication.entered = resolve; });
  const executor = createAgentSourceExecutor({ configPath: join(directory, "config.yaml"), statePath: publication.path,
    service: {} as MemoryService, resolveAgentSkillRoot: () => null,
    sourceRegistry: createSourceRegistry([{ descriptor: { sourceId: "fixture", displayName: "Fixture", builtin: true, dataPath: directory },
      detect: async () => true, async *scan() {} }]) });
  try {
    const started = await executor.startScan({ sourceId: "fixture" });
    await entered;
    const expectedExecution = { jobId: started.jobId, attemptId: started.attemptId };
    await executor.pauseScan({ expectedExecution });
    release();
    // Let publication finish and the scan reach its final pause checkpoint.
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(executor.scanStatus()).toMatchObject({ status: "paused", running: false, completedAt: null, progress: { phase: "stopped" } });
    if (action === "resume") {
      await executor.startScan({ sourceId: "fixture", expectedExecution });
      await vi.waitFor(() => expect(executor.scanStatus().status).toBe("completed"));
    } else {
      expect((await executor.cancelScan({ expectedExecution })).snapshot.status).toBe("cancelled");
    }
  } finally {
    release(); await executor.dispose(); publication.path = "";
    rmSync(directory, { recursive: true, force: true });
  }
});
