import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openMemoryAgentSourceScanStore } from "../src/agent-source/scan-store.js";

let directory: string | undefined;
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

it("replaces only the same DSH job/conversation/turn snapshot and survives rollback and reopen", async () => {
  directory = mkdtempSync(join(tmpdir(), "dsh-stage-scope-"));
  const path = join(directory, "scan.sqlite");
  const job = { jobId: "one", sourceId: "all", mode: "full", phase: "stage", createdAt: "2099-01-01", updatedAt: "2099-01-01" };
  const partial = { sourceId: "deepseek_harness", conversationId: "c1", messageId: "old", role: "assistant" as const,
    content: "An", createdAt: "2099-01-01T00:00:00Z", workspacePath: null, gitRoot: null,
    rawMeta: { sourceTurnId: "t1", sourceTurnState: "turn_incomplete" } };
  let store = await openMemoryAgentSourceScanStore(path, job);
  store.stageBatch([partial, { ...partial, sourceId: "codex" }, { ...partial, conversationId: "c2" },
    { ...partial, messageId: "other-turn", rawMeta: { ...partial.rawMeta, sourceTurnId: "t2" } }]);
  store.close();
  const other = await openMemoryAgentSourceScanStore(path, { ...job, jobId: "two" });
  other.stage(partial);
  other.close();
  store = await openMemoryAgentSourceScanStore(path, job);
  const complete = { ...partial, messageId: "final", content: "Answer", rawMeta: {
    sourceTurnId: "t1", sourceTurnState: "complete", dshSnapshotMessageIds: ["final"],
    sourceTurn: { source: "deepseek_harness", conversationId: "c1", turnId: "t1", completionEvidence: "turn_end:t1:completed",
      query: "Question", answer: "Answer", startedAt: partial.createdAt, completedAt: partial.createdAt,
      sequence: 1, status: "succeeded", toolCalls: [], toolResults: [] }
  } };
  expect(store.count()).toBe(4);
  const circular: Record<string, unknown> = {}; circular.self = circular;
  expect(() => store.stageBatch([complete, { ...partial, messageId: "invalid", rawMeta: circular }])).toThrow();
  expect(store.count()).toBe(4);
  expect([...store.messages("deepseek_harness")].some(row => row.messageId === "old" && row.conversationId === "c1")).toBe(true);
  store.stage(complete);
  expect(store.count()).toBe(4);
  expect([...store.messages("deepseek_harness")].map(row => [row.conversationId, row.messageId])).toEqual([
    ["c1", "final"], ["c1", "other-turn"], ["c2", "old"]
  ]);
  expect([...store.messages("codex")][0]?.rawMeta.sourceTurnState).toBe("turn_incomplete");
  store.close();
  store = await openMemoryAgentSourceScanStore(path, job);
  expect(store.count()).toBe(4);
  expect(store.stage(complete)).toBe(false);
  store.close();
  const foreign = await openMemoryAgentSourceScanStore(path, { ...job, jobId: "two" });
  expect(foreign.count()).toBe(1);
  expect([...foreign.messages("deepseek_harness")][0]?.messageId).toBe("old");
  foreign.close();
});
