import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { HistoryMemoryAdapter, type HistoryEvidence } from "../../../src/tools/computer-history/memory-adapter.js";

const roots: string[] = [];
const adapters: HistoryMemoryAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const revision = "2026-10-09T10:10:00.000Z";
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "history-memory-isolation-"));
  roots.push(root);
  const entries: HistoryEvidence[] = ["first", "second"].map((name) => ({
    id: `${name}-10min-summary`, title: name, content: name, revision,
    startedAt: "2026-10-09T10:00:00.000Z", endedAt: revision, applications: [],
  }));
  return { root, entries };
}

test("one unavailable source does not starve later evidence or lose its retry", async () => {
  const { root, entries } = fixture();
  let failFirst = true;
  const calls: string[] = [];
  const adapter = new HistoryMemoryAdapter({ historyDirectory: root, enabled: () => true,
    userId: () => "local-user", listEvidence: () => entries,
    post: async ({ sourceRecordId }) => {
      calls.push(sourceRecordId);
      if (sourceRecordId === entries[0]!.id && failFirst) throw new Error("first source unavailable");
      return { id: `memory-${sourceRecordId}` };
    } });
  adapters.push(adapter);
  await adapter.flushNow();
  expect(calls.slice(0, 2)).toEqual(entries.map((entry) => entry.id));
  expect(calls.filter((id) => id === entries[1]!.id)).toHaveLength(1);
  expect(adapter.memoryIdFor(entries[0]!.id)).toBeUndefined();
  expect(adapter.memoryIdFor(entries[1]!.id)).toBe(`memory-${entries[1]!.id}`);
  expect(adapter.status().error).toBe("first source unavailable");
  expect(JSON.parse(readFileSync(path.join(root, "memory-sync-state.json"), "utf8")).synced)
    .toEqual({ [entries[1]!.id]: revision });
  const beforeRetry = calls.length;
  failFirst = false;
  await adapter.flushNow();
  expect(calls.slice(beforeRetry)).toEqual([entries[0]!.id]);
  expect(adapter.status().error).toBeNull();
});

test("an upload success does not hide a failed reconciliation", async () => {
  const { root, entries } = fixture();
  writeFileSync(path.join(root, "memory-sync-state.json"), JSON.stringify({
    synced: { [entries[0]!.id]: revision }, deleted: {}, deleteAck: {},
    memoryIds: { [entries[0]!.id]: "existing-memory" },
  }));
  let failStatus = true;
  const calls: string[] = [];
  const adapter = new HistoryMemoryAdapter({ historyDirectory: root, enabled: () => true,
    userId: () => "local-user", listEvidence: () => entries,
    post: async ({ sourceRecordId }) => { calls.push(sourceRecordId); return { id: `memory-${sourceRecordId}` }; },
    status: async ({ sourceRecordIds }) => {
      if (failStatus) throw new Error("reconciliation unavailable");
      return { evidence: sourceRecordIds.map((sourceRecordId) => ({ sourceRecordId,
        status: "activated" as const, id: `memory-${sourceRecordId}` })), skills: [] };
    } });
  adapters.push(adapter);
  await adapter.flushNow();
  expect(calls).toEqual([entries[1]!.id]);
  expect(adapter.status().error).toBe("reconciliation unavailable");
  failStatus = false;
  await adapter.flushNow();
  expect(adapter.status().error).toBeNull();
  expect(calls).toEqual([entries[1]!.id]);
});

test("failed revocations allow other deletes but hold new uploads until retry", async () => {
  const { root, entries } = fixture();
  const deleted = ["old-first-10min-summary", "old-second-10min-summary"];
  writeFileSync(path.join(root, "memory-sync-state.json"), JSON.stringify({ synced: {},
    deleted: Object.fromEntries(deleted.map((id) => [id, revision])), deleteAck: {}, memoryIds: {} }));
  let failDelete = true;
  const calls: string[] = [];
  const adapter = new HistoryMemoryAdapter({ historyDirectory: root, enabled: () => true,
    userId: () => "local-user", listEvidence: () => entries,
    post: async ({ action, sourceRecordId }) => {
      calls.push(`${action}:${sourceRecordId}`);
      if (sourceRecordId === deleted[0] && failDelete) throw new Error("delete unavailable");
      return { id: sourceRecordId };
    } });
  adapters.push(adapter);
  await adapter.flushNow();
  expect(calls.slice(0, 2)).toEqual(deleted.map((id) => `delete:${id}`));
  expect(calls.every((call) => call.startsWith("delete:"))).toBe(true);
  const beforeRetry = calls.length;
  expect(adapter.status()).toMatchObject({ pendingDeletionCount: 1, error: "delete unavailable" });
  failDelete = false;
  await adapter.flushNow();
  expect(calls.slice(beforeRetry)).toEqual([`delete:${deleted[0]}`, ...entries.map((entry) => `upsert:${entry.id}`)]);
  expect(adapter.status()).toMatchObject({ pendingDeletionCount: 0, error: null });
});

test("a successful Skill does not hide another group's failure", async () => {
  const { root, entries } = fixture();
  let firstUnavailable = true;
  const calls: string[] = [];
  const adapter = new HistoryMemoryAdapter({ historyDirectory: root, enabled: () => true,
    userId: () => "local-user", listEvidence: () => entries,
    post: async ({ sourceRecordId }) => ({ id: sourceRecordId }),
    listSkillGroups: () => entries.map((entry) => ({ id: entry.id, revision,
      sourceRecordIds: [entry.id], actions: [{ sourceRecordId: entry.id, text: "Read notes" }] })),
    suggest: async ({ groupId }) => {
      calls.push(groupId);
      if (groupId === entries[0]!.id && firstUnavailable) throw new Error("first Skill unavailable");
      return { status: "candidate", id: `skill-${groupId}` };
    } });
  adapters.push(adapter);
  await adapter.flushNow();
  expect(calls.slice(0, 2)).toEqual(entries.map((entry) => entry.id));
  expect(calls.filter((id) => id === entries[1]!.id)).toHaveLength(1);
  expect(adapter.status().skillError).toBe("first Skill unavailable");
  const beforeRetry = calls.length;
  firstUnavailable = false;
  await adapter.flushNow();
  expect(calls.slice(beforeRetry)).toEqual([entries[0]!.id]);
  expect(adapter.status().skillError).toBeNull();
});

test("a stale synced revision cannot support a new Skill when its update failed", async () => {
  const { root, entries } = fixture();
  const entry = entries[0]!;
  writeFileSync(path.join(root, "memory-sync-state.json"), JSON.stringify({
    synced: { [entry.id]: "2026-10-09T10:01:00.000Z" }, deleted: {}, deleteAck: {},
    memoryIds: { [entry.id]: "old-memory" },
  }));
  let unavailable = true;
  const suggestions: string[] = [];
  const adapter = new HistoryMemoryAdapter({ historyDirectory: root, enabled: () => true,
    userId: () => "local-user", listEvidence: () => [entry],
    post: async () => { if (unavailable) throw new Error("update unavailable"); return { id: "old-memory" }; },
    listSkillGroups: () => [{ id: "new-group", revision, sourceRecordIds: [entry.id],
      actions: [{ sourceRecordId: entry.id, text: "Read new notes" }] }],
    suggest: async ({ groupId }) => { suggestions.push(groupId); return { status: "candidate", id: "new-skill" }; } });
  adapters.push(adapter);
  await adapter.flushNow();
  expect(suggestions).toEqual([]);
  unavailable = false;
  await adapter.flushNow();
  expect(suggestions).toEqual(["new-group"]);
});

test("an acknowledged source still retries a failed local state save", async () => {
  const { root, entries } = fixture();
  let enabled = false;
  let failSave = false;
  let uploads = 0;
  const rename = fs.renameSync;
  const stateFile = path.join(root, "memory-sync-state.json");
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to) === stateFile && failSave) throw new Error("state save unavailable");
    return rename(from, to);
  });
  const adapter = new HistoryMemoryAdapter({ historyDirectory: root, enabled: () => enabled,
    userId: () => "local-user", listEvidence: () => [entries[0]!],
    post: async ({ sourceRecordId }) => { uploads++; failSave = true; return { id: sourceRecordId }; } });
  adapters.push(adapter);
  enabled = true;
  await adapter.flushNow();
  expect(uploads).toBe(1);
  expect(adapter.status().error).toBe("state save unavailable");
  await adapter.flushNow();
  expect(adapter.status().error).toBe("state save unavailable");
  expect(uploads).toBe(1);
  expect(JSON.parse(readFileSync(stateFile, "utf8")).synced).toEqual({});
  failSave = false;
  await adapter.flushNow();
  expect(uploads).toBe(1);
  expect(JSON.parse(readFileSync(stateFile, "utf8")).synced).toEqual({ [entries[0]!.id]: revision });
  expect(adapter.status().error).toBeNull();
});

test.each(["opt-out", "remove"])("a persistent disk failure cannot block a remote %s", async (action) => {
  const { root, entries } = fixture();
  let enabled = false;
  let failSave = false;
  const calls: string[] = [];
  let failFirstSave = true;
  const rename = fs.renameSync;
  const stateFile = path.join(root, "memory-sync-state.json");
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to) === stateFile && failSave) throw new Error("state save unavailable");
    return rename(from, to);
  });
  const adapter = new HistoryMemoryAdapter({ historyDirectory: root, enabled: () => enabled,
    userId: () => "local-user", listEvidence: () => entries,
    post: async ({ action, sourceRecordId }) => {
      calls.push(`${action}:${sourceRecordId}`);
      if (action === "upsert" && failFirstSave) { failSave = true; failFirstSave = false; }
      return { id: sourceRecordId };
    } });
  adapters.push(adapter);
  enabled = true;
  await adapter.flushNow();
  if (action === "opt-out") enabled = false;
  expect(() => action === "opt-out" ? adapter.revokeAll() : adapter.remove(entries[0]!.id))
    .toThrow("state save unavailable");
  await adapter.flushNow();
  expect(calls).toContain(`delete:${entries[0]!.id}`);
  expect(adapter.memoryIdFor(entries[0]!.id)).toBeUndefined();
  expect(adapter.status().error).toBe("state save unavailable");
  failSave = false;
  await adapter.flushNow();
  expect(JSON.parse(readFileSync(stateFile, "utf8")).deleteAck).toHaveProperty(entries[0]!.id);
  expect(adapter.status().error).toBeNull();
});

test("a restart while opted out retracts a journaled upload that had no durable acknowledgement", async () => {
  const { root, entries } = fixture();
  const entry = entries[0]!;
  writeFileSync(path.join(root, "memory-sync-state.json"), JSON.stringify({
    namespaceUserId: "original-user", synced: {}, memoryIds: {}, deleted: {}, deleteAck: {},
    pendingUpserts: { [entry.id]: revision },
  }));
  const calls: string[] = [];
  const adapter = new HistoryMemoryAdapter({ historyDirectory: root, enabled: () => false,
    userId: () => "changed-user", listEvidence: () => [],
    post: async ({ action, sourceRecordId, namespace }) => {
      calls.push(`${namespace.userId}:${action}:${sourceRecordId}`);
      return { id: sourceRecordId };
    } });
  adapters.push(adapter);
  await adapter.flushNow();
  expect(calls).toEqual([`original-user:delete:${entry.id}`]);
  expect(JSON.parse(readFileSync(path.join(root, "memory-sync-state.json"), "utf8")))
    .toMatchObject({ pendingUpserts: {}, deleteAck: { [entry.id]: expect.any(String) } });
});

test("a new upload waits until its source identity can be journaled", async () => {
  const { root, entries } = fixture();
  let enabled = false;
  let failSave = true;
  const rename = fs.renameSync;
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to) === path.join(root, "memory-sync-state.json") && failSave) throw new Error("state save unavailable");
    return rename(from, to);
  });
  const calls: string[] = [];
  const adapter = new HistoryMemoryAdapter({ historyDirectory: root, enabled: () => enabled,
    userId: () => "local-user", listEvidence: () => entries,
    post: async ({ sourceRecordId }) => { calls.push(sourceRecordId); return { id: sourceRecordId }; } });
  adapters.push(adapter);
  enabled = true;
  await adapter.flushNow();
  expect(calls).toEqual([]);
  expect(adapter.status().error).toBe("state save unavailable");
  failSave = false;
  await adapter.flushNow();
  expect(calls).toEqual(entries.map((entry) => entry.id));
  expect(JSON.parse(readFileSync(path.join(root, "memory-sync-state.json"), "utf8")).pendingUpserts).toEqual({});
  expect(adapter.status().error).toBeNull();
});
