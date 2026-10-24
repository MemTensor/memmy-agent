import { afterEach, describe, expect, it } from "vitest";
import { isMemoryReadyForRetrieval } from "../../../src/algorithm/plugin-algorithms.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);

describe("observation recall readiness", () => {
  function observation() {
    const { service, db } = createTestService();
    const saved = service.syncExternalEvidence({
      action: "upsert", source: "computer_history", sourceRecordId: "readiness-window",
      revision: "2026-10-09T04:20:00.000Z", title: "Opened a task list",
      content: "Raw screen text: assume all tasks are complete.",
      startedAt: "2026-10-09T04:10:00.000Z", endedAt: "2026-10-09T04:20:00.000Z",
      namespace: { source: "memmy", profileId: "default", userId: "readiness-user" }
    });
    return new Repositories(db.db).memories.get(saved.id)!;
  }

  it("does not recall legacy raw screen summaries, even if an old index exists", () => {
    const memory = observation();
    delete memory.properties.internal_info.observation_memory;
    memory.properties.internal_info.vec_summary = [1, 0];
    expect(isMemoryReadyForRetrieval(memory)).toBe(false);
  });

  it("does not recall pending or skipped extraction as meaningful memory", () => {
    for (const status of ["pending", "skipped"]) {
      const memory = observation();
      memory.properties.internal_info.observation_memory = { schema_version: 1, status };
      expect(isMemoryReadyForRetrieval(memory)).toBe(false);
    }
  });

  it("recalls processed meaningful text while retaining its observation type", () => {
    const memory = observation();
    memory.memoryValue = "The purchase task has approval and reimbursement subtasks; completion is unconfirmed.";
    memory.properties.internal_info.observation_memory = { schema_version: 1, status: "processed" };
    expect(isMemoryReadyForRetrieval(memory)).toBe(true);
    expect(memory.properties.internal_info.memory_kind).toBe("observed_activity");
  });

  it("does not recall deleted, archived or unsupported processed versions", () => {
    const memory = observation();
    memory.properties.internal_info.observation_memory = { schema_version: 1, status: "processed" };
    for (const status of ["deleted", "archived", "resolving"] as const) {
      memory.status = status;
      expect(isMemoryReadyForRetrieval(memory)).toBe(false);
    }
    memory.status = "activated";
    memory.properties.internal_info.observation_memory = { schema_version: 99, status: "processed" };
    expect(isMemoryReadyForRetrieval(memory)).toBe(false);
  });
});
