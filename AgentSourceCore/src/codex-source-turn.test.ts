import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCodexRollout, readCodexSourceTurn, sourceTurnFailureReason, sourceTurnFromMessages, buildSourceTurnRequest, orderedTurns, type ConversationMessage } from "./index.js";

const dirs: string[] = [];
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
const time = "2026-09-09T10:00:00.000Z";
const event = (type: string, payload: Record<string, unknown>) => ({ type, timestamp: time, payload });
const message = (role: string, text: string) => event("response_item", { type: "message", role, content: [{ text }] });
function fixture(records: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "source-turn-")); dirs.push(dir);
  const path = join(dir, "rollout-file.jsonl"); writeFileSync(path, records.map(r => JSON.stringify(r)).join("\n") + "\n"); return path;
}
async function collect<T>(values: AsyncIterable<T>): Promise<T[]> { const all: T[] = []; for await (const value of values) all.push(value); return all; }
async function read(records: unknown[]) { return collect(readCodexRollout(fixture(records))); }
const prefix = [event("session_meta", { id: "file-artifact", session_id: "conversation", cwd: "/project" }), event("event_msg", { type: "task_started", turn_id: "turn-1" }), message("user", "Fix the issue")];
const end = [message("assistant", "Done"), event("event_msg", { type: "task_complete", turn_id: "turn-1" })];

describe("Codex native source turns", () => {
  it("retains steering in one native turn and pairs missing/reversed results only by call id", async () => {
    const messages = await read([...prefix,
      event("response_item", { type: "function_call", call_id: "a", name: "read", arguments: { path: "a" } }),
      message("user", "Also run tests"),
      event("response_item", { type: "custom_tool_call", call_id: "b", name: "test", input: "npm test" }),
      event("response_item", { type: "custom_tool_call_output", call_id: "b", output: "FAILED", status: "failed" }),
      event("response_item", { type: "web_search_call", id: "web", action: { query: "fix" }, status: "completed" }), ...end]);
    const turn = sourceTurnFromMessages(messages);
    expect(turn).toMatchObject({ conversationId: "conversation", turnId: "turn-1", query: "Fix the issue\n\nAlso run tests", answer: "Done", completionEvidence: "task_complete:turn-1" });
    expect(turn?.toolCalls).toEqual([
      expect.objectContaining({ id: "a", name: "read", input: { path: "a" } }),
      expect.objectContaining({ id: "b", name: "test", input: "npm test", output: "FAILED", status: "failed", success: false }),
      expect.objectContaining({ id: "web", name: "web_search", input: { query: "fix" }, status: "completed" })
    ]);
    expect(turn?.toolCalls[0]).not.toHaveProperty("output");
    const staged = messages.map(m => ({ ...m, sourceId: "codex", workspacePath: null, gitRoot: null })) as ConversationMessage[];
    expect(await collect(orderedTurns((async function* () { yield* staged; })()))).toHaveLength(1);
    expect(buildSourceTurnRequest(turn!, "hook").sourceTurn).toEqual(buildSourceTurnRequest(turn!, "agent_source_scan").sourceTurn);
  });

  it("does not create a canonical turn without native identity, completion, or matching completion", async () => {
    for (const records of [[message("user", "Q"), message("assistant", "A")], [...prefix, message("assistant", "still running")], [...prefix, ...end.slice(0, 1), event("event_msg", { type: "task_complete", turn_id: "other" })]]) {
      const messages = await read(records);
      expect(sourceTurnFromMessages(messages)).toBeNull();
      expect(messages.at(-1)?.rawMeta.sourceTurnState).not.toBe("complete");
    }
  });

  it("never matches a result to another turn and keeps unresolved turns for scan retry", async () => {
    const messages = await read([...prefix, event("response_item", { type: "function_call", call_id: "same", name: "old", arguments: "x" }), ...end,
      event("event_msg", { type: "task_started", turn_id: "turn-2" }), message("user", "Second"), event("response_item", { type: "function_call_output", call_id: "same", output: "not for old" })]);
    const first = sourceTurnFromMessages(messages.filter(m => m.rawMeta.sourceTurnId === "turn-1"));
    expect(first?.toolCalls[0]).not.toHaveProperty("output");
    const staged = messages.map(m => ({ ...m, sourceId: "codex", workspacePath: null, gitRoot: null })) as ConversationMessage[];
    const turns = await collect(orderedTurns((async function* () { yield* staged; })()));
    expect(turns).toHaveLength(2); expect(sourceTurnFromMessages(turns[1]!.messages)).toBeNull();
  });

  it("applies the existing redactor equally to canonical text and structured tool values", async () => {
    const token = `sk-${"fixture".repeat(8)}`;
    const messages = await read([...prefix, event("response_item", { type: "custom_tool_call", call_id: "a", name: "write", input: { token } }), event("response_item", { type: "custom_tool_call_output", call_id: "a", output: { token } }), ...end]);
    const turn = sourceTurnFromMessages(messages)!;
    expect(JSON.stringify(turn)).not.toContain(token);
    expect(turn.toolCalls[0]?.input).toEqual({ token: "[REDACTED:openai_api_key]" });
  });
  it("keeps the native completion timestamp visible to incremental scanning", async () => {
    const completedAt = "2026-09-09T10:05:00.000Z";
    const messages = await read([...prefix, message("assistant", "Done"), { ...event("event_msg", { type: "task_complete", turn_id: "turn-1" }), timestamp: completedAt }]);
    expect(messages.at(-1)).toMatchObject({ role: "system", createdAt: completedAt, rawMeta: { sourceTurnState: "complete" } });
    expect(sourceTurnFromMessages(messages)?.completedAt).toBe(completedAt);
  });

  it("accepts duplicate evidence for the same canonical turn but does not merge conflicting content", async () => {
    const messages = await read([...prefix, ...end]);
    const turn = sourceTurnFromMessages(messages)!;
    expect(sourceTurnFromMessages([...messages, ...messages])).toEqual(turn);
    expect(sourceTurnFromMessages([...messages, { rawMeta: { sourceTurn: { ...turn, answer: "different" } } }])).toBeNull();
  });

  it("retains numeric record order even when many events have the same timestamp", async () => {
    const messages = await read([...prefix, ...Array.from({ length: 15 }, (_, i) => message("assistant", `progress ${i}`)), ...end]);
    expect([...messages].sort((a, b) => a.messageId.localeCompare(b.messageId))).toEqual(messages);
  });

  it("resolves an initial user message followed by turn_context without inventing an ID", async () => {
    const messages = await read([prefix[0], message("user", "Question"), event("turn_context", { turn_id: "turn-1" }), ...end]);
    expect(sourceTurnFromMessages(messages)).toMatchObject({ turnId: "turn-1", query: "Question" });
  });

  it("keeps a turn pending when a malformed record might hide a tool call or result", async () => {
    const path = fixture([...prefix, ...end]);
    const records = [...prefix, ...end].map(record => JSON.stringify(record));
    records.splice(3, 0, '{"type":"response_item","payload":');
    writeFileSync(path, records.join("\n") + "\n");
    const messages = await collect(readCodexRollout(path));
    expect(sourceTurnFromMessages(messages)).toBeNull();
    expect(messages.at(-1)?.rawMeta.sourceTurnReason).toBe("source_record_invalid");
  });

  it("does not assign one result to two calls with the same native call id", async () => {
    const messages = await read([...prefix,
      event("response_item", { type: "function_call", call_id: "a", name: "read", arguments: "first" }),
      event("response_item", { type: "function_call", call_id: "a", name: "write", arguments: "second" }),
      event("response_item", { type: "function_call_output", call_id: "a", output: "ambiguous" }), ...end]);
    expect(sourceTurnFromMessages(messages)?.toolCalls.every(call => call.output === undefined)).toBe(true);
  });

  it("keeps conflicting or incomplete repeated native turns pending in both channels", async () => {
    const completed = [...prefix, ...end];
    for (const tail of [[...prefix, message("assistant", "changed"), end[1]], [...prefix, message("assistant", "still working")]]) {
      const path = fixture([...completed, ...tail]);
      expect(sourceTurnFromMessages(await collect(readCodexRollout(path)))).toBeNull();
      expect((await readCodexSourceTurn(path, { turnId: "turn-1", conversationId: "conversation", stop: true })).turn).toBeNull();
    }
  });

  it("does not emit startup or trailing system-only context as a pending memory turn", async () => {
    const messages = await read([prefix[0], message("developer", "startup instructions"), ...prefix.slice(1), ...end, message("developer", "context for next turn")]);
    expect(sourceTurnFromMessages(messages)).not.toBeNull();
    expect(messages.every(message => message.rawMeta.sourceTurnState === "complete")).toBe(true);
    expect(await read([prefix[0], message("system", "startup only")])).toEqual([]);
  });

  it("reports pending evidence before content conflicts and distinguishes conflicts from missing identity", async () => {
    const messages = await read([...prefix, ...end]);
    const turn = sourceTurnFromMessages(messages)!;
    const conflicting = [...messages, { rawMeta: { sourceTurn: { ...turn, answer: "different content" } } }];
    expect(sourceTurnFailureReason(conflicting)).toBe("source_turn_content_conflict");
    expect(sourceTurnFailureReason([...conflicting, { rawMeta: { sourceTurnState: "turn_incomplete", sourceTurnReason: "source_record_invalid" } }])).toBe("source_record_invalid");
    expect(sourceTurnFailureReason([{ rawMeta: {} }])).toBe("identity_unresolved");
  });

});
