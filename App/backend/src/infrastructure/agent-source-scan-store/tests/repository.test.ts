import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const completed = { ...pending, conversationId: "native-conversation", content: "Final answer", workspacePath: "/tmp/project", rawMeta: { sourceTurnState: "complete", sourceTurnId: "turn-native", sourceTurn: { turnId: "turn-native", completionEvidence: "task_complete:turn-native" } } };
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
});
