import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import type { FairClaimedWork } from "../../../src/service/worker/fair-worker-queue.js";
import type { PreparedWorkerExecution } from "../../../src/service/worker/worker-concurrency.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";
const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);
describe("model admission fill snapshots", () => {
  it("loads config once per fill and separates same-provider batches after credential-only reload", () => {
    const config = structuredClone(DEFAULT_MEMMY_CONFIG);
    config.summary = { ...config.summary, provider: "openai_compatible", endpoint: "https://provider.test/v1", model: "same", apiKey: "old-secret" };
    let loads = 0;
    const { service } = createTestService({ configLoader: () => { loads++; return { config }; } });
    const internal = service as unknown as {
      prepareWorkerExecutionBatch(): (work: FairClaimedWork) => PreparedWorkerExecution;
    };
    const candidate = { queue: "main", job: { jobType: "embedding" } } as FairClaimedWork;
    const before = loads;
    const firstFill = internal.prepareWorkerExecutionBatch();
    const first = firstFill(candidate);
    for (let i = 0; i < 1_000; i++) expect(firstFill(candidate).batchKey).toBe(first.batchKey);
    expect(loads).toBe(before + 1);
    config.summary.apiKey = "reloaded-secret";
    expect(firstFill(candidate).batchKey).toBe(first.batchKey);
    const second = internal.prepareWorkerExecutionBatch()(candidate);
    expect(loads).toBe(before + 2);
    expect(second.providers).toEqual(first.providers);
    expect(second.batchKey).not.toBe(first.batchKey);
    expect(second.batchKey).toMatch(/^[a-f0-9]{64}$/);
    expect(second.batchKey).not.toContain("secret");
  });
});
