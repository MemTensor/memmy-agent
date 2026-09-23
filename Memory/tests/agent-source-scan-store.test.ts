import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryAgentSourceScanStore } from "../src/agent-source/scan-store.js";

let directory: string | undefined;
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; });

describe("standalone durable scan store retry", () => {
  it("refreshes unresolved Codex rows in the same job without counting them as new messages", async () => {
    directory = mkdtempSync(join(tmpdir(), "memmy-codex-scan-retry-"));
    const path = join(directory, "job.sqlite");
    const job = { jobId: "job", sourceId: "codex", mode: "incremental", phase: "failed", createdAt: "2026-09-09", updatedAt: "2026-09-09" };
    let store = await openMemoryAgentSourceScanStore(path, job);
    const pending = { messageId: "rollout:000000000009", sourceId: "codex", conversationId: "fallback-conversation", role: "assistant" as const, content: "Draft", createdAt: "2026-09-09T00:00:00Z", workspacePath: null, gitRoot: null, rawMeta: { sourceTurnState: "identity_unresolved", sourceTurnReason: "identity_unresolved" } };
    expect(store.stage(pending)).toBe(true);
    const stagedOrdinal = [...store.messages("codex")][0]!.ordinal;
    store.saveResult({ sourceId: "codex", conversationId: pending.conversationId, error: "identity_unresolved" });
    store.close();
    store = await openMemoryAgentSourceScanStore(path, job);
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
    store = await openMemoryAgentSourceScanStore(path, job);
    expect([...store.messages("codex")][0]).toMatchObject(completed);
    store.close();
  });

  it("keeps existing non-Codex staged rows and unrelated rows unchanged", async () => {
    directory = mkdtempSync(join(tmpdir(), "memmy-scan-legacy-dedup-"));
    const store = await openMemoryAgentSourceScanStore(join(directory, "job.sqlite"), { jobId: "job", sourceId: "all", mode: "full", phase: "stage", createdAt: "2026-09-09", updatedAt: "2026-09-09" });
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

  it("keeps shared Cursor bubble ids in separate conversations", async () => {
    directory = mkdtempSync(join(tmpdir(), "memmy-scan-shared-bubble-"));
    const store = await openMemoryAgentSourceScanStore(join(directory, "job.sqlite"), { jobId: "job", sourceId: "cursor", mode: "full", phase: "stage", createdAt: "2026-09-09", updatedAt: "2026-09-09" });
    const base = { sourceId: "cursor", messageId: "shared-bubble", role: "user" as const, content: "same forked user message", createdAt: "2026-09-09T00:00:00Z", workspacePath: null, gitRoot: null, rawMeta: { sourceTurnState: "complete", sourceTurnId: "shared-bubble" } };
    expect(store.stage({ ...base, conversationId: "c1" })).toBe(true);
    expect(store.stage({ ...base, conversationId: "c2" })).toBe(true);
    expect(store.stage({ ...base, conversationId: "c1", content: "refreshed", rawMeta: { sourceTurnState: "complete", sourceTurnId: "shared-bubble", sourceTurn: { turnId: "shared-bubble" } } })).toBe(false);
    expect(store.count("cursor")).toBe(2);
    const conversations = new Set([...store.messages("cursor")].map((row) => row.conversationId));
    expect([...conversations].sort()).toEqual(["c1", "c2"]);
    store.close();
  });

  it("upgrades a pre-job_id store and recovers a leftover v3 table", async () => {
    directory = mkdtempSync(join(tmpdir(), "memmy-scan-schema1-"));
    const path = join(directory, "job.sqlite");
    const raw = new Database(path);
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
    const store = await openMemoryAgentSourceScanStore(path, job);
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
    const again = await openMemoryAgentSourceScanStore(path, job);
    expect(again.count("cursor")).toBe(2);
    again.close();
  });

  it("recovers a leftover v3 table when it is the only staged table", async () => {
    directory = mkdtempSync(join(tmpdir(), "memmy-scan-leftover-v3-"));
    const path = join(directory, "job.sqlite");
    const raw = new Database(path);
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
    const store = await openMemoryAgentSourceScanStore(path, job);
    expect(store.count("cursor")).toBe(1);
    expect([...store.messages("cursor")][0]).toMatchObject({ conversationId: "c1", content: "retained source message", ordinal: 7 });
    expect(store.getScanCursor("cursor")).toMatchObject({ conversationId: "c1", messageId: "u", ordinal: 7 });
    store.close();
    const again = await openMemoryAgentSourceScanStore(path, job);
    expect(again.count("cursor")).toBe(1);
    expect(again.getScanCursor("cursor")?.ordinal).toBe(7);
    again.close();
  });
});
