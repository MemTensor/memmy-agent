import { afterEach, describe, expect, it } from "vitest";
import type { MemoryService } from "../../../src/index.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();

afterEach(cleanup);

const namespace = {
  source: "codex",
  profileId: "jiang",
  userId: "qa-dedup-user"
};

describe("MemoryService / import / QA capture dedup", () => {
  it("keeps the hook capture when an agent-source scan later sees the same QA", () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      adapterId: "memmy-codex-hook",
      requestId: "hook-first-open",
      namespace
    });
    const query = "检查项目配置并说明使用哪个包管理器。";
    const answer = "项目使用 pnpm workspace。";
    const completed = service.completeTurn("hook-first-turn", {
      adapterId: "memmy-codex-hook",
      requestId: "hook-first-complete",
      sessionId: session.sessionId,
      query,
      answer,
      toolCalls: [{ id: "read-1", name: "read_file", input: { path: "package.json" } }],
      toolResults: [{ id: "read-1", name: "read_file", output: "packageManager: pnpm" }]
    });
    const beforeCount = l1Count(db.db);

    const scanned = addScannedTurn(service, {
      requestId: "scan-after-hook",
      turnId: "codex:scan-after-hook",
      query,
      answer,
      intermediateAssistant: "我先读取 package.json。"
    });

    expect(scanned.duplicate).toBe(true);
    expect(scanned.id).toBe(completed.l1MemoryId);
    expect(l1Count(db.db)).toBe(beforeCount);
    expect(db.db.prepare(
      `SELECT captured_by FROM memory_capture_claims
       WHERE user_id = ? AND source = 'codex'`
    ).get(namespace.userId)).toEqual({ captured_by: "turn_complete" });
  });

  it("keeps the scan capture and still records the hook raw turn and episode link", () => {
    const { db, service } = createTestService();
    const query = "汇总当前仓库的测试命令。";
    const answer = "运行 npm test 即可执行完整测试。";
    const scanned = addScannedTurn(service, {
      requestId: "scan-first",
      turnId: "codex:scan-first",
      query,
      answer,
      intermediateAssistant: "我先检查 package.json scripts。"
    });
    const session = service.openSession({
      adapterId: "memmy-codex-hook",
      requestId: "scan-first-open",
      namespace
    });

    const completed = service.completeTurn("scan-first-hook-turn", {
      adapterId: "memmy-codex-hook",
      requestId: "scan-first-hook-complete",
      sessionId: session.sessionId,
      query,
      answer,
      toolCalls: [{ id: "read-2", name: "read_file", input: { path: "package.json" } }],
      toolResults: [{ id: "read-2", name: "read_file", output: "test: vitest run" }]
    });

    expect(l1Count(db.db)).toBe(1);
    expect(completed.l1MemoryIds).toEqual([scanned.id]);
    expect(completed.jobs.map((job) => job.jobType)).not.toContain("trace_summary");
    expect(db.db.prepare(
      `SELECT COUNT(*) AS count FROM raw_turns WHERE id = ?`
    ).get(completed.rawTurnId)).toEqual({ count: 1 });
    const episode = db.db.prepare(
      `SELECT l1_memory_ids_json, raw_turn_ids_json FROM episodes WHERE id = ?`
    ).get(completed.episodeId) as { l1_memory_ids_json: string; raw_turn_ids_json: string };
    expect(JSON.parse(episode.l1_memory_ids_json)).toContain(scanned.id);
    expect(JSON.parse(episode.raw_turn_ids_json)).toContain(completed.rawTurnId);
    expect(db.db.prepare(
      `SELECT captured_by FROM memory_capture_claims
       WHERE user_id = ? AND source = 'codex'`
    ).get(namespace.userId)).toEqual({ captured_by: "agent_source_scan" });
  });

  it("stores a second memory when the final assistant answer differs", () => {
    const { db, service } = createTestService();
    const query = "项目使用哪个包管理器？";
    const first = addScannedTurn(service, {
      requestId: "different-answer-1",
      turnId: "codex:different-answer-1",
      query,
      answer: "项目使用 pnpm。"
    });
    const second = addScannedTurn(service, {
      requestId: "different-answer-2",
      turnId: "codex:different-answer-2",
      query,
      answer: "项目使用 npm。"
    });

    expect(first.duplicate).toBeUndefined();
    expect(second.duplicate).toBeUndefined();
    expect(second.id).not.toBe(first.id);
    expect(l1Count(db.db)).toBe(2);
  });

  it("keeps revised scanner turns on the existing memory id without leaving dangling claims", () => {
    const { db, service } = createTestService();
    const first = addScannedTurn(service, {
      requestId: "revised-turn-1",
      turnId: "codex:stable-revised-turn",
      query: "测试命令是什么？",
      answer: "运行 npm test。"
    });
    const revised = addScannedTurn(service, {
      requestId: "revised-turn-2",
      turnId: "codex:stable-revised-turn",
      query: "测试命令是什么？",
      answer: "运行 npm run test。"
    });
    const replay = addScannedTurn(service, {
      requestId: "revised-turn-3",
      turnId: "codex:stable-revised-turn",
      query: "测试命令是什么？",
      answer: "运行 npm run test。"
    });

    expect(revised.id).toBe(first.id);
    expect(revised.duplicate).toBeUndefined();
    expect(replay.id).toBe(first.id);
    expect(replay.duplicate).toBeUndefined();
    expect(l1Count(db.db)).toBe(1);
    expect(db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM memory_capture_claims
       WHERE primary_memory_id = ?`
    ).get(first.id)).toEqual({ count: 2 });
  });
});

function addScannedTurn(
  service: MemoryService,
  input: {
    requestId: string;
    turnId: string;
    query: string;
    answer: string;
    intermediateAssistant?: string;
  }
): ReturnType<MemoryService["addMemory"]> {
  return service.addMemory({
    namespace,
    adapterId: "agent-source:codex",
    requestId: input.requestId,
    layer: "L1",
    source: "codex",
    tags: ["agent-source", "codex"],
    turnId: input.turnId,
    content: [
      `## user\n\n${input.query}`,
      ...(input.intermediateAssistant ? [`## assistant\n\n${input.intermediateAssistant}`] : []),
      "## tool\n\nTool: read_file\n\nOutput:\n工具调用的数量和内容不参与 QA 判重。",
      `## assistant\n\n${input.answer}`
    ].join("\n\n")
  });
}

function l1Count(db: { prepare(sql: string): { get(): unknown } }): number {
  return (db.prepare(
    `SELECT COUNT(*) AS count FROM memories
     WHERE memory_layer = 'L1' AND deleted_at IS NULL`
  ).get() as { count: number }).count;
}
