import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/index.js";
import { Repositories } from "../../src/storage/repositories.js";

describe("api log source Agent filter", () => {
  it("filters exact and other memory_add and memory_search sources before pagination", () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-api-log-source-filter-"));
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    try {
      const repos = new Repositories(db.db);
      repos.runtime.insertApiLog(apiLog("memory_add", "test_agent", {
        details: [{ sourceAgent: "test_agent", summary: "stored by custom Agent" }]
      }, "2026-07-12T10:04:00.000Z"));
      repos.runtime.insertApiLog(apiLog("memory_add", "memmy-agent", {
        details: [{ summary: "queued" }, { sourceAgent: "memmy-agent", summary: "stored by Memmy" }]
      }, "2026-07-12T10:03:00.000Z"));
      repos.runtime.insertApiLog(apiLog("memory_add", "openclaw", {
        details: [{ sourceAgent: "openclaw", summary: "stored by OpenClaw" }]
      }, "2026-07-12T10:02:00.000Z"));
      repos.runtime.insertApiLog(apiLog("memory_add", undefined, {
        details: [{ summary: "stored directly through CLI" }]
      }, "2026-07-12T10:01:00.000Z"));
      repos.runtime.insertApiLog(apiLog("memory_search", "memmy-agent", {
        candidates: []
      }, "2026-07-12T10:00:00.000Z", { sessionId: "session_memmy" }));
      repos.runtime.insertApiLog(apiLog("memory_search", "test_agent", {
        candidates: []
      }, "2026-07-12T10:00:30.000Z", { sessionId: "session_test_agent" }));
      repos.runtime.insertApiLog(apiLog("memory_search", undefined, {
        candidates: []
      }, "2026-07-12T09:59:00.000Z"));

      const memmy = repos.runtime.listApiLogs({
        toolNames: ["memory_add", "memory_search"],
        sourceAgent: " memmy-agent ",
        limit: 20,
        offset: 0
      });
      expect(memmy.total).toBe(2);
      expect(memmy.logs.map((log) => log.toolName)).toEqual(["memory_add", "memory_search"]);
      expect(memmy.logs.map((log) => log.sourceAgent)).toEqual(["memmy-agent", "memmy-agent"]);
      expect(memmy.logs[0]?.outputJson).toContain("stored by Memmy");

      const other = repos.runtime.listApiLogs({
        toolNames: ["memory_add", "memory_search"],
        excludedSourceAgents: ["memmy-agent", "openclaw"],
        limit: 20,
        offset: 0
      });
      expect(other.total).toBe(4);
      expect(other.logs.map((log) => log.toolName)).toEqual(["memory_add", "memory_add", "memory_search", "memory_search"]);
      expect(other.logs.map((log) => log.sourceAgent)).toEqual(["test_agent", undefined, "test_agent", undefined]);
      expect(other.logs[0]?.outputJson).toContain("stored by custom Agent");

      expect(repos.runtime.listApiLogs({
        toolNames: ["memory_search"],
        sourceAgent: "memmy-agent"
      })).toMatchObject({ logs: [{ toolName: "memory_search" }], total: 1 });
      expect(repos.runtime.listApiLogs({
        toolNames: ["memory_search"],
        excludedSourceAgents: ["memmy-agent", "openclaw"]
      })).toMatchObject({ logs: [{ sourceAgent: "test_agent" }, { toolName: "memory_search" }], total: 2 });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function apiLog(
  toolName: "memory_add" | "memory_search",
  sourceAgent: string | undefined,
  output: unknown,
  calledAt: string,
  input: unknown = {}
) {
  return {
    toolName,
    sourceAgent,
    inputJson: JSON.stringify(input),
    outputJson: JSON.stringify(output),
    durationMs: 1,
    success: true,
    calledAt
  };
}
