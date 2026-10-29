import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { HistoryMemoryAdapter } from "../../../src/tools/computer-history/memory-adapter.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const ids = ["first-10min-summary", "second-10min-summary"];
const revision = "2026-10-13T03:50:00.000Z";
const group = { id: "group", revision, sourceRecordIds: ids,
  actions: ids.flatMap((sourceRecordId) => [
    { sourceRecordId, text: "Edit the release note" }, { sourceRecordId, text: "Save the release note" },
  ]) };
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "history-skill-status-"));
  roots.push(root);
  return { root, historyDirectory: root, userId: () => "fixture-user",
    listEvidence: () => ids.map((id) => ({ id, title: "Release notes", content: "Edited release notes",
      revision, startedAt: revision, endedAt: revision, applications: [] })),
    post: async (payload: { sourceRecordId: string }) => ({ id: `memory-${payload.sourceRecordId}` }),
  };
}
function mockService(response: () => Response) {
  vi.stubEnv("MEMMY_MEMORY_URL", "http://127.0.0.1:18960");
  vi.stubEnv("MEMMY_MEMORY_TOKEN", "fixture-token");
  return vi.stubGlobal("fetch", vi.fn(async () => response()));
}

test("HTTP pending retains the Skill group through restart and expired raw events", async () => {
  const input = fixture();
  let enabled = false;
  let ready = false;
  const linked: string[] = [];
  let successfulCalls = 0;
  mockService(() => {
    if (!ready) return Response.json({ status: "pending", reason: "source_memory_processing" });
    successfulCalls++;
    return Response.json({ status: "active", id: "skill-recovered" });
  });
  const first = new HistoryMemoryAdapter({ ...input, enabled: () => enabled, listSkillGroups: () => [group] });
  enabled = true;
  await first.flushNow();
  expect(first.status()).toMatchObject({ error: null, skillError: null });
  const waiting = JSON.parse(readFileSync(path.join(input.root, "memory-sync-state.json"), "utf8"));
  expect(waiting.pendingSkillGroups.group).toEqual(group);
  expect(waiting.skillGroups).toEqual({});
  await first.close();

  ready = true;
  const resumed = new HistoryMemoryAdapter({ ...input, enabled: () => enabled, listSkillGroups: () => [],
    onSkillCandidate: (_group, id) => { if (id) linked.push(id); } });
  await resumed.flushNow();
  await resumed.flushNow();
  expect(linked).toEqual(["skill-recovered"]);
  expect(successfulCalls).toBe(1);
  expect(JSON.parse(readFileSync(path.join(input.root, "memory-sync-state.json"), "utf8")).pendingSkillGroups).toEqual({});
  await resumed.close();
});

test.each([
  "source meaningful memory requires retry",
  "source summary model is not configured",
  "evolution model is not configured",
  "Skill evolution is disabled",
  "source meaningful memory is still processing or requires retry",
])("keeps actionable service failure visible: %s", async (message) => {
  const input = fixture();
  let enabled = false;
  mockService(() => Response.json({ error: { code: "conflict", message } }, { status: 409 }));
  const adapter = new HistoryMemoryAdapter({ ...input, enabled: () => enabled, listSkillGroups: () => [group] });
  enabled = true;
  await adapter.flushNow();
  expect(adapter.status()).toMatchObject({ error: null,
    skillError: `local Memory Skill suggestion failed (409): ${message}` });
  expect(JSON.parse(readFileSync(path.join(input.root, "memory-sync-state.json"), "utf8")).pendingSkillGroups.group).toEqual(group);
  await adapter.close();
});

test.each([409, 500])("keeps unknown HTTP %s failures without exposing upstream content", async (status) => {
  const input = fixture();
  let enabled = false;
  mockService(() => Response.json({ error: { code: "conflict", message: "PRIVATE_SOURCE_SENTINEL" } }, { status }));
  const adapter = new HistoryMemoryAdapter({ ...input, enabled: () => enabled, listSkillGroups: () => [group] });
  enabled = true;
  await adapter.flushNow();
  expect(adapter.status().skillError).toBe(`local Memory Skill suggestion failed (${status})`);
  await adapter.close();
});

test("one pending group does not clear another group's actual failure", async () => {
  const input = fixture();
  let enabled = false;
  const adapter = new HistoryMemoryAdapter({ ...input, enabled: () => enabled,
    listSkillGroups: () => [group, { ...group, id: "failed-group" }],
    suggest: async (payload) => {
      if (payload.groupId === "group") return { status: "pending" };
      throw new Error("model unavailable");
    } });
  enabled = true;
  await adapter.flushNow();
  expect(adapter.status().skillError).toBe("model unavailable");
  enabled = false;
  adapter.revokeAll();
  await adapter.flushNow();
  expect(JSON.parse(readFileSync(path.join(input.root, "memory-sync-state.json"), "utf8")).pendingSkillGroups).toEqual({});
  await adapter.close();
});
