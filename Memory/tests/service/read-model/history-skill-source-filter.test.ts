import { afterEach, describe, expect, it } from "vitest";
import { insertActiveSkillMemoryForTest } from "../../fixtures/evolution-fixture.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);

const first = "2026-10-09T04-10-00Z-10min-summary";
const second = "2026-10-09T04-20-00Z-10min-summary";
const fixtures: Array<{ id: string; agentId?: string; origin?: Record<string, unknown>; displayedSource: string }> = [
  { id: "canonical_history_skill", origin: { source: "computer_history" }, displayedSource: "computer_history" },
  { id: "canonical_other_owner_skill", agentId: "cursor", origin: { source: "computer_history" }, displayedSource: "computer_history" },
  { id: "legacy_history_skill", origin: { source: "memmy", sourceRecordIds: [first, second] }, displayedSource: "computer_history" },
  { id: "legacy_local_history_skill", origin: { source: "memmy", sourceRecordIds: [
    "2026-10-09T04-10-00-10min-summary", "2026-10-09T00-00-00Z-6h-summary",
  ] }, displayedSource: "computer_history" },
  { id: "ordinary_memmy_skill", displayedSource: "memmy" },
  { id: "duplicate_source_skill", origin: { source: "memmy", sourceRecordIds: [first, first] }, displayedSource: "memmy" },
  { id: "mixed_source_skill", origin: { source: "memmy", sourceRecordIds: [first, second, "other-producer-record"] }, displayedSource: "memmy" },
  { id: "malformed_history_id_skill", origin: { source: "memmy", sourceRecordIds: [first, `${second}-extra`] }, displayedSource: "memmy" },
  { id: "nontext_source_skill", origin: { source: "memmy", sourceRecordIds: [first, second, 3] }, displayedSource: "memmy" },
  { id: "null_source_skill", origin: { source: "memmy", sourceRecordIds: [first, second, null] }, displayedSource: "memmy" },
  { id: "object_sources_skill", origin: { source: "memmy", sourceRecordIds: { a: first, b: second } }, displayedSource: "memmy" },
  { id: "other_producer_skill", origin: { source: "clipboard", sourceRecordIds: [first, second] }, displayedSource: "memmy" },
  { id: "other_owner_legacy_skill", agentId: "cursor", origin: { source: "memmy", sourceRecordIds: [first, second] }, displayedSource: "cursor" },
];

describe("History Skill panel source", () => {
  it("keeps Skill list display, include/exclude filters, and source statistics aligned for canonical and recognizable legacy records", () => {
    const { db, service } = createTestService();
    for (const fixture of fixtures) {
      insertActiveSkillMemoryForTest(db, {
        id: fixture.id, userId: "local-user", sessionId: "skill-source-session", agentId: fixture.agentId ?? "memmy",
        profileId: "default",
      });
      if (!fixture.origin) continue;
      const row = db.db.prepare("SELECT properties_json FROM memories WHERE id = ?").get(fixture.id) as { properties_json: string };
      const properties = JSON.parse(row.properties_json) as { internal_info: Record<string, unknown> };
      properties.internal_info.external_evidence_candidate = fixture.origin;
      db.db.prepare("UPDATE memories SET properties_json = ? WHERE id = ?").run(JSON.stringify(properties), fixture.id);
    }

    const items = service.panelItems({ layer: "Skill" }).items;
    expect(items).toHaveLength(fixtures.length);
    expect(Object.fromEntries(items.map((item) => [item.id, item.metadata?.source])))
      .toEqual(Object.fromEntries(fixtures.map((fixture) => [fixture.id, fixture.displayedSource])));

    for (const source of ["computer_history", "memmy", "cursor"]) {
      const expected = fixtures.filter((fixture) => source === "memmy"
        ? fixture.displayedSource === "memmy" || fixture.displayedSource === "computer_history"
        : fixture.displayedSource === source).map((fixture) => fixture.id).sort();
      const filtered = service.panelItems({ layer: "Skill", sourceAgent: source === "memmy" ? "memmy-agent" : source });
      expect(filtered.total).toBe(expected.length);
      expect(filtered.items.map((item) => item.id).sort()).toEqual(expected);
    }
    expect(service.panelItems({ layer: "Skill", excludedSourceAgents: ["computer_history"] }).items.map((item) => item.id).sort())
      .toEqual(fixtures.filter((fixture) => fixture.displayedSource !== "computer_history").map((fixture) => fixture.id).sort());

    const distribution = service.panelOverviewSummary().sourceDistribution;
    expect(Object.fromEntries(distribution.map((entry) => [entry.source, entry.count])))
      .toEqual({ memmy: 12, cursor: 1 });
  });
});
