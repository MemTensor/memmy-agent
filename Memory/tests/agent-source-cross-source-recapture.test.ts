import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG, type MemoryDb } from "../src/index.js";
import { createCodexSourceAdapter } from "../src/agent-source/adapters/codex/index.js";
import { createCursorSourceAdapter } from "../src/agent-source/adapters/cursor/index.js";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import { createSkillTargetRegistry } from "../src/agent-source/integration/target-registry.js";
import { createAgentSourceExecutor } from "../src/agent-source/runtime.js";
import { memoryCaptureQaHash } from "../src/utils/memory-capture-claim.js";
import {
  createBatchReflectionLlm,
  createMemoryServiceFixture,
  LEGACY_TEST_CONFIG
} from "./fixtures/memory-service-fixture.js";

// Regression coverage uses both adapters, the scan executor, capture persistence,
// and worker. Exact cross-source copies must reuse the original capture.
const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);
const query = "Please remember that I like sweets and prefer chocolate cake.";
const answer = "I will remember your preference for sweets and chocolate cake.";
const importedThreadId = "019e72be-500b-7f02-9400-112c5a194e5c";

function writeCursor(root: string, at: string) {
  const storageRoot = join(root, "cursor", "workspaceStorage");
  const globalStateDbPath = join(root, "cursor", "globalStorage", "state.vscdb");
  const transcript = join(root, "cursor", "agent-transcripts", "composer-bug819.txt");
  mkdirSync(storageRoot, { recursive: true });
  mkdirSync(join(root, "cursor", "globalStorage"), { recursive: true });
  mkdirSync(join(root, "cursor", "agent-transcripts"), { recursive: true });
  writeFileSync(transcript, `user:\n${query}\n\nassistant:\n${answer}\n`);
  const bubbles = [
    { bubbleId: "bug819-user", type: 1, text: query, createdAt: at, requestId: "bug819-generation" },
    { bubbleId: "bug819-assistant", type: 2, text: answer,
      createdAt: new Date(Date.parse(at) + 2000).toISOString() }
  ];
  const db = new Database(globalStateDbPath);
  try {
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, isSubagent INTEGER, subagentTypeName TEXT)");
    db.prepare("INSERT INTO composerHeaders VALUES (?, 0, '')").run("composer-bug819");
    const insert = db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)");
    insert.run("composerData:composer-bug819", JSON.stringify({
      composerId: "composer-bug819",
      fullConversationHeadersOnly: bubbles.map(({ bubbleId, type, createdAt }) => ({ bubbleId, type, createdAt }))
    }));
    for (const bubble of bubbles) insert.run(`bubbleId:composer-bug819:${bubble.bubbleId}`, JSON.stringify({ _v: 3, ...bubble }));
  } finally { db.close(); }
  return { storageRoot, globalStateDbPath, transcript };
}

function writeCodex(root: string, thread: string, at: string, texts = [{ query, answer }]) {
  const sessionsRoot = join(root, "codex", "sessions");
  mkdirSync(sessionsRoot, { recursive: true });
  const events: object[] = [{ timestamp: at, type: "session_meta", payload: {
    id: thread, source: "vscode", originator: "Codex Desktop", cwd: join(root, "project")
  } }];
  for (const [index, text] of texts.entries()) {
    const turnId = `bug819-codex-turn-${index}`;
    const timestamp = (offset: number) => new Date(Date.parse(at) + index * 10000 + offset).toISOString();
    events.push(
      { timestamp: timestamp(0), type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
      { timestamp: timestamp(1000), type: "response_item", payload: {
        type: "message", role: "user", content: [{ type: "input_text", text: text.query }]
      } },
      { timestamp: timestamp(2000), type: "response_item", payload: {
        type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: text.answer }]
      } },
      { timestamp: timestamp(3000), type: "event_msg", payload: { type: "task_complete", turn_id: turnId } }
    );
  }
  writeFileSync(join(sessionsRoot, `rollout-${thread}.jsonl`), events.map(row => JSON.stringify(row)).join("\n") + "\n");
  return sessionsRoot;
}

function writeImportLedger(root: string, transcript: string) {
  // Model the ledger link described by #691. v1.2.7 does not read this file.
  const path = join(root, "codex", "external_agent_session_imports.json");
  const record = {
    source_path: transcript,
    content_hash: createHash("sha256").update(readFileSync(transcript)).digest("hex"),
    imported_thread_id: importedThreadId
  };
  writeFileSync(path, JSON.stringify({ version: 1, imports: [record] }, null, 2));
  return path;
}

function snapshot(db: MemoryDb) {
  const count = (sql: string) => (db.db.prepare(sql).get() as { n: number }).n;
  const captures = db.db.prepare("SELECT source, conversation_id, turn_id, content_hash, completed_at FROM source_turn_captures ORDER BY source, turn_id").all();
  const turns = db.db.prepare("SELECT user_text, assistant_text FROM raw_turns ORDER BY id").all() as Array<{ user_text: string; assistant_text: string }>;
  const jobs = db.db.prepare("SELECT job_type, status, payload_json FROM evolution_jobs WHERE job_type = 'trace_summary' ORDER BY id").all() as Array<{ job_type: string; status: string; payload_json: string }>;
  return {
    l1: count("SELECT COUNT(*) AS n FROM memories WHERE memory_layer = 'L1'"),
    activeL1: count("SELECT COUNT(*) AS n FROM memories WHERE memory_layer = 'L1' AND deleted_at IS NULL AND status != 'deleted'"),
    claims: count("SELECT COUNT(*) AS n FROM memory_capture_claims"),
    captures,
    qaHashes: turns.map(turn => memoryCaptureQaHash(turn.user_text, turn.assistant_text)),
    summaryJobs: jobs.map(({ payload_json, ...job }) => ({ ...job, payload: JSON.parse(payload_json) }))
  };
}

async function scan(executor: ReturnType<typeof createAgentSourceExecutor>, sourceId: string, mode: "full" | "incremental" = "full") {
  await executor.startScan({ sourceId, mode });
  await expect.poll(() => executor.scanStatus().running, { timeout: 10000 }).toBe(false);
  expect(executor.scanStatus().error).toBeNull();
  expect(executor.scanStatus().results?.every(result => result.errors.length === 0)).toBe(true);
  return executor.scanStatus();
}

async function reproduce(name: string, options: { turnJudge?: boolean; incremental?: boolean; extraText?: boolean; split?: boolean } = {}) {
  const calls: Parameters<typeof createBatchReflectionLlm>[0] = [];
  const base = options.turnJudge ? DEFAULT_MEMMY_CONFIG : LEGACY_TEST_CONFIG;
  const config = { ...base, userId: "bug819-local-user", algorithm: {
    ...base.algorithm, l3FieldCognition: { ...base.algorithm.l3FieldCognition, enabled: false }
  } };
  const { root, service, db } = fixture.createTestService({ config, llm: createBatchReflectionLlm(calls) });
  // Deterministic activation boundary in this isolated database only.
  db.db.prepare("UPDATE runtime_kv SET value_json = ? WHERE key = 'source_turn_capture_activated_at'")
    .run(JSON.stringify("2026-10-01T00:00:00.000Z"));
  const cursor = writeCursor(root, options.incremental ? "2026-11-01T10:00:00.000Z" : "2020-01-01T10:00:00.000Z");
  const sessionsRoot = join(root, "codex", "sessions");
  mkdirSync(sessionsRoot, { recursive: true });
  const executor = createAgentSourceExecutor({
    service, configPath: join(root, "config.yaml"), statePath: join(root, "scan-state.json"),
    scanStoreDirectory: join(root, "scan-store"), resolveAgentSkillRoot: () => null,
    integrationRegistry: createSkillTargetRegistry([]),
    sourceRegistry: createSourceRegistry([
      createCursorSourceAdapter(cursor), createCodexSourceAdapter({ sessionsRoot })
    ])
  });
  try {
    await scan(executor, "cursor");
    const afterCursor = snapshot(db);
    expect(afterCursor.l1).toBe(1);
    expect(afterCursor.summaryJobs).toHaveLength(1);
    let beforeCopy = afterCursor;
    if (options.incremental) {
      writeCodex(root, "019e72be-500b-7f02-9400-112c5a194e5d", "2026-11-02T10:00:00.000Z", [
        { query: "Diagnose the missing SQLite index.", answer: "The lookup index was missing and is now restored." }
      ]);
      await scan(executor, "codex", "incremental");
      beforeCopy = snapshot(db);
      expect(beforeCopy.l1).toBe(2);
    }
    writeCodex(root, importedThreadId, options.incremental ? "2026-11-03T10:00:00.000Z" : "2020-02-01T10:00:00.000Z",
      options.split ? [{ query, answer: "I will remember your preference for sweets." },
        { query: "And chocolate cake.", answer: "Your chocolate cake preference is also noted." }]
        : [{ query: options.extraText ? `Imported Cursor conversation context.\n\n${query}` : query, answer }]);
    const ledgerPath = writeImportLedger(root, cursor.transcript);
    const codexScan = await scan(executor, "codex", options.incremental ? "incremental" : "full");
    const afterCodex = snapshot(db);
    const expectedNewMemories = options.split || options.extraText ? (options.split ? 2 : 1) : 0;
    expect(afterCodex.l1).toBe(beforeCopy.l1 + expectedNewMemories);
    expect(afterCodex.summaryJobs).toHaveLength(afterCodex.l1);
    expect(afterCodex.summaryJobs.every(job => job.payload.decideCapture === true)).toBe(true);
    expect(afterCodex.claims).toBe(0);
    if (!options.incremental && !options.extraText && !options.split) {
      expect(afterCodex.captures).toHaveLength(beforeCopy.captures.length);
      expect(new Set(afterCodex.captures.map((row: any) => row.content_hash)).size).toBe(1);
      expect(new Set(afterCodex.qaHashes).size).toBe(1);
    }
    if (options.extraText) expect(new Set(afterCodex.qaHashes).size).toBe(2);
    await scan(executor, "cursor");
    await scan(executor, "codex");
    const afterRescan = snapshot(db);
    expect(afterRescan.l1).toBe(afterCodex.l1);
    expect(afterRescan.summaryJobs).toHaveLength(afterCodex.summaryJobs.length);
    const workerRuns = [];
    for (let round = 0; round < 10 && calls.filter(call => call.options.operation === "capture.summarize").length < afterCodex.l1; round++) {
      workerRuns.push(await service.runWorkerOnce(100));
    }
    const captureDecisionCalls = calls.filter(call => call.options.operation === "capture.summarize");
    expect(captureDecisionCalls).toHaveLength(afterCodex.l1);
    const afterWorker = snapshot(db);
    expect(afterWorker.activeL1).toBe(afterCodex.l1);
    expect(afterWorker.summaryJobs.every(job => job.status === "succeeded")).toBe(true);
    const report = {
      name, options, baseCommit: "d064684ff663e804e220c2b90251924147541e1a", node: process.version,
      scope: "synthetic source files; real adapters, executor, SQLite, capture and worker; local LLM stub",
      afterCursor, beforeCopy, afterCodex, afterRescan, afterWorker,
      captureDecisionCalls: captureDecisionCalls.length,
      operations: calls.map(call => call.options.operation),
      codexScan, ledger: JSON.parse(readFileSync(ledgerPath, "utf8")), workerRuns
    };
    if (process.env.BUG819_REPRO_DIR) {
      const evidence = join(process.env.BUG819_REPRO_DIR, name);
      mkdirSync(evidence, { recursive: true });
      writeFileSync(join(evidence, "result.json"), JSON.stringify(report, null, 2));
      await db.db.backup(join(evidence, "memory.sqlite"));
      cpSync(join(root, "cursor"), join(evidence, "cursor"), { recursive: true });
      cpSync(join(root, "codex"), join(evidence, "codex"), { recursive: true });
      cpSync(join(root, "scan-state.json"), join(evidence, "scan-state.json"));
    }
    console.info(JSON.stringify({ case: name, afterCursor: afterCursor.l1, beforeCopy: beforeCopy.l1,
      afterCodex: afterCodex.l1, afterRescan: afterRescan.l1, activeAfterWorker: afterWorker.activeL1,
      captureDecisionCalls: captureDecisionCalls.length, summaryJobs: afterCodex.summaryJobs.length,
      claims: afterCodex.claims, turnJudge: config.algorithm.session.turnJudge }));
  } finally { await executor.dispose(); }
}

describe("bug819 / #691: avoid cross-source recapture", () => {
  it("reuses an identical exchange in a full legacy-history scan", async () => reproduce("full-legacy"));
  it("reuses an identical exchange with current turn-judge enabled", async () => reproduce("full-turn-judge", { turnJudge: true }));
  it("reuses an import timestamped later than an established Codex watermark", async () => reproduce("incremental", { incremental: true }));
  it("keeps a changed exchange eligible for capture", async () => reproduce("extra-context", { extraText: true }));
  it("keeps separate Codex turns eligible for capture", async () => reproduce("split-turns", { split: true }));
});
