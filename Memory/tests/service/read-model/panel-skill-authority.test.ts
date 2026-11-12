import "../../fixtures/isolated-user-home.js";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryDb } from "../../../src/storage/db.js";
import { importedSkillContentHash } from "../../../src/storage/imported-skill.js";
import { MemoryRepository, Repositories } from "../../../src/storage/repositories.js";
import type { MemoryRow } from "../../../src/types.js";
import { createFailingLlm, createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(async () => { vi.restoreAllMocks(); await fixture.cleanup(); });

it.each(["list", "search", "fixed page"] as const)("drops withdrawn Skill bytes during %s instead of using a policy-free row", async mode => {
  const { db, service } = fixture.createTestService({ llm: createFailingLlm() });
  const repos = new Repositories(db.db);
  const namespace = { source: "hermes", profileId: "default", userId: "authority-test-owner" };
  const secret = "WITHDRAWN-SKILL-PRIVATE-CANARY";
  const body = `---\nname: restricted\ndescription: fixture\ndisable-model-invocation: true\n---\n${secret}`;
  const created = service.addMemory({ namespace, source: "hermes", layer: "Skill", title: "restricted", content: body,
    sourceAgentId: "hermes", sourceSkillId: "restricted", sourceSkillPath: "/synthetic/hermes/restricted/SKILL.md",
    sourceContentHash: importedSkillContentHash(body), deferProcessing: true });
  const raw = repos.memories.getIncludingDeleted(created.id)!;
  const internal: MemoryRow["properties"]["internal_info"] = { ...raw.properties.internal_info, has_supporting_files: true };
  for (const key of ["import_state_version", "archive_reason", "source_state", "invocation"]) delete internal[key];
  repos.memories.updateMaintenance({ ...raw, status: "activated", memoryValue: body,
    info: { ...raw.info, summary: `Summary ${secret}` },
    properties: { ...raw.properties, status: "activated", internal_info: internal } });
  expect(JSON.stringify(service.panelItems({ namespace, layer: "Skill" }))).not.toContain(secret);

  let viewId: string | undefined;
  if (mode === "fixed page") {
    const view = await service.browsePanel({ op: "create", filter: { section: "items", layer: "Skill" } }, { namespace });
    if (!("viewId" in view)) throw new Error("Expected a fixed Skill view");
    viewId = view.viewId;
  }
  const writer = new MemoryDb({ path: db.path });
  if (mode === "fixed page") {
    // Fixed pages run in a separate snapshot reader. A committed withdrawal
    // must invalidate even an already cached page through the real safety token.
    try {
      expect(writer.db.prepare("UPDATE memories SET deleted_at='2026-11-12T00:00:00.000Z' WHERE id=?").run(created.id).changes).toBe(1);
      await expect(service.browsePanel({ op: "page", viewId: viewId!, page: 1 }, { namespace })).rejects.toThrow(/expired|changed/);
      expect(service.panelItems({ namespace, layer: "Skill" })).toMatchObject({ total: 0, items: [] });
    } finally { writer.close(); }
    return;
  }
  let withdrawn = false;
  const read = MemoryRepository.prototype.getManyForDisplay;
  const spy = vi.spyOn(MemoryRepository.prototype, "getManyForDisplay")
    .mockImplementation(function (this: MemoryRepository, ids) {
      if (!withdrawn && ids.includes(created.id)) {
        writer.db.prepare("UPDATE memories SET deleted_at='2026-11-12T00:00:00.000Z' WHERE id=?").run(created.id);
        withdrawn = true;
      }
      return read.call(this, ids);
    });
  try {
    const response = service.panelItems({ namespace, layer: "Skill", ...(mode === "search" ? { q: secret } : {}) });
    expect(withdrawn).toBe(true);
    expect(JSON.stringify(response)).not.toContain(secret);
    if (!("items" in response)) throw new Error("Expected panel items");
    expect(response.items?.map(item => item.id)).not.toContain(created.id);
    const refreshed = service.panelItems({ namespace, layer: "Skill" });
    expect(refreshed.total).toBe(0);
    expect(refreshed.items.map(item => item.id)).not.toContain(created.id);
  } finally { spy.mockRestore(); writer.close(); }
});
