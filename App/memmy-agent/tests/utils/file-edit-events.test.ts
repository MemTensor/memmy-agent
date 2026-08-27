import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  StreamingFileEditState,
  StreamingJsonStringField,
  StreamingFileEditTracker,
  buildFileEditEndEvent,
  buildFileEditStartEvent,
  extractCompleteJsonString,
  lineDiffStats,
  prepareFileEditTracker,
  prepareFileEditTrackers,
  readFileSnapshot,
} from "../../src/utils/file-edit-events.js";
import { getOrCreateUiToolCallId } from "../../src/utils/progress-events.js";
import { ApplyPatchTool } from "../../src/core/agent-runtime/tools/apply-patch.js";

const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-file-edit-events-"));
  roots.push(root);
  return root;
}

function slash(filePath: string): string {
  return path.resolve(filePath).split(path.sep).join("/");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("file edit event helpers", () => {
  it("scans streaming JSON string fields incrementally", () => {
    const field = new StreamingJsonStringField("content");

    field.scan('{"content":"one\\n');
    expect(field.lineCount).toBe(1);
    field.scan('{"content":"one\\ntwo\\u000a');
    expect(field.lineCount).toBe(2);
    field.scan('{"content":"one\\ntwo\\u000athree"}');
    expect(field.closed).toBe(true);
    expect(field.lineCount).toBe(3);
    field.reset();
    expect(field.lineCount).toBe(0);
    expect(field.closed).toBe(false);
    expect(extractCompleteJsonString('{"path":"done.md"}', "path")).toBe("done.md");
    expect(extractCompleteJsonString('{"path":"partial', "path")).toBeNull();
  });

  it("tracks streaming file edit state counts and final-call matching", () => {
    const state = new StreamingFileEditState("idx:7");
    state.applyDelta({ call_id: "call-live", name: "edit_file", arguments_delta: '{"path":"notes.md","old_text":"old\\n","new_text":"new\\nextra' });

    expect(state.liveDiffCounts()).toEqual([2, 1]);
    expect(state.shouldEmitPending(2, 1, 1000)).toBe(true);
    state.markPendingEmitted(2, 1, 1000);
    expect(state.shouldEmitPending(2, 1, 1001)).toBe(false);
    expect(state.matchesFinalToolCall({ id: "call-live", name: "edit_file", arguments: { path: "notes.md" } })).toBe(true);
  });

  it("counts replacements, insertions, and deletions", () => {
    expect(lineDiffStats("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual([2, 1]);
  });

  it("normalizes CRLF while counting line diffs", () => {
    expect(lineDiffStats("a\r\nb\r\n", "a\nb\nc\n")).toEqual([1, 0]);
  });

  it("counts new CRLF file lines once", () => {
    expect(lineDiffStats("", "a\r\nb\r\n")).toEqual([2, 0]);
  });

  it("predicts write_file start events and calibrates exact end diffs", () => {
    const root = tmpRoot();
    const target = path.join(root, "notes.txt");
    fs.writeFileSync(target, "old\nkeep\n", "utf8");
    const params = { path: "notes.txt", content: "new\nkeep\nextra\n" };
    const tracker = prepareFileEditTracker({
      callId: "call-write",
      toolName: "write_file",
      tool: null,
      workspace: root,
      params,
    });

    expect(tracker).not.toBeNull();
    expect(buildFileEditStartEvent(tracker!, params)).toEqual({
      version: 1,
      call_id: "call-write",
      ui_tool_call_id: expect.any(String),
      tool: "write_file",
      path: "notes.txt",
      absolute_path: slash(target),
      phase: "start",
      added: 2,
      deleted: 1,
      approximate: true,
      status: "editing",
    });

    fs.writeFileSync(target, "new\nkeep\nextra\n", "utf8");
    const end = buildFileEditEndEvent(tracker!);
    expect(end.phase).toBe("end");
    expect(end.status).toBe("done");
    expect(end.approximate).toBe(false);
    expect([end.added, end.deleted]).toEqual([2, 1]);
  });

  it("builds an explicit completed event for a confirmed no-op", () => {
    const root = tmpRoot();
    const target = path.join(root, "same.txt");
    fs.writeFileSync(target, "same\n", "utf8");
    const tracker = prepareFileEditTracker({
      callId: "call-noop",
      toolName: "write_file",
      tool: null,
      workspace: root,
      params: { path: "same.txt", content: "same\n" },
    });

    const event = buildFileEditEndEvent(
      tracker!,
      { path: "same.txt", content: "same\n" },
      { changed: false },
    );

    expect(event).toMatchObject({
      call_id: "call-noop",
      phase: "end",
      status: "done",
      added: 0,
      deleted: 0,
      approximate: false,
      unchanged: true,
    });
    expect(event.binary).toBeUndefined();
  });

  it("reports binary files without line counts", () => {
    const root = tmpRoot();
    const target = path.join(root, "data.bin");
    fs.writeFileSync(target, Buffer.from([0, 1, ...Buffer.from("before")]));
    const tracker = prepareFileEditTracker({
      callId: "call-bin",
      toolName: "edit_file",
      tool: null,
      workspace: root,
      params: { path: "data.bin", old_text: "before", new_text: "after" },
    });

    expect(tracker).not.toBeNull();
    expect(readFileSnapshot(target).countable).toBe(false);
    fs.writeFileSync(target, Buffer.from([0, 1, ...Buffer.from("after")]));
    const event = buildFileEditEndEvent(tracker!);
    expect(event.binary).toBe(true);
    expect([event.added, event.deleted]).toEqual([0, 0]);
  });

  it("prepares apply_patch trackers for each touched file", () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, "src"));
    const existing = path.join(root, "src", "existing.ts");
    const deleteMe = path.join(root, "src", "delete_me.ts");
    fs.writeFileSync(existing, "old\nkeep\n", "utf8");
    fs.writeFileSync(deleteMe, "gone\n", "utf8");
    const patchInput = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+fresh",
      "*** Update File: src/existing.ts",
      "@@",
      "-old",
      "+new",
      "*** Delete File: src/delete_me.ts",
      "*** End Patch",
    ].join("\n");

    const trackers = prepareFileEditTrackers({
      callId: "call-patch",
      toolName: "apply_patch",
      tool: new ApplyPatchTool({ workspace: root }),
      workspace: root,
      params: { input: patchInput, extra: true },
    });

    expect(trackers.map((tracker) => tracker.displayPath)).toEqual([
      "src/new.ts",
      "src/existing.ts",
      "src/delete_me.ts",
    ]);

    fs.writeFileSync(path.join(root, "src", "new.ts"), "fresh\n", "utf8");
    fs.writeFileSync(existing, "new\nkeep\n", "utf8");
    fs.unlinkSync(deleteMe);
    const events = trackers.map((tracker) => buildFileEditEndEvent(tracker, { input: patchInput }));
    const byPath = Object.fromEntries(events.map((event) => [event.path, event]));
    expect([byPath["src/new.ts"].added, byPath["src/new.ts"].deleted]).toEqual([1, 0]);
    expect([byPath["src/existing.ts"].added, byPath["src/existing.ts"].deleted]).toEqual([1, 1]);
    expect([byPath["src/delete_me.ts"].added, byPath["src/delete_me.ts"].deleted]).toEqual([0, 1]);
  });

  it("requires a string input and the safe apply_patch resolver", () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "file.txt"), "old\n", "utf8");

    expect(prepareFileEditTrackers({
      callId: "call-patch",
      toolName: "apply_patch",
      tool: new ApplyPatchTool({ workspace: root }),
      workspace: root,
      params: { edits: [{ path: "file.txt" }] },
    })).toEqual([]);
    expect(prepareFileEditTrackers({
      callId: "call-patch",
      toolName: "apply_patch",
      tool: null,
      workspace: root,
      params: { input: "*** Begin Patch\n*** Delete File: file.txt\n*** End Patch" },
    })).toEqual([]);
  });

  it("uses known write_file content for oversized end counts", () => {
    const root = tmpRoot();
    const target = path.join(root, "large.txt");
    const params = { path: "large.txt", content: "x".repeat(2 * 1024 * 1024 + 1) };
    const tracker = prepareFileEditTracker({
      callId: "call-large",
      toolName: "write_file",
      tool: null,
      workspace: root,
      params,
    });

    expect(tracker).not.toBeNull();
    fs.writeFileSync(target, params.content, "utf8");
    const event = buildFileEditEndEvent(tracker!, params);
    expect(event.binary).not.toBe(true);
    expect(event.added).toBe(1);
    expect(event.deleted).toBe(0);
  });

  it("streams write_file live line counts", async () => {
    const root = tmpRoot();
    const events: Record<string, any>[] = [];
    const tracker = new StreamingFileEditTracker({ workspace: root, tools: {}, emit: (batch) => { events.push(...batch); } });

    await tracker.update({
      index: 0,
      call_id: "call-live",
      name: "write_file",
      arguments_delta: '{"path":"notes.md","content":"',
    });
    await tracker.update({ index: 0, arguments_delta: "line\\n".repeat(24) });

    expect(events[0]).toEqual({
      version: 1,
      call_id: "call-live",
      ui_tool_call_id: expect.any(String),
      tool: "write_file",
      path: "notes.md",
      absolute_path: slash(path.join(root, "notes.md")),
      phase: "start",
      added: 0,
      deleted: 0,
      approximate: true,
      status: "editing",
    });
    expect(events.at(-1)).toMatchObject({ path: "notes.md", status: "editing", approximate: true, added: 24, deleted: 0 });
  });

  it("streams apply_patch live counts per file", async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "existing.ts"), "old\nkeep\n", "utf8");
    const events: Record<string, any>[] = [];
    const tools = new Map([["apply_patch", new ApplyPatchTool({ workspace: root })]]);
    const tracker = new StreamingFileEditTracker({ workspace: root, tools, emit: (batch) => { events.push(...batch); } });

    const patchInput = [
      "*** Begin Patch",
      "*** Update File: src/existing.ts",
      "@@",
      "-old",
      "+new",
      "*** Add File: src/new.ts",
      "+fresh",
      "*** End Patch",
    ].join("\n");
    const encoded = JSON.stringify({ input: patchInput });

    await tracker.update({
      index: 0,
      call_id: "call-patch",
      name: "apply_patch",
      arguments_delta: encoded.slice(0, Math.floor(encoded.length / 2)),
    });
    await tracker.update({ index: 0, arguments_delta: encoded.slice(Math.floor(encoded.length / 2)) });
    await tracker.flush();

    const byPath = Object.fromEntries(events.map((event) => [event.path, event]));
    expect(byPath["src/existing.ts"].tool).toBe("apply_patch");
    expect(byPath["src/existing.ts"].status).toBe("editing");
    expect(byPath["src/existing.ts"].approximate).toBe(true);
    expect([byPath["src/existing.ts"].added, byPath["src/existing.ts"].deleted]).toEqual([1, 1]);
    expect([byPath["src/new.ts"].added, byPath["src/new.ts"].deleted]).toEqual([1, 0]);
  });

  it("does not stream apply_patch paths without the safe resolver", async () => {
    const root = tmpRoot();
    const events: Record<string, any>[] = [];
    const tracker = new StreamingFileEditTracker({ workspace: root, tools: {}, emit: (batch) => { events.push(...batch); } });

    await tracker.update({
      index: 0,
      call_id: "call-patch",
      name: "apply_patch",
      arguments_delta: JSON.stringify({
        input: "*** Begin Patch\n*** Add File: dry.md\n+preview\n*** End Patch",
      }),
    });

    expect(events).toEqual([]);
  });

  it("streams move source deletion and target addition counts", async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "source.txt"), "one\ntwo\nthree\n", "utf8");
    const events: Record<string, any>[] = [];
    const tools = new Map([["apply_patch", new ApplyPatchTool({ workspace: root })]]);
    const tracker = new StreamingFileEditTracker({
      workspace: root,
      tools,
      emit: (batch) => { events.push(...batch); },
    });
    await tracker.update({
      index: 0,
      name: "apply_patch",
      arguments_delta: JSON.stringify({
        input: [
          "*** Begin Patch",
          "*** Update File: source.txt",
          "*** Move to: target.txt",
          "@@",
          "-two",
          "+changed",
          "*** End Patch",
        ].join("\n"),
      }),
    });

    const byPath = Object.fromEntries(events.map((event) => [event.path, event]));
    expect([byPath["source.txt"].added, byPath["source.txt"].deleted]).toEqual([0, 3]);
    expect([byPath["target.txt"].added, byPath["target.txt"].deleted]).toEqual([3, 0]);
  });

  it("uses fatal UTF-8 decoding only when requested", () => {
    const root = tmpRoot();
    const target = path.join(root, "invalid.txt");
    fs.writeFileSync(target, Buffer.from([0xff, 0xfe]));

    expect(readFileSnapshot(target).binary).toBe(false);
    expect(readFileSnapshot(target, { fatalUtf8: true }).binary).toBe(true);
  });

  it("emits a pending write_file event before the path arrives", async () => {
    const root = tmpRoot();
    const events: Record<string, any>[] = [];
    const tracker = new StreamingFileEditTracker({ workspace: root, tools: {}, emit: (batch) => { events.push(...batch); } });

    await tracker.update({
      index: 0,
      call_id: "call-live",
      name: "write_file",
      arguments_delta: '{"content":"line\\n',
    });
    await tracker.update({ index: 0, arguments_delta: 'more\\n","path":"late.md"' });

    expect(events[0]).toEqual({
      version: 1,
      call_id: "call-live",
      ui_tool_call_id: expect.any(String),
      tool: "write_file",
      path: "",
      phase: "start",
      added: 1,
      deleted: 0,
      approximate: true,
      status: "editing",
      pending: true,
    });
    expect(events.at(-1)?.path).toBe("late.md");
    expect(events.at(-1)?.pending).not.toBe(true);
    expect(events.at(-1)?.added).toBe(2);
  });

  it("flushes a small pending write_file count", async () => {
    const root = tmpRoot();
    const events: Record<string, any>[] = [];
    const tracker = new StreamingFileEditTracker({ workspace: root, tools: {}, emit: (batch) => { events.push(...batch); } });

    await tracker.update({
      index: 0,
      call_id: "call-live",
      name: "write_file",
      arguments_delta: '{"path":"small.md","content":"one\\n',
    });
    await tracker.flush();

    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)?.path).toBe("small.md");
    expect(events.at(-1)?.added).toBe(1);
  });

  it("normalizes CRLF counts while streaming write_file", async () => {
    const root = tmpRoot();
    const events: Record<string, any>[] = [];
    const tracker = new StreamingFileEditTracker({ workspace: root, tools: {}, emit: (batch) => { events.push(...batch); } });

    await tracker.update({
      index: 0,
      call_id: "call-live",
      name: "write_file",
      arguments_delta: '{"path":"windows.txt","content":"one\\r\\ntwo\\r\\n',
    });
    await tracker.flush();

    expect(events.at(-1)?.path).toBe("windows.txt");
    expect(events.at(-1)?.added).toBe(2);
  });

  it("counts unicode-escaped newlines while streaming write_file", async () => {
    const root = tmpRoot();
    const events: Record<string, any>[] = [];
    const tracker = new StreamingFileEditTracker({ workspace: root, tools: {}, emit: (batch) => { events.push(...batch); } });

    await tracker.update({
      index: 0,
      call_id: "call-live",
      name: "write_file",
      arguments_delta: '{"path":"unicode.txt","content":"one\\u000atwo',
    });
    await tracker.flush();

    expect(events.at(-1)?.path).toBe("unicode.txt");
    expect(events.at(-1)?.added).toBe(2);
  });

  it("streams edit_file live line counts", async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "notes.md"), "old\nkeep\n", "utf8");
    const events: Record<string, any>[] = [];
    const tracker = new StreamingFileEditTracker({ workspace: root, tools: {}, emit: (batch) => { events.push(...batch); } });

    await tracker.update({
      index: 0,
      call_id: "call-edit",
      name: "edit_file",
      arguments_delta: '{"path":"notes.md","old_text":"old\\nkeep","new_text":"',
    });
    await tracker.update({ index: 0, arguments_delta: "new\\nkeep\\nextra\\n".repeat(8) });

    expect(events[0]).toEqual({
      version: 1,
      call_id: "call-edit",
      ui_tool_call_id: expect.any(String),
      tool: "edit_file",
      path: "notes.md",
      absolute_path: slash(path.join(root, "notes.md")),
      phase: "start",
      added: 0,
      deleted: 2,
      approximate: true,
      status: "editing",
    });
    expect(events.at(-1)).toMatchObject({ path: "notes.md", status: "editing", approximate: true, added: 24, deleted: 2 });
  });

  it("binds live and final calls without changing the Provider call id", async () => {
    const root = tmpRoot();
    const tracker = new StreamingFileEditTracker({ workspace: root, tools: {}, emit: () => undefined });
    await tracker.update({ index: 0, name: "write_file", arguments_delta: '{"path":"matched.md","content":"one\\n' });
    const final = { id: "provider-final-id", name: "write_file", arguments: { path: "matched.md", content: "one\n" } };

    tracker.bindFinalToolCalls([final]);

    expect(final.id).toBe("provider-final-id");
    expect(getOrCreateUiToolCallId(final)).toBe(tracker.states.get("idx:0")?.uiToolCallId);
  });

  it("gives final calls distinct UI ids when streamed Provider ids repeat", async () => {
    const root = tmpRoot();
    const tracker = new StreamingFileEditTracker({ workspace: root, tools: {}, emit: () => undefined });
    await tracker.update({ index: 0, call_id: "call_dup", name: "write_file", arguments_delta: '{"path":"a.md","content":"one\\n"}' });
    await tracker.update({ index: 1, call_id: "call_dup", name: "write_file", arguments_delta: '{"path":"b.md","content":"two\\n"}' });
    const finalA = { id: "call_dup", name: "write_file", arguments: { path: "a.md", content: "one\n" } };
    const finalB = { id: "call_dup", name: "write_file", arguments: { path: "b.md", content: "two\n" } };

    tracker.bindFinalToolCalls([finalA, finalB]);

    expect(finalA.id).toBe("call_dup");
    expect(finalB.id).toBe("call_dup");
    expect(getOrCreateUiToolCallId(finalA)).not.toBe(getOrCreateUiToolCallId(finalB));
  });

  it("gives final calls distinct UI ids when Provider ids are missing", async () => {
    const root = tmpRoot();
    const tracker = new StreamingFileEditTracker({ workspace: root, tools: {}, emit: () => undefined });
    await tracker.update({ index: 0, name: "write_file", arguments_delta: '{"path":"a.md","content":"one\\n"}' });
    await tracker.update({ index: 1, name: "write_file", arguments_delta: '{"path":"b.md","content":"two\\n"}' });
    const finalA = { id: "", name: "write_file", arguments: { path: "a.md", content: "one\n" } };
    const finalB = { id: "", name: "write_file", arguments: { path: "b.md", content: "two\n" } };

    tracker.bindFinalToolCalls([finalA, finalB]);

    expect(finalA.id).toBe("");
    expect(finalB.id).toBe("");
    expect(getOrCreateUiToolCallId(finalA)).not.toBe(getOrCreateUiToolCallId(finalB));
  });

  it("binds a unique closed apply_patch input when indexes and Provider ids are unavailable", async () => {
    const root = tmpRoot();
    const tools = new Map([["apply_patch", new ApplyPatchTool({ workspace: root })]]);
    const tracker = new StreamingFileEditTracker({ workspace: root, tools, emit: () => undefined });
    const patchInput = "*** Begin Patch\n*** Add File: exact.txt\n+one\n*** End Patch";
    await tracker.update({
      call_id: "stream-only",
      name: "apply_patch",
      arguments_delta: JSON.stringify({ input: patchInput }),
    });
    const final = { id: "", name: "apply_patch", arguments: { input: patchInput } };

    tracker.bindFinalToolCalls([final]);

    const state = tracker.states.get("id:stream-only");
    expect(state?.inputClosed).toBe(true);
    expect(state?.boundFinal).toBe(true);
    expect(getOrCreateUiToolCallId(final)).toBe(state?.uiToolCallId);
  });

  it("does not bind an apply_patch stream state to another tool or missing string input", async () => {
    const root = tmpRoot();
    const tools = new Map([["apply_patch", new ApplyPatchTool({ workspace: root })]]);
    const tracker = new StreamingFileEditTracker({ workspace: root, tools, emit: () => undefined });
    await tracker.update({
      index: 0,
      name: "apply_patch",
      arguments_delta: JSON.stringify({
        input: "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch",
      }),
    });

    tracker.bindFinalToolCalls([
      { name: "write_file", arguments: { path: "a.txt" } },
      { name: "apply_patch", arguments: {} },
    ]);

    expect(tracker.states.get("idx:0")?.boundFinal).toBe(false);
  });

  it("flushes a small pending edit_file count", async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "small.ts"), "old\n", "utf8");
    const events: Record<string, any>[] = [];
    const tracker = new StreamingFileEditTracker({ workspace: root, tools: {}, emit: (batch) => { events.push(...batch); } });

    await tracker.update({
      index: 0,
      call_id: "call-edit",
      name: "edit_file",
      arguments_delta: '{"path":"small.ts","old_text":"old\\n","new_text":"new\\nextra',
    });
    await tracker.flush();

    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)?.path).toBe("small.ts");
    expect(events.at(-1)?.added).toBe(2);
    expect(events.at(-1)?.deleted).toBe(1);
  });

  it("errors unmatched live write_file edits", async () => {
    const root = tmpRoot();
    const events: Record<string, any>[] = [];
    const tracker = new StreamingFileEditTracker({ workspace: root, tools: {}, emit: (batch) => { events.push(...batch); } });

    await tracker.update({
      index: 0,
      call_id: "call-live",
      name: "write_file",
      arguments_delta: '{"path":"aborted.md","content":"one\\n',
    });
    await tracker.errorUnmatched([], "Tool call did not complete.");

    expect(events.at(-1)?.path).toBe("aborted.md");
    expect(events.at(-1)?.phase).toBe("error");
    expect(events.at(-1)?.status).toBe("error");
  });

  it("keeps matched final tool calls when erroring unmatched live edits", async () => {
    const root = tmpRoot();
    const events: Record<string, any>[] = [];
    const tracker = new StreamingFileEditTracker({ workspace: root, tools: {}, emit: (batch) => { events.push(...batch); } });

    await tracker.update({
      index: 0,
      call_id: "idx-only",
      name: "write_file",
      arguments_delta: '{"path":"matched.md","content":"one\\n',
    });
    const finalCalls = [
      { id: "final-call", name: "write_file", arguments: { path: "matched.md", content: "one\n" } },
    ];
    tracker.bindFinalToolCalls(finalCalls);
    await tracker.errorUnmatched(finalCalls, "Tool call did not complete.");

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.status === "editing")).toBe(true);
  });

  it("emits one cancellation terminal event and ignores later write_file deltas after abort", async () => {
    const root = tmpRoot();
    const events: Record<string, any>[] = [];
    const tracker = new StreamingFileEditTracker({ workspace: root, tools: {}, emit: (batch) => { events.push(...batch); } });

    await tracker.update({
      index: 0,
      call_id: "call-live",
      name: "write_file",
      arguments_delta: '{"path":"cancelled.md","content":"',
    });
    await tracker.update({ index: 0, arguments_delta: "line\\n".repeat(24) });
    await tracker.abort("Task cancelled.");
    await tracker.update({ index: 0, arguments_delta: "late\\n".repeat(24) });
    await tracker.flush();
    await tracker.abort("Task cancelled again.");

    const terminalEvents = events.filter((event) => event.cancellation_terminal === true);
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]).toMatchObject({
      call_id: "call-live",
      path: "cancelled.md",
      phase: "error",
      status: "error",
      error: "Task cancelled.",
    });
    expect(events.some((event) => event.path === "cancelled.md" && event.added === 48)).toBe(false);
  });

  it("emits a pending cancellation terminal event when abort happens before the path arrives", async () => {
    const root = tmpRoot();
    const events: Record<string, any>[] = [];
    const tracker = new StreamingFileEditTracker({ workspace: root, tools: {}, emit: (batch) => { events.push(...batch); } });

    await tracker.update({
      index: 0,
      call_id: "call-pending",
      name: "write_file",
      arguments_delta: '{"content":"line\\n',
    });
    await tracker.abort("Task cancelled.");

    expect(events.at(-1)).toMatchObject({
      call_id: "call-pending",
      tool: "write_file",
      path: "",
      phase: "error",
      status: "error",
      pending: true,
      cancellation_terminal: true,
    });
  });

  it("does not prepare trackers for untracked tools", () => {
    const root = tmpRoot();

    expect(prepareFileEditTracker({
      callId: "call-exec",
      toolName: "exec",
      tool: null,
      workspace: root,
      params: { path: "created-by-shell.txt" },
    })).toBeNull();
  });
});
