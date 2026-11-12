import "../../fixtures/isolated-user-home.js";
import { afterEach, describe, expect, it } from "vitest";
import { Repositories } from "../../../src/storage/repositories.js";
import { importedSkillMayEmbed } from "../../../src/storage/imported-skill.js";
import type { MemoryRow } from "../../../src/types.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(() => fixture.cleanup());
const at = "2026-01-01T00:00:00.000Z";
function memory(id: string, value: string, internal: Record<string, unknown> = {}, status: MemoryRow["status"] = "activated"): MemoryRow {
  return { id, userId: "local-user", memoryType: "SkillMemory", memoryLayer: "Skill", memoryKey: id,
    memoryValue: value, status, visibility: "private", tags: [], info: { title: id }, version: 1, createdAt: at, updatedAt: at, timeline: at,
    properties: { internal_info: { read_only: true, memory_layer: "Skill", source_agent_id: "hermes", source_skill_id: id,
      source_kind: "skill", skill: { name: id, status: "active", eta: 0.5 }, ...internal } } };
}
const restricted = [
  { label: "empty", value: "" },
  { label: "line whitespace", value: " \n " },
  { label: "Unicode whitespace", value: "\u00a0\u3000\t\r\n" },
  { label: "user archive", value: "Retained user guide.", internal: { archive_reason: "user" }, status: "archived" as const },
  { label: "active plugin registration", value: "Stale plugin guide.", internal: { source_kind: "plugin" } },
  { label: "active invocation policy", value: "Stale restricted guide.", internal: { archive_reason: "invocation_policy" } },
  { label: "active disconnected source", value: "Stale disconnected guide.", internal: { source_state: "disconnected" } },
  { label: "active unknown policy", value: "Stale unknown policy guide.", internal: { source_state: "policy_unknown" } }
];
describe("imported Skill embedding maintenance eligibility", () => {
  it.each(restricted)("excludes $label from stats and repeated repair", async ({ value, internal, status }) => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const row = repos.memories.insert(memory("restricted", value, internal, status));
    expect.soft(importedSkillMayEmbed(row)).toBe(false);
    expect.soft(await service.embeddingMaintenanceStats()).toMatchObject({ totalSlots: 0, missing: 0, needsRepair: 0 });
    const run = await service.rebuildEmbeddings("repair");
    expect.soft(run).toMatchObject({ enqueued: 0, failed: 0, pending: 0, done: true });
    await service.runWorkerOnce(100);
    expect.soft(await service.embeddingMaintenanceProgress(run.runId)).toMatchObject({ failed: 0, pending: 0, done: true, statsAfter: { totalSlots: 0, needsRepair: 0 } });
    expect.soft(await service.rebuildEmbeddings("repair")).toMatchObject({ enqueued: 0, failed: 0, done: true });
  });

  it("keeps active imported and ordinary generated Skill slots eligible", async () => {
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    repos.memories.insert(memory("active", "A useful guide."));
    repos.memories.insert(memory("generated", " \n ", { read_only: false }));
    expect(await service.embeddingMaintenanceStats()).toMatchObject({ totalSlots: 2, missing: 2, needsRepair: 2 });
    expect(await service.rebuildEmbeddings("repair")).toMatchObject({ enqueued: 2, failed: 0 });
  });
});
