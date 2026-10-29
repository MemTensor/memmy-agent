import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readClaudeCodeSession, readClaudeCodeSourceTurn } from "../claude-code-source-turn.js";
import { sourceTurnFailureReason, sourceTurnFromMessages, type RawSourceMessage } from "../source-turn.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const base = { sessionId: "session-726", timestamp: "2026-10-14T11:00:00.000Z" };
const user = (id = "prompt-1") => ({ ...base, type: "user", uuid: id, promptId: id,
  origin: { kind: "human" }, message: { content: "Fix the login button" } });
const assistant = (stop: string | null = "end_turn", id = "answer-1", tool = false) => ({ ...base,
  timestamp: "2026-10-14T11:00:01.000Z", type: "assistant", uuid: id,
  message: { stop_reason: stop, content: [{ type: "text", text: "The handler is fixed" },
    ...(tool ? [{ type: "tool_use", id: "call-1", name: "Read", input: { path: "login.ts" } }] : [])] } });
const result = (id = "call-1") => ({ ...base, type: "user", uuid: "result-1",
  message: { content: [{ type: "tool_result", tool_use_id: id, content: "file contents" }] } });
const duration = { ...base, type: "system", subtype: "turn_duration", uuid: "duration-1" };
function file(rows: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-726-parser-")); roots.push(root);
  const path = join(root, "session.jsonl");
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n"); return path;
}
async function read(rows: unknown[]) {
  const messages: RawSourceMessage[] = [];
  for await (const message of readClaudeCodeSession(file(rows))) messages.push(message);
  return { messages, turn: sourceTurnFromMessages(messages), reason: sourceTurnFailureReason(messages) };
}

describe("Claude completion evidence (MEMMY-726)", () => {
  it("captures an end_turn answer without a duration row", async () => {
    const { turn } = await read([user(), assistant()]);
    expect(turn).toMatchObject({ turnId: "prompt-1", query: "Fix the login button", answer: "The handler is fixed",
      completionEvidence: "end_turn:answer-1", completedAt: "2026-10-14T11:00:01.000Z" });
  });
  it.each(["tool_use", "max_tokens", "pause_turn", "stop_sequence", "refusal", null])("does not treat %s as end_turn", async stop => {
    const { turn, reason } = await read([user(), assistant(stop)]);
    expect(turn).toBeNull(); expect(reason).toBe("turn_incomplete");
  });
  it("keeps legacy duration evidence compatible", async () => {
    expect((await read([user(), assistant(null), duration])).turn?.completionEvidence).toBe("turn_duration:duration-1");
  });
  it("captures completed tool work when the final answer follows its result", async () => {
    const { turn } = await read([user(), assistant("tool_use", "tool-1", true), result(), assistant()]);
    expect(turn?.completionEvidence).toBe("end_turn:answer-1");
    expect(turn?.toolCalls).toEqual([expect.objectContaining({ id: "call-1", output: "file contents" })]);
  });
  it("does not lose completion when an already requested tool result is written later", async () => {
    const { turn } = await read([user(), assistant("end_turn", "answer-1", true), result()]);
    expect(turn?.completionEvidence).toBe("end_turn:answer-1");
  });
  it("still refuses unpaired tools even with end_turn or Hook Stop", async () => {
    const rows = [user(), assistant("end_turn", "answer-1", true)];
    expect((await read(rows)).turn).toBeNull();
    expect((await readClaudeCodeSourceTurn(file(rows), { conversationId: base.sessionId, promptId: "prompt-1", stop: true })).turn).toBeNull();
  });
  it.each(["end_turn", "duration"])("invalidates %s evidence when the assistant continues", async evidence => {
    const rows = evidence === "end_turn" ? [user(), assistant()] : [user(), assistant(null), duration];
    const { turn, reason } = await read([...rows, assistant(null, "continued")]);
    expect(turn).toBeNull(); expect(reason).toBe("turn_incomplete");
  });
  it("accepts a fresh completion after continuation", async () => {
    const { turn } = await read([user(), assistant(), assistant("tool_use", "tool-2", true), result(), assistant("end_turn", "final")]);
    expect(turn?.completionEvidence).toBe("end_turn:final");
  });
  it("invalidates completion for a non-human follow-up rather than reusing old evidence", async () => {
    const followup = { ...base, type: "user", uuid: "sdk-followup", message: { content: "Continue checking" } };
    expect((await read([user(), assistant(), followup])).turn).toBeNull();
  });
  it("does not preserve completion for an unrelated tool result", async () => {
    expect((await read([user(), assistant(), result("unknown-call")])).turn).toBeNull();
  });
  it("ignores bookkeeping and sidechain continuation without clearing main completion", async () => {
    const rows = [user(), assistant(), { ...base, type: "last-prompt" },
      { ...assistant(null, "sidechain"), isSidechain: true }];
    expect((await read(rows)).turn?.completionEvidence).toBe("end_turn:answer-1");
  });
  it("does not leak completion into the next human turn", async () => {
    const { messages } = await read([user(), assistant(), user("prompt-2"), assistant(null, "pending")]);
    expect(sourceTurnFromMessages(messages.filter(m => m.rawMeta.sourceTurnId === "prompt-1"))).not.toBeNull();
    expect(sourceTurnFromMessages(messages.filter(m => m.rawMeta.sourceTurnId === "prompt-2"))).toBeNull();
  });
  it("keeps scan and Hook identities equal and retains the matching Stop fallback", async () => {
    const rows = [user(), assistant()];
    const scan = (await read(rows)).turn;
    const hook = await readClaudeCodeSourceTurn(file(rows), { conversationId: base.sessionId, promptId: "prompt-1", stop: true });
    expect(hook.turn).toEqual(scan);
    const path = file([user(), assistant(null)]);
    expect((await readClaudeCodeSourceTurn(path, { conversationId: base.sessionId, promptId: "prompt-1", stop: true })).turn?.completionEvidence).toBe("stop:prompt-1");
    expect((await readClaudeCodeSourceTurn(path, { conversationId: "other", promptId: "prompt-1", stop: true })).turn).toBeNull();
  });
  it("does not accept end_turn without an identity or valid timestamps", async () => {
    expect((await read([user(), { ...assistant(), uuid: "" }])).turn).toBeNull();
    expect((await read([{ ...user(), timestamp: "bad" }, assistant()])).turn).toBeNull();
    expect((await read([user(), { ...assistant(), timestamp: "bad" }])).turn).toBeNull();
  });
});
