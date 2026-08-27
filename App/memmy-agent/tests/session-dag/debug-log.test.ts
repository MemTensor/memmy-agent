import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDagDebugLogger, type SessionDagBuildAuditRecord } from "../../src/session-dag/debug-log.js";
import { sessionDagDebugLogPath } from "../../src/session-dag/paths.js";

const roots: string[] = [];
let oldDagDir: string | undefined;

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-session-dag-debug-"));
  roots.push(root);
  return root;
}

function makeRecord(overrides: Partial<SessionDagBuildAuditRecord> = {}): SessionDagBuildAuditRecord {
  return {
    version: 1,
    sessionKey: "websocket:debug/session",
    turnId: "turn-1",
    attempt: 1,
    messageRange: { start: 0, end: 2 },
    provider: "openai",
    model: "test-model",
    startedAt: "2026-07-08T10:00:00.000Z",
    finishedAt: "2026-07-08T10:00:01.000Z",
    request: {
      systemPrompt: "prompt",
      userPayload: { turn_messages: { messages: [{ role: "user", content: "hello" }] }, dag_context: {} },
    },
    response: { content: "{\"ops\":[]}", usage: { prompt_tokens: 1, completion_tokens: 1 } },
    parse: { ok: true, opsCount: 0, parsedPatch: { ops: [] } },
    validation: { ok: true },
    apply: { ok: true, nodeIds: {}, edgeIds: [] },
    error: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (oldDagDir === undefined) delete process.env.MEMMY_AGENT_SESSION_DAG_DIR;
  else process.env.MEMMY_AGENT_SESSION_DAG_DIR = oldDagDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("SessionDagDebugLogger", () => {
  it("does not create a log file when disabled", async () => {
    const root = tmpRoot();
    oldDagDir = process.env.MEMMY_AGENT_SESSION_DAG_DIR;
    process.env.MEMMY_AGENT_SESSION_DAG_DIR = root;
    const logger = new SessionDagDebugLogger(false);

    await logger.writeAttempt(makeRecord());

    expect(fs.existsSync(sessionDagDebugLogPath("websocket:debug/session"))).toBe(false);
  });

  it("appends complete attempt records to one session JSONL file", async () => {
    const root = tmpRoot();
    oldDagDir = process.env.MEMMY_AGENT_SESSION_DAG_DIR;
    process.env.MEMMY_AGENT_SESSION_DAG_DIR = root;
    const logger = new SessionDagDebugLogger(true);

    await logger.writeAttempt(makeRecord());
    await logger.writeAttempt(makeRecord({ turnId: "turn-2", attempt: 2 }));

    const filePath = sessionDagDebugLogPath("websocket:debug/session");
    expect(filePath).toBe(path.join(root, "debug", "websocket_debug_session.jsonl"));
    const lines = fs.readFileSync(filePath, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => JSON.parse(line))).toBe(true);
    expect(lines[0]).not.toContain("\n");
    const first = JSON.parse(lines[0]!);
    const second = JSON.parse(lines[1]!);
    expect(first).toMatchObject({
      sessionKey: "websocket:debug/session",
      turnId: "turn-1",
      request: { systemPrompt: "prompt" },
      response: { content: "{\"ops\":[]}" },
      parse: { parsedPatch: { ops: [] } },
      validation: { ok: true },
      apply: { ok: true, nodeIds: {}, edgeIds: [] },
    });
    expect(second).toMatchObject({ turnId: "turn-2", attempt: 2 });
  });

  it("surfaces filesystem errors to the builder caller", async () => {
    const root = tmpRoot();
    oldDagDir = process.env.MEMMY_AGENT_SESSION_DAG_DIR;
    process.env.MEMMY_AGENT_SESSION_DAG_DIR = root;
    const logger = new SessionDagDebugLogger(true);
    vi.spyOn(fsPromises, "appendFile").mockRejectedValueOnce(new Error("disk full"));

    await expect(logger.writeAttempt(makeRecord())).rejects.toThrow(/disk full/);
  });
});
