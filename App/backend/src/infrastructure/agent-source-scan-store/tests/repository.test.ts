import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAppAgentSourceScanStore } from "../index.js";

let directory: string | undefined;
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; });

describe("durable scan store", () => {
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
