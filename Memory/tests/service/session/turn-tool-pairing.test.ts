import { afterEach, describe, expect, it } from "vitest";
import type { ToolCallPayload } from "../../../src/types.js";
import { captureTurnSteps } from "../../../src/algorithm/plugin-algorithms.js";
import { normalizeCompleteTurnToolCalls, sanitizeTurnCompleteRequest } from "../../../src/service/turn/turn-normalization.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);

const calls = [
  { id: "call-a", name: "read_file", input: { path: "a.txt" } },
  { id: "call-b", name: "read_file", input: { path: "b.txt" } }
];

function normalize(toolCalls: unknown[], toolResults: unknown[]) {
  return normalizeCompleteTurnToolCalls({
    sessionId: "session-tools", query: "Read the files.", answer: "Read complete.", toolCalls, toolResults
  });
}

function capture(toolCalls: ToolCallPayload[], toolResults: unknown[]) {
  return captureTurnSteps({
    episodeId: "episode-tools", sessionId: "session-tools", turnId: "turn-tools",
    toolCalls, toolResults, createdAtIso: "2026-09-09T00:00:00.000Z"
  })[0]!.toolCalls;
}

describe("complete turn tool pairing", () => {
  it("pairs repeated tool names by invocation ID when results arrive out of order", () => {
    const result = normalize(calls, [
      { call_id: "call-b", output: "FILE_B", status: "failed", success: false, error: "read failed", errorCode: "ENOENT" },
      { toolCallId: "call-a", output: "FILE_A", status: "completed", success: true }
    ]);
    expect(result).toMatchObject([
      { id: "call-a", input: { path: "a.txt" }, output: "FILE_A", status: "completed", success: true },
      { id: "call-b", input: { path: "b.txt" }, output: "FILE_B", status: "failed", success: false, error: "read failed", errorCode: "ENOENT" }
    ]);
    expect(result[0]?.error).toBeUndefined();
  });

  it("keeps A missing when only B has a result, including the downstream capture pass", () => {
    const toolResults = [{ id: "call-b", output: "FILE_B", success: true }];
    const normalized = normalize(calls, toolResults);
    expect(normalized[0]?.output).toBeUndefined();
    expect(normalized[1]?.output).toBe("FILE_B");
    const captured = capture(normalized, toolResults);
    expect(captured[0]?.output).toBeUndefined();
    expect(captured[0]?.success).toBeUndefined();
    expect(captured[1]?.output).toBe("FILE_B");
  });

  it("does not carry results from a different turn into the current call set", () => {
    const result = normalize(calls, [{ id: "previous-turn-call", output: "OLD_RESULT" }]);
    expect(result.map((call) => call.output)).toEqual([undefined, undefined]);
  });

  it("preserves call-contained output without assigning a mismatched result", () => {
    const result = normalize([{ ...calls[0], output: "OWN_OUTPUT", success: true }], [
      { id: "call-b", output: "WRONG_OUTPUT", error: "unrelated failure" }
    ]);
    expect(result[0]).toMatchObject({ id: "call-a", output: "OWN_OUTPUT", success: true });
    expect(result[0]?.error).toBeUndefined();
  });

  it("accepts native call_id and tool_call_id without replacing them with record IDs", () => {
    expect(normalize([{ id: "record-a", call_id: "native-a", name: "exec" }], [
      { id: "result-record", tool_call_id: "native-a", output: "DONE" }
    ])[0]).toMatchObject({ id: "native-a", output: "DONE" });
  });

  it("retains aligned legacy results only when both complete arrays have no IDs", () => {
    expect(normalize([{ name: "read" }, { name: "write" }], ["FILE", "SAVED"])
      .map((call) => call.output)).toEqual(["FILE", "SAVED"]);
    expect(normalize([{ name: "read" }, { name: "write" }], ["SAVED"])
      .map((call) => call.output)).toEqual([undefined, undefined]);
    expect(normalize([{ name: "read" }, calls[1]], ["UNIDENTIFIED", { id: "call-b", output: "B" }])
      .map((call) => call.output)).toEqual([undefined, "B"]);
    expect(normalize([calls[0]], ["UNIDENTIFIED"])[0]?.output).toBeUndefined();
  });

  it("preserves explicit errors without guessing failure from an ordinary message", () => {
    const toolResults = [{ id: "call-a", error: "permission denied" }, { id: "call-b", output: "B", message: "read finished" }];
    const normalized = normalize(calls, toolResults);
    expect(normalized[0]).toMatchObject({ error: "permission denied", success: false });
    expect(normalized[1]?.error).toBeUndefined();
    const captured = capture(calls, toolResults);
    expect(captured[0]).toMatchObject({ error: "permission denied", success: false });
    expect(captured[1]).toMatchObject({ output: "B", success: true });
    expect(captured[1]?.error).toBeUndefined();
  });

  it("retains empty slots in legacy arrays without moving later results forward", () => {
    expect(normalize([{ name: "read" }, { name: "write" }], [undefined, "SAVED"])
      .map((call) => call.output)).toEqual([undefined, "SAVED"]);
  });

  it("does not guess between duplicate invocation IDs", () => {
    expect(normalize([calls[0]], [{ id: "call-a", output: "FIRST" }, { id: "call-a", output: "SECOND" }])[0]?.output)
      .toBeUndefined();
    expect(normalize([calls[0], calls[0]], [{ id: "call-a", output: "SHARED" }])
      .map((call) => call.output)).toEqual([undefined, undefined]);
  });

  it("does not assign a result after dropping a malformed call", () => {
    expect(normalize([{ id: "invalid" }, calls[1]], [
      { id: "invalid", output: "INVALID" }, { id: "call-b", output: "B" }
    ])).toMatchObject([{ id: "call-b", output: "B" }]);
    expect(normalize([], [])).toEqual([]);
  });

  it("uses result ID to select recall sanitization without hiding another tool's output", () => {
    const sanitized = sanitizeTurnCompleteRequest({
      sessionId: "session-tools", query: "Read the files.", answer: "Done.",
      toolCalls: [{ call_id: "memory", name: "memmy_memory_search" }, calls[1]],
      toolResults: [{ call_id: "call-b", output: "FILE_B" }, { call_id: "memory", output: "RECALLED_PRIVATE_CONTEXT" }]
    });
    expect(sanitized.toolResults?.[0]).toMatchObject({ call_id: "call-b", output: "FILE_B" });
    expect(sanitized.toolResults?.[1]).toMatchObject({ toolCallId: "memory", output: "[memmy memory result omitted from capture: memmy_memory_search]" });
    expect(normalizeCompleteTurnToolCalls(sanitized).map((call) => call.output)).toEqual([
      "[memmy memory result omitted from capture: memmy_memory_search]", "FILE_B"
    ]);
  });

  it("pairs direct algorithm inputs by ID and retains explicit result failures", () => {
    const captured = capture(calls, [
      { id: "call-b", output: "B", status: "failed", success: false, error: "permission denied", errorCode: "EACCES" },
      { id: "call-a", output: "A", status: "completed", success: true }
    ]);
    expect(captured).toMatchObject([
      { id: "call-a", output: "A", status: "completed", success: true },
      { id: "call-b", output: "B", status: "failed", success: false, error: "permission denied", errorCode: "EACCES" }
    ]);
  });

  it("persists paired input, output and status in L1 without treating successful text as an error", () => {
    const { db, service } = createTestService();
    const session = service.openSession({ namespace: { source: "codex", profileId: "default", userId: "tool-pairing" } });
    const completed = service.completeTurn("turn-preserve-tools", {
      sessionId: session.sessionId,
      query: "Read the source file and verify the test result.", answer: "The source file was read and the test result was checked.",
      toolCalls: calls,
      toolResults: [{ id: "call-b", output: "B", status: "failed", success: false, error: "read failed" }, { id: "call-a", output: "A", status: "completed", success: true }]
    });
    const row = db.db.prepare("SELECT properties_json FROM memories WHERE id = ?").get(completed.l1MemoryId) as { properties_json: string };
    const persisted = JSON.parse(row.properties_json).internal_info.trace.tool_calls;
    expect(persisted).toMatchObject([
      { id: "call-a", input: { path: "a.txt" }, output: "A", status: "completed", success: true },
      { id: "call-b", input: { path: "b.txt" }, output: "B", status: "failed", success: false, error: "read failed" }
    ]);
    expect(persisted[0].error).toBeUndefined();
  });
});
