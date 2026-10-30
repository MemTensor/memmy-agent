import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryAgentSourceScanStore } from "../src/agent-source/scan-store.js";

const roots: string[] = [];
const close: Array<() => void> = [];
afterEach(() => {
  for (const fn of close.splice(0)) fn();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function openStore() {
  const root = mkdtempSync(join(tmpdir(), "skill-scan-errors-")); roots.push(root);
  const store = await openMemoryAgentSourceScanStore(join(root, "job.sqlite"), {
    jobId: "job", sourceId: "claude_code", mode: "full", phase: "ingest",
    createdAt: "2026-10-29", updatedAt: "2026-10-29"
  });
  close.push(() => store.close());
  return store;
}

describe("skill import errors in the scan store", () => {
  it("counts conversation errors on their own, however often a skill error is reported", async () => {
    const store = await openStore();
    store.saveResult({ sourceId: "claude_code", conversationId: "conversation-1", error: "read failed" });
    // A plugin shared by several scopes reports the same path more than once; the store keeps one row.
    store.saveResult({ sourceId: "claude_code", conversationId: "skill:/plugins/shared/SKILL.md", error: "unreadable" });
    store.saveResult({ sourceId: "claude_code", conversationId: "skill:/plugins/shared/SKILL.md", error: "unreadable" });
    store.saveResult({ sourceId: "claude_code", conversationId: "skills", error: "reconcile failed" });

    expect(store.conversationErrorCount("claude_code")).toBe(1);
  });

  it("clears earlier skill errors and keeps conversation errors", async () => {
    const store = await openStore();
    store.saveResult({ sourceId: "claude_code", conversationId: "conversation-1", error: "read failed" });
    store.saveResult({ sourceId: "claude_code", conversationId: "skill:/skills/a/SKILL.md", error: "permission denied" });
    store.saveResult({ sourceId: "claude_code", conversationId: "skills", error: "reconcile failed" });

    store.resolveSkillErrors("claude_code");

    expect(store.resultSummary("claude_code").errors).toBe(1);
    expect(store.errorDetails("claude_code")).toEqual([{ conversationId: "conversation-1", reason: "read failed" }]);
  });
});
