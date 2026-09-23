import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openAppAgentSourceScanStore } from "../index.js";

let directory: string | undefined;
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; });

describe("durable scan store", () => {
  it("refreshes unresolved Codex rows in the same job without counting them as new messages", () => {
    directory = mkdtempSync(join(tmpdir(), "memmy-codex-scan-retry-"));
    const path = join(directory, "job.sqlite");
    const job = { jobId: "job", sourceId: "codex", mode: "incremental", phase: "failed", createdAt: "2026-09-09", updatedAt: "2026-09-09" };
    let store = openAppAgentSourceScanStore(path, job);
    const pending = { messageId: "rollout:000000000009", sourceId: "codex", conversationId: "fallback-conversation", role: "assistant" as const, content: "Draft", createdAt: "2026-09-09T00:00:00Z", workspacePath: null, gitRoot: null, rawMeta: { sourceTurnState: "identity_unresolved", sourceTurnReason: "identity_unresolved" } };
    expect(store.stage(pending)).toBe(true);
    const stagedOrdinal = [...store.messages("codex")][0]!.ordinal;
    store.saveResult({ sourceId: "codex", conversationId: pending.conversationId, error: "identity_unresolved" });
    store.close();
    store = openAppAgentSourceScanStore(path, job);
    const completed = { ...pending, content: "Final answer", workspacePath: "/tmp/project", rawMeta: { sourceTurnState: "complete", sourceTurnId: "turn-native", sourceTurn: { turnId: "turn-native", completionEvidence: "task_complete:turn-native" } } };
    const next = { ...completed, messageId: "rollout:000000000010", content: "Next answer" };
    expect(store.stageBatch([completed, next])).toBe(1);
    expect(store.stage(completed)).toBe(false);
    expect(store.count("codex")).toBe(2);
    const rows = [...store.messages("codex")];
    expect(rows[0]).toMatchObject({ ...completed, ordinal: stagedOrdinal });
    expect(rows[0]!.rawMeta).not.toHaveProperty("sourceTurnReason");
    expect([...store.results("codex")]).toEqual([{ sourceId: "codex", conversationId: pending.conversationId, error: "identity_unresolved" }]);
    store.close();
    store = openAppAgentSourceScanStore(path, job);
    expect([...store.messages("codex")][0]).toMatchObject(completed);
    store.close();
  });

  it("keeps existing non-Codex staged rows and unrelated rows unchanged", () => {
    directory = mkdtempSync(join(tmpdir(), "memmy-scan-legacy-dedup-"));
    const store = openAppAgentSourceScanStore(join(directory, "job.sqlite"), { jobId: "job", sourceId: "all", mode: "full", phase: "stage", createdAt: "2026-09-09", updatedAt: "2026-09-09" });
    const message = { messageId: "shared-id", sourceId: "fixture", conversationId: "conversation", role: "user" as const, content: "Original", createdAt: "2026-09-09T00:00:00Z", workspacePath: null, gitRoot: null, rawMeta: {} };
    const codex = { ...message, sourceId: "codex", rawMeta: { sourceTurnState: "turn_incomplete" } };
    expect(store.stageBatch([message, codex])).toBe(2);
    expect(store.stage({ ...message, content: "Revised" })).toBe(false);
    expect(store.stage({ ...codex, content: "Complete", rawMeta: { sourceTurnState: "complete" } })).toBe(false);
    expect([...store.messages("fixture")][0]!.content).toBe("Original");
    expect([...store.messages("codex")][0]!.content).toBe("Complete");
    expect(store.count()).toBe(2);
    store.close();
  });
  it("deduplicates staged rows and reads keyset pages", () => {
    directory = mkdtempSync(join(tmpdir(), "memmy-scan-store-"));
    const store = openAppAgentSourceScanStore(join(directory, "job.sqlite"), { jobId: "job", sourceId: "fixture", mode: "full", phase: "stage", createdAt: "2026-01-01", updatedAt: "2026-01-01" });
    const message = { messageId: "m1", sourceId: "fixture", conversationId: "c1", role: "user" as const, content: "hello", createdAt: "2026-01-01T00:00:00Z", workspacePath: null, gitRoot: null, rawMeta: {} };
    expect(store.stageBatch([message, message])).toBe(1);
    store.saveSourceState({ sourceId: "fixture", mode: "full", phase: "stage", messageCount: 1, resultCount: 0, errorCount: 0, updatedAt: "2026-01-01" });
    expect(store.sourceCount()).toBe(1);
    expect([...store.messages("fixture", undefined, 1)]).toHaveLength(1);
    store.saveResult({ sourceId: "fixture", conversationId: "c1", memoryId: "memory-1" });
    store.saveResult({ sourceId: "fixture", conversationId: "c1", memoryId: "memory-1" });
    expect([...store.results("fixture", "0", 1)]).toEqual([{ sourceId: "fixture", conversationId: "c1", memoryId: "memory-1" }]);
    store.remove();
  });

  it("selects global recent turns and keeps an absent source fallback", () => {
    directory = mkdtempSync(join(tmpdir(), "memmy-scan-store-"));
    const store = openAppAgentSourceScanStore(join(directory, "job.sqlite"), { jobId: "job", sourceId: "all", mode: "initial_subset", phase: "prepare", createdAt: "2026-01-01", updatedAt: "2026-01-01" });
    const addTurn = (sourceId: string, index: number, day: string) => store.saveTurnMeta({
      sourceId,
      conversationId: `conversation-${sourceId}-${index}`,
      turnId: `${sourceId}::conversation-${sourceId}-${index}::user-${index}`,
      firstMessageId: `user-${index}`,
      firstCreatedAt: `2026-01-${day}T00:00:00Z`,
      lastMessageId: `assistant-${index}`,
      lastCreatedAt: `2026-01-${day}T00:01:00Z`,
      selected: true
    });
    addTurn("source-a", 1, "01");
    addTurn("source-b", 1, "02");
    store.selectInitialTurns(["source-a", "source-b"], 1, 1);
    expect(store.getTurnMeta("source-b", "conversation-source-b-1", "source-b::conversation-source-b-1::user-1")?.selected).toBe(true);
    expect(store.getTurnMeta("source-a", "conversation-source-a-1", "source-a::conversation-source-a-1::user-1")?.selected).toBe(true);
    store.remove();
  });

  it("keeps shared Cursor bubble ids in separate conversations", () => {
    directory = mkdtempSync(join(tmpdir(), "memmy-scan-shared-bubble-"));
    const store = openAppAgentSourceScanStore(join(directory, "job.sqlite"), { jobId: "job", sourceId: "cursor", mode: "full", phase: "stage", createdAt: "2026-09-09", updatedAt: "2026-09-09" });
    const base = { sourceId: "cursor", messageId: "shared-bubble", role: "user" as const, content: "same forked user message", createdAt: "2026-09-09T00:00:00Z", workspacePath: null, gitRoot: null, rawMeta: { sourceTurnState: "complete", sourceTurnId: "shared-bubble" } };
    expect(store.stage({ ...base, conversationId: "c1" })).toBe(true);
    expect(store.stage({ ...base, conversationId: "c2" })).toBe(true);
    expect(store.stage({ ...base, conversationId: "c1", content: "refreshed", rawMeta: { sourceTurnState: "complete", sourceTurnId: "shared-bubble", sourceTurn: { turnId: "shared-bubble" } } })).toBe(false);
    expect(store.count("cursor")).toBe(2);
    expect(store.conversationCount("cursor")).toBe(2);
    const rows = [...store.messages("cursor")];
    expect(rows.map((row) => row.conversationId).sort()).toEqual(["c1", "c2"]);
    expect(rows.find((row) => row.conversationId === "c1")?.content).toBe("refreshed");
    expect(rows.find((row) => row.conversationId === "c2")?.content).toBe("same forked user message");
    store.close();
  });

  it("upgrades a pre-job_id store and recovers a leftover v3 table", () => {
    directory = mkdtempSync(join(tmpdir(), "memmy-scan-schema1-"));
    const path = join(directory, "job.sqlite");
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE schema_meta (version INTEGER NOT NULL);
      INSERT INTO schema_meta(version) VALUES (1);
      CREATE TABLE staged_messages (
        source_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        workspace_path TEXT,
        git_root TEXT,
        raw_meta_json TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (source_id, message_id)
      );
      CREATE TABLE staged_messages_v3 (job_id TEXT);
      INSERT INTO staged_messages VALUES ('cursor','c1','shared-bubble','user','original','2026-09-09T00:00:00Z',null,null,'{}',7);
    `);
    raw.close();
    const job = { jobId: "job", sourceId: "cursor", mode: "full", phase: "stage", createdAt: "2026-09-09", updatedAt: "2026-09-09" };
    const store = openAppAgentSourceScanStore(path, job);
    expect([...store.messages("cursor")][0]).toMatchObject({ conversationId: "c1", content: "original", ordinal: 7 });
    expect(store.stage({
      sourceId: "cursor",
      conversationId: "c2",
      messageId: "shared-bubble",
      role: "user",
      content: "same forked user message",
      createdAt: "2026-09-09T00:00:00Z",
      workspacePath: null,
      gitRoot: null,
      rawMeta: { sourceTurnState: "complete", sourceTurnId: "shared-bubble" }
    })).toBe(true);
    expect(store.count("cursor")).toBe(2);
    store.close();
    const again = openAppAgentSourceScanStore(path, job);
    expect(again.count("cursor")).toBe(2);
    expect([...again.messages("cursor")].map((row) => row.conversationId).sort()).toEqual(["c1", "c2"]);
    again.close();
  });

  it("recovers a leftover v3 table when it is the only staged table", () => {
    directory = mkdtempSync(join(tmpdir(), "memmy-scan-leftover-v3-"));
    const path = join(directory, "job.sqlite");
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE schema_meta (version INTEGER NOT NULL);
      INSERT INTO schema_meta(version) VALUES (2);
      CREATE TABLE staged_messages_v3 (
        job_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        workspace_path TEXT,
        git_root TEXT,
        raw_meta_json TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (job_id, source_id, conversation_id, message_id)
      );
      CREATE TABLE scan_cursors (
        source_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        message_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL
      );
      INSERT INTO staged_messages_v3 VALUES ('job','cursor','c1','u','user','retained source message','2099-01-01T10:00:00.000Z',null,null,'{}',7);
      INSERT INTO scan_cursors VALUES ('cursor','c1','2099-01-01T10:00:00.000Z','u',7);
    `);
    raw.close();
    const job = { jobId: "job", sourceId: "cursor", mode: "full", phase: "prepare", createdAt: "2099-01-01", updatedAt: "2099-01-01" };
    const store = openAppAgentSourceScanStore(path, job);
    expect(store.count("cursor")).toBe(1);
    expect([...store.messages("cursor")][0]).toMatchObject({ conversationId: "c1", content: "retained source message", ordinal: 7 });
    expect(store.getScanCursor("cursor")).toMatchObject({ conversationId: "c1", messageId: "u", ordinal: 7 });
    store.close();
    const again = openAppAgentSourceScanStore(path, job);
    expect(again.count("cursor")).toBe(1);
    expect(again.getScanCursor("cursor")?.ordinal).toBe(7);
    again.close();
  });
});
