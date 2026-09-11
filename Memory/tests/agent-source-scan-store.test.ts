import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
