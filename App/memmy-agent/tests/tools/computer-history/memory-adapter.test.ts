import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { HistoryMemoryAdapter, type HistoryEvidence } from "../../../src/tools/computer-history/memory-adapter.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("passive History only reaches Memory after opt-in, and deletion survives restart", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "history-memory-adapter-"));
  roots.push(root);
  let enabled = false;
  const entry: HistoryEvidence = {
    id: "2026-09-27T10-00-00-10min-summary", title: "Release note", content: "Wrote release note",
    revision: "2026-09-27T10:10:00.000Z", startedAt: "2026-09-27T10:00:00.000Z",
    endedAt: "2026-09-27T10:10:00.000Z", applications: ["win32.notepad"],
  };
  const sent: Array<{ action: string; sourceRecordId: string; content?: string }> = [];
  const make = () => new HistoryMemoryAdapter({ historyDirectory: root,
    enabled: () => enabled, listEvidence: () => [entry], userId: () => "local-user",
    post: async (payload) => { sent.push(payload); return { id: `memory-${payload.sourceRecordId}` }; },
  });
  const adapter = make();
  await adapter.flushNow();
  expect(sent).toEqual([]);
  enabled = true;
  await adapter.flushNow();
  expect(sent).toMatchObject([{ action: "upsert", sourceRecordId: entry.id, content: entry.content }]);
  await adapter.flushNow();
  expect(sent).toHaveLength(1);
  await adapter.close();

  const resumed = make();
  await resumed.flushNow();
  expect(sent).toHaveLength(1);
  resumed.remove(entry.id);
  expect(JSON.parse(readFileSync(path.join(root, "memory-sync-state.json"), "utf8")).deleted).toHaveProperty(entry.id);
  await resumed.flushNow();
  expect(sent.at(-1)).toMatchObject({ action: "delete", sourceRecordId: entry.id });
  expect(JSON.parse(readFileSync(path.join(root, "memory-sync-state.json"), "utf8"))).toMatchObject({
    synced: {}, deleted: { [entry.id]: expect.any(String) }, deleteAck: { [entry.id]: expect.any(String) },
  });
  await resumed.close();
});

test("a pre-upgrade sync state recovers the Memory ID without duplicating evidence", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "history-memory-upgrade-"));
  roots.push(root);
  const id = "2026-09-27T10-00-00-10min-summary";
  const revision = "2026-09-27T10:10:00.000Z";
  writeFileSync(path.join(root, "memory-sync-state.json"), JSON.stringify({
    synced: { [id]: revision }, deleted: {}, deleteAck: {}
  }));
  let calls = 0;
  const adapter = new HistoryMemoryAdapter({ historyDirectory: root,
    enabled: () => true, userId: () => "local-user",
    listEvidence: () => [{ id, title: "Notes", content: "Drafted notes", revision,
      startedAt: "2026-09-27T10:00:00.000Z", endedAt: revision, applications: [] }],
    post: async () => { calls += 1; return { id: "existing-memory" }; }
  });
  await adapter.flushNow();
  await adapter.flushNow();
  expect(calls).toBe(1);
  expect(adapter.memoryIdFor(id)).toBe("existing-memory");
  await adapter.close();
});

test("a Memory tombstone stays deleted when History tries to recover an old link", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "history-memory-remote-delete-"));
  roots.push(root);
  const id = "2026-09-27T10-00-00-10min-summary";
  const revision = "2026-09-27T10:10:00.000Z";
  writeFileSync(path.join(root, "memory-sync-state.json"), JSON.stringify({
    synced: { [id]: revision }, deleted: {}, deleteAck: {}
  }));
  const actions: string[] = [];
  const adapter = new HistoryMemoryAdapter({ historyDirectory: root,
    enabled: () => true, userId: () => "local-user",
    listEvidence: () => [{ id, title: "Notes", content: "Drafted notes", revision,
      startedAt: "2026-09-27T10:00:00.000Z", endedAt: revision, applications: [] }],
    post: async (payload) => { actions.push(payload.action);
      return { id: "deleted-memory", status: "deleted" }; }
  });
  await adapter.flushNow();
  expect(adapter.memoryIdFor(id)).toBeUndefined();
  expect(actions).toEqual(["upsert", "delete"]);
  await adapter.close();
});

test("Memory-side deletion clears History shortcuts without re-creating observations or Skills", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "history-memory-status-"));
  roots.push(root);
  const ids = ["first-10min-summary", "second-10min-summary"];
  const revision = "2026-09-27T10:10:00.000Z";
  let deleted = false;
  const posted: string[] = [];
  const links: Array<{ id: string | null; previous?: string }> = [];
  const adapter = new HistoryMemoryAdapter({ historyDirectory: root,
    enabled: () => true, userId: () => "local-user",
    listEvidence: () => ids.map((id) => ({ id, title: id, content: id, revision,
      startedAt: "2026-09-27T10:00:00.000Z", endedAt: revision, applications: [] })),
    listSkillGroups: () => [{ id: "group", revision, sourceRecordIds: ids,
      actions: ids.flatMap((id) => [{ sourceRecordId: id, text: "Open" },
        { sourceRecordId: id, text: "Save" }]) }],
    post: async (payload) => { posted.push(`${payload.action}:${payload.sourceRecordId}`);
      return { id: `memory-${payload.sourceRecordId}` }; },
    suggest: async () => ({ status: "candidate", id: "skill-1" }),
    status: async (payload) => ({
      evidence: payload.sourceRecordIds.map((id) => ({ sourceRecordId: id, id: `memory-${id}`,
        status: deleted && id === ids[0] ? "deleted" : "activated" })),
      skills: payload.skillIds.map((id) => ({ id, status: deleted ? "deleted" : "resolving" }))
    }),
    onSkillCandidate: (_group, id, previous) => links.push({ id, ...(previous ? { previous } : {}) })
  });
  await adapter.flushNow();
  expect(links).toEqual([{ id: "skill-1" }]);
  deleted = true;
  await adapter.flushNow();
  expect(adapter.memoryIdFor(ids[0]!)).toBeUndefined();
  expect(links.at(-1)).toEqual({ id: null, previous: "skill-1" });
  expect(posted.filter((item) => item === `upsert:${ids[0]}`)).toHaveLength(1);
  expect(posted).toContain(`delete:${ids[0]}`);
  await adapter.close();
});

test("a changed Memory user keeps syncing and deleting the original local History", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "history-memory-user-switch-"));
  roots.push(root);
  let userId = "first-user";
  const posted: string[] = [];
  const make = () => new HistoryMemoryAdapter({ historyDirectory: root,
    enabled: () => true, userId: () => userId,
    listEvidence: () => [{ id: "first-10min-summary", title: "Private note", content: "Private note",
      revision: "2026-09-27T10:10:00.000Z", startedAt: "2026-09-27T10:00:00.000Z",
      endedAt: "2026-09-27T10:10:00.000Z", applications: [] }],
    post: async (payload) => {
      posted.push(`${payload.namespace.userId}:${payload.action}`);
      return { id: "memory-first" };
    },
  });
  const first = make();
  await first.flushNow();
  await first.close();
  userId = "second-user";
  const second = make();
  await second.flushNow();
  second.remove("first-10min-summary");
  await second.flushNow();
  expect(posted).toEqual(["first-user:upsert", "first-user:delete"]);
  expect(second.status().error).toBeNull();
  await second.close();
});

test("a failed Memory sync is visible and clears after retry", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "history-memory-retry-"));
  roots.push(root);
  let available = false;
  const adapter = new HistoryMemoryAdapter({
    historyDirectory: root, enabled: () => true, userId: () => "local-user",
    listEvidence: () => [{ id: "2026-09-27T10-00-00-10min-summary", title: "Notes",
      content: "Drafted notes", revision: "2026-09-27T10:10:00.000Z",
      startedAt: "2026-09-27T10:00:00.000Z", endedAt: "2026-09-27T10:10:00.000Z", applications: [] }],
    post: async () => { if (!available) throw new Error("service unavailable"); },
  });
  await adapter.flushNow();
  expect(adapter.status()).toMatchObject({ error: "service unavailable", lastSyncedAt: null });
  available = true;
  await adapter.flushNow();
  expect(adapter.status().error).toBeNull();
  expect(adapter.status().lastSyncedAt).toMatch(/^\d{4}-/u);
  await adapter.close();
});

test("a closed rollup links one reviewable Skill to several History sources and retracts on opt-out", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "history-memory-skill-"));
  roots.push(root);
  let enabled = true;
  const first = "2026-09-27T10-00-00-10min-summary";
  const second = "2026-09-27T10-10-00-10min-summary";
  const rollup = "2026-09-27T06-00-00-6h-summary";
  const evidence = [first, second, rollup].map((id) => ({ id, title: id, content: `Observed ${id}`,
    revision: "2026-09-27T12:10:00.000Z", startedAt: "2026-09-27T10:00:00.000Z",
    endedAt: "2026-09-27T10:10:00.000Z", applications: [] }));
  const suggestions: string[] = [];
  const links: Array<{ id: string | null; sources: string[] }> = [];
  const adapter = new HistoryMemoryAdapter({ historyDirectory: root, enabled: () => enabled,
    userId: () => "local-user", listEvidence: () => evidence,
    listSkillGroups: () => [{ id: rollup, revision: "2026-09-27T12:10:00.000Z",
      sourceRecordIds: [rollup, first, second], actions: [
        { sourceRecordId: first, text: "Open editor" }, { sourceRecordId: first, text: "Draft" },
        { sourceRecordId: second, text: "Review" }, { sourceRecordId: second, text: "Save" }] }],
    post: async (payload) => ({ id: `memory-${payload.sourceRecordId}` }),
    suggest: async (payload) => { suggestions.push(payload.groupId); return { status: "candidate", id: "skill-1" }; },
    onSkillCandidate: (group, id) => { links.push({ id, sources: group.sourceRecordIds }); },
  });
  await adapter.flushNow();
  expect(suggestions).toEqual([rollup]);
  expect(adapter.memoryIdFor(first)).toBe(`memory-${first}`);
  expect(links).toEqual([{ id: "skill-1", sources: [rollup, first, second] }]);
  await adapter.flushNow();
  expect(suggestions).toHaveLength(1);
  enabled = false;
  adapter.revokeAll();
  expect(adapter.memoryIdFor(first)).toBeUndefined();
  expect(links.at(-1)).toEqual({ id: null, sources: [rollup, first, second] });
  await adapter.flushNow();
  await adapter.close();
});

test("a missing Skill model does not block evidence sync or deletion", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "history-memory-skill-failure-"));
  roots.push(root);
  let enabled = true;
  const ids = ["first-10min-summary", "second-10min-summary", "rollup-6h-summary"];
  const sent: string[] = [];
  const adapter = new HistoryMemoryAdapter({ historyDirectory: root, enabled: () => enabled,
    userId: () => "local-user",
    listEvidence: () => ids.map((id) => ({ id, title: id, content: id,
      revision: "2026-09-27T12:10:00.000Z", startedAt: "2026-09-27T10:00:00.000Z",
      endedAt: "2026-09-27T10:10:00.000Z", applications: [] })),
    listSkillGroups: () => [{ id: ids[2]!, revision: "2026-09-27T12:10:00.000Z",
      sourceRecordIds: ids, actions: ids.slice(0, 2).flatMap((id) => [
        { sourceRecordId: id, text: "Open editor" }, { sourceRecordId: id, text: "Save" }]) }],
    post: async (payload) => { sent.push(`${payload.action}:${payload.sourceRecordId}`); return { id: payload.sourceRecordId }; },
    suggest: async () => { throw new Error("model unavailable"); }
  });
  await adapter.flushNow();
  expect(sent).toHaveLength(3);
  expect(adapter.status()).toMatchObject({ error: null, skillError: "model unavailable" });
  enabled = false;
  adapter.revokeAll();
  await adapter.flushNow();
  expect(sent.filter((item) => item.startsWith("delete:"))).toHaveLength(3);
  await adapter.close();
});

test("an offline Memory service can retry staged semantic steps after raw events expire", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "history-memory-offline-skill-"));
  roots.push(root);
  const ids = ["first-10min-summary", "second-10min-summary", "rollup-6h-summary"];
  let available = false;
  let rawEventsExpired = false;
  const suggestions: string[] = [];
  const group = { id: ids[2]!, revision: "2026-09-27T12:10:00.000Z",
    sourceRecordIds: ids, actions: ids.slice(0, 2).flatMap((id) => [
      { sourceRecordId: id, text: "Open editor" }, { sourceRecordId: id, text: "Save" }]) };
  const make = () => new HistoryMemoryAdapter({ historyDirectory: root, enabled: () => true,
    userId: () => "local-user",
    listEvidence: () => ids.map((id) => ({ id, title: id, content: id,
      revision: "2026-09-27T12:10:00.000Z", startedAt: "2026-09-27T10:00:00.000Z",
      endedAt: "2026-09-27T10:10:00.000Z", applications: [] })),
    listSkillGroups: () => rawEventsExpired ? [] : [group],
    post: async (payload) => { if (!available) throw new Error("Memory offline");
      return { id: `memory-${payload.sourceRecordId}` }; },
    suggest: async (payload) => { suggestions.push(payload.groupId);
      return { status: "candidate" as const, id: "skill-after-recovery" }; }
  });
  const offline = make();
  await offline.flushNow();
  expect(offline.status().error).toBe("Memory offline");
  expect(Object.keys(JSON.parse(readFileSync(path.join(root, "memory-sync-state.json"), "utf8")).pendingSkillGroups))
    .toEqual([group.id]);
  await offline.close();

  rawEventsExpired = true;
  available = true;
  const recovered = make();
  await recovered.flushNow();
  expect(suggestions).toEqual([group.id]);
  expect(JSON.parse(readFileSync(path.join(root, "memory-sync-state.json"), "utf8")).pendingSkillGroups).toEqual({});
  await recovered.close();
});

test("deleting a source during Skill suggestion leaves no History link or Memory evidence", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "history-memory-race-"));
  roots.push(root);
  const ids = ["first-10min-summary", "second-10min-summary"];
  let releaseSuggestion!: (value: { status: "candidate"; id: string }) => void;
  let suggestionStarted!: () => void;
  const started = new Promise<void>((resolve) => { suggestionStarted = resolve; });
  const awaitingSuggestion = new Promise<{ status: "candidate"; id: string }>((resolve) => {
    releaseSuggestion = resolve;
  });
  const sent: string[] = [];
  const linked: string[] = [];
  const adapter = new HistoryMemoryAdapter({ historyDirectory: root, enabled: () => true,
    userId: () => "local-user",
    listEvidence: () => ids.map((id) => ({ id, title: id, content: id,
      revision: "2026-09-27T12:10:00.000Z", startedAt: "2026-09-27T10:00:00.000Z",
      endedAt: "2026-09-27T10:10:00.000Z", applications: [] })),
    listSkillGroups: () => [{ id: "group", revision: "2026-09-27T12:10:00.000Z",
      sourceRecordIds: ids, actions: ids.flatMap((id) => [
        { sourceRecordId: id, text: "Open editor" }, { sourceRecordId: id, text: "Save" }]) }],
    post: async (payload) => { sent.push(`${payload.action}:${payload.sourceRecordId}`); return { id: payload.sourceRecordId }; },
    suggest: async () => { suggestionStarted(); return awaitingSuggestion; },
    onSkillCandidate: (_group, id) => { if (id) linked.push(id); },
  });
  await started;
  adapter.remove(ids[0]!);
  releaseSuggestion({ status: "candidate", id: "skill-after-delete" });
  await adapter.flushNow();
  expect(linked).toEqual([]);
  expect(sent).toContain(`delete:${ids[0]}`);
  await adapter.close();
});

test("switching off Memory sync during an upload stops later uploads and retracts the in-flight one", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "history-memory-disable-race-"));
  roots.push(root);
  let enabled = true;
  let finishUpload!: (value: { id: string }) => void;
  let uploadStarted!: () => void;
  const started = new Promise<void>((resolve) => { uploadStarted = resolve; });
  const uploading = new Promise<{ id: string }>((resolve) => { finishUpload = resolve; });
  const actions: string[] = [];
  const adapter = new HistoryMemoryAdapter({ historyDirectory: root, enabled: () => enabled,
    userId: () => "local-user", listEvidence: () => ["first", "second"].map((name) => ({
      id: `${name}-10min-summary`, title: name, content: name,
      revision: "2026-09-27T12:10:00.000Z", startedAt: "2026-09-27T10:00:00.000Z",
      endedAt: "2026-09-27T10:10:00.000Z", applications: [] })),
    post: async (payload) => { actions.push(`${payload.action}:${payload.sourceRecordId}`);
      if (payload.action === "upsert") { uploadStarted(); return uploading; }
      return { id: payload.sourceRecordId }; }
  });
  await started;
  enabled = false;
  adapter.revokeAll();
  finishUpload({ id: "memory-first" });
  await adapter.flushNow();
  expect(actions).toEqual(["upsert:first-10min-summary", "delete:first-10min-summary"]);
  expect(adapter.memoryIdFor("first-10min-summary")).toBeUndefined();
  await adapter.close();
});
