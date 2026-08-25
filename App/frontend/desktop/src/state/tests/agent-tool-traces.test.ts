/**
 * memmy-agent tool trace helper tests.
 */
import { describe, expect, it } from "vitest";
import {
  extractApplyPatchSummaryPaths,
  formatToolCallTrace,
  mergeFileEdits,
  mergeToolProgressEvents,
  mergeUniqueToolTraceLines,
  normalizeToolProgressEvents,
  normalizeFileEdits,
  summarizeToolCall,
  toolTraceLinesFromEvents
} from "../agent-tool-traces.js";

describe("agent tool trace helpers", () => {
  it("normalizes structured tool events and dedupes trace lines by call id", () => {
    const events = [
      { phase: "start", call_id: "1", name: "web_search", arguments: { query: "Memmy" } },
      { phase: "end", call_id: "1", name: "web_search", arguments: { query: "Memmy" } },
      { phase: "pending", call_id: "2", name: "ignored" },
      { phase: "start", call_id: "3" }
    ];

    expect(normalizeToolProgressEvents(events)).toHaveLength(2);
    expect(toolTraceLinesFromEvents(events)).toEqual(["Searched web for Memmy"]);
  });

  it("merges phase updates and keeps the most advanced event", () => {
    const merged = mergeToolProgressEvents(
      [{ phase: "start", call_id: "1", name: "web_fetch", arguments: { url: "https://example.com" } }],
      [{ phase: "error", call_id: "1", name: "web_fetch", error: "timeout" }]
    );

    expect(merged).toEqual([
      { phase: "error", call_id: "1", name: "web_fetch", arguments: { url: "https://example.com" }, error: "timeout" }
    ]);
  });

  it("merges one UI tool call while preserving distinct calls with repeated Provider ids", () => {
    const merged = mergeToolProgressEvents(
      [{ phase: "start", call_id: "stream-id", ui_tool_call_id: "ui-1", name: "write_file" }],
      [
        { phase: "end", call_id: "provider-final", ui_tool_call_id: "ui-1", name: "write_file" },
        { phase: "end", call_id: "provider-final", ui_tool_call_id: "ui-2", name: "write_file" }
      ]
    );

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ phase: "end", call_id: "provider-final", ui_tool_call_id: "ui-1" });
    expect(merged[1]).toMatchObject({ phase: "end", call_id: "provider-final", ui_tool_call_id: "ui-2" });
  });

  it("keeps trace lines for distinct UI calls with a repeated Provider id", () => {
    expect(toolTraceLinesFromEvents([
      { phase: "end", call_id: "provider-final", ui_tool_call_id: "ui-1", name: "write_file", arguments: { path: "a.ts" } },
      { phase: "end", call_id: "provider-final", ui_tool_call_id: "ui-2", name: "write_file", arguments: { path: "b.ts" } }
    ])).toHaveLength(2);
  });

  it("keeps multi-file edits inside one UI call and rejects late phase downgrades", () => {
    const pending = normalizeFileEdits({
      call_id: "stream-id",
      ui_tool_call_id: "ui-patch",
      tool: "apply_patch",
      path: "",
      pending: true,
      phase: "start"
    });
    const completed = normalizeFileEdits([
      {
        call_id: "provider-final",
        ui_tool_call_id: "ui-patch",
        tool: "apply_patch",
        path: "src/a.ts",
        absolute_path: "/workspace/src/a.ts",
        phase: "end",
        added: 20
      },
      {
        call_id: "provider-final",
        ui_tool_call_id: "ui-patch",
        tool: "apply_patch",
        path: "src/b.ts",
        absolute_path: "/workspace/src/b.ts",
        phase: "end",
        added: 467
      }
    ]);
    const lateStart = normalizeFileEdits({
      call_id: "stream-id",
      ui_tool_call_id: "ui-patch",
      tool: "apply_patch",
      path: "src/a.ts",
      absolute_path: "/workspace/src/a.ts",
      phase: "start",
      added: 1,
      approximate: true
    });

    const merged = mergeFileEdits(mergeFileEdits(pending, completed), lateStart);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ path: "src/a.ts", phase: "end", status: "done", added: 20 });
    expect(merged[0]?.approximate).not.toBe(true);
    expect(merged[1]).toMatchObject({ path: "src/b.ts", phase: "end", status: "done", added: 467 });
  });

  it("does not synthesize a Provider call id for legacy file edits", () => {
    expect(normalizeFileEdits({ tool: "edit_file", path: "src/a.ts", phase: "end" })[0]?.call_id).toBe("");
  });

  it("preserves unchanged through normalization and terminal event merging", () => {
    const started = normalizeFileEdits({
      call_id: "call-noop",
      ui_tool_call_id: "ui-noop",
      tool: "edit_file",
      path: "src/a.ts",
      phase: "start",
      status: "editing",
      added: 1,
    });
    const completed = normalizeFileEdits({
      call_id: "call-noop",
      ui_tool_call_id: "ui-noop",
      tool: "edit_file",
      path: "src/a.ts",
      phase: "end",
      status: "done",
      added: 0,
      deleted: 0,
      unchanged: true,
    });

    expect(mergeFileEdits(started, completed)).toEqual([
      expect.objectContaining({
        phase: "end",
        status: "done",
        added: 0,
        deleted: 0,
        unchanged: true,
      }),
    ]);
  });

  it("appends only new trace lines", () => {
    expect(mergeUniqueToolTraceLines(["Read app.tsx"], ["Read app.tsx", "Searched web for Memmy"])).toEqual({
      traces: ["Read app.tsx", "Searched web for Memmy"],
      added: true
    });
  });

  it("summarizes shell exec calls without leaking the raw JSON blob", () => {
    const summary = summarizeToolCall({
      phase: "start",
      name: "exec",
      arguments: { command: "echo hello", explanation: "check greeting" }
    });

    expect(summary).toMatchObject({
      line: "Ran echo hello",
      verb: "Ran",
      detail: "echo hello",
      category: "shell",
      toolName: "exec"
    });
  });

  it("collapses noisy multi-line shell commands to a single readable line", () => {
    const summary = summarizeToolCall({
      phase: "start",
      name: "run_terminal_cmd",
      arguments: { command: "for i in a b c;\ndo\n  echo $i\ndone" }
    });

    expect(summary?.line).toBe("Ran for i in a b c; do echo $i done");
    expect(summary?.category).toBe("shell");
  });

  it("summarizes read_file calls with the basename and optional line range", () => {
    expect(summarizeToolCall({
      phase: "end",
      name: "read_file",
      arguments: { path: "/Users/lv/App/frontend/desktop/src/app.tsx", start_line: 40, end_line: 120 }
    })).toMatchObject({
      line: "Read app.tsx L40-120",
      category: "read"
    });
  });

  it("summarizes grep, glob, list_dir, edit_file, delete_file, web_fetch and web_search calls", () => {
    expect(summarizeToolCall({ phase: "end", name: "grep", arguments: { pattern: "handleClick" } })).toMatchObject({
      line: "Grepped handleClick",
      category: "grep"
    });
    expect(summarizeToolCall({ phase: "end", name: "glob", arguments: { glob_pattern: "**/*.tsx" } })).toMatchObject({
      line: "Globbed **/*.tsx",
      category: "glob"
    });
    expect(summarizeToolCall({ phase: "end", name: "list_dir", arguments: { target_directory: "/Users/lv/proj" } })).toMatchObject({
      line: "Listed proj",
      category: "list"
    });
    expect(summarizeToolCall({ phase: "end", name: "edit_file", arguments: { file_path: "/Users/lv/proj/app.tsx" } })).toMatchObject({
      line: "Edited app.tsx",
      category: "edit"
    });
    expect(summarizeToolCall({ phase: "end", name: "delete_file", arguments: { path: "notes.md" } })).toMatchObject({
      line: "Deleted notes.md",
      category: "delete"
    });
    expect(summarizeToolCall({ phase: "end", name: "web_fetch", arguments: { url: "https://cursor.com/docs" } })).toMatchObject({
      line: "Fetched cursor.com",
      category: "web"
    });
    expect(summarizeToolCall({ phase: "end", name: "web_search", arguments: { search_term: "memmy release notes" } })).toMatchObject({
      line: "Searched web for memmy release notes",
      category: "search"
    });
  });

  it("recognises common tool name aliases (bash, run_command, cat, ripgrep, ls) without extra config", () => {
    expect(summarizeToolCall({ phase: "end", name: "bash", arguments: { command: "ls -la" } })?.category).toBe("shell");
    expect(summarizeToolCall({ phase: "end", name: "functions.Shell", arguments: { command: "npm test" } })).toMatchObject({
      line: "Ran npm test",
      category: "shell"
    });
    expect(summarizeToolCall({ phase: "end", name: "ReadFile", arguments: { path: "README.md" } })).toMatchObject({
      line: "Read README.md",
      category: "read"
    });
    expect(summarizeToolCall({ phase: "end", name: "cat", arguments: { file: "README.md" } })).toMatchObject({
      line: "Read README.md",
      category: "read"
    });
    expect(summarizeToolCall({ phase: "end", name: "ripgrep", arguments: { pattern: "TODO" } })?.category).toBe("grep");
    expect(summarizeToolCall({ phase: "end", name: "ls", arguments: { path: "/tmp" } })?.category).toBe("list");
    expect(summarizeToolCall({ phase: "end", name: "mcp_office_read_file", arguments: { file: "brief.md" } })?.category).toBe("read");
    expect(summarizeToolCall({ phase: "end", name: "CallMcpTool", arguments: { server: "linear", toolName: "search" } })).toMatchObject({
      line: "Called MCP linear / search",
      category: "mcp"
    });
    expect(summarizeToolCall({ phase: "end", name: "GenerateImage", arguments: { filename: "card.png", description: "trading card" } })).toMatchObject({
      line: "Generated image card.png",
      category: "image"
    });
    expect(summarizeToolCall({ phase: "end", name: "Subagent", arguments: { description: "Explore chat UI" } })).toMatchObject({
      line: "Launched Explore chat UI",
      category: "task"
    });
  });

  it("falls back to a generic `Called <toolname>` line when the tool is unknown", () => {
    expect(formatToolCallTrace({ phase: "end", name: "some_new_tool", arguments: { foo: 1 } })).toBe("Called Some new tool");
    expect(formatToolCallTrace({ phase: "end", function: { name: "custom.action" } })).toBe("Called Custom action");
  });

  it("returns null for calls without a tool name so callers can skip them", () => {
    expect(formatToolCallTrace({ phase: "end", arguments: {} })).toBeNull();
    expect(summarizeToolCall(null)).toBeNull();
  });

  it("parses stringified JSON arguments so they aren't shown as raw text", () => {
    expect(formatToolCallTrace({ phase: "end", name: "exec", arguments: '{"command":"npm test"}' })).toBe("Ran npm test");
  });

  it("summarizes exact apply_patch calls without exposing the patch body", () => {
    const singleInput = [
      "*** Begin Patch",
      "*** Update File: src/app.ts",
      "@@",
      "-old secret body",
      "+new secret body",
      "*** End Patch",
    ].join("\n");
    const multiInput = [
      "*** Begin Patch",
      "*** Update File: src/old.ts",
      "*** Move to: src/new.ts",
      "*** Add File: src/extra.ts",
      "+extra",
      "*** End Patch",
    ].join("\n");

    expect(summarizeToolCall({ name: "apply_patch", arguments: { input: singleInput } })).toMatchObject({
      line: "Patched app.ts",
      category: "edit",
    });
    expect(summarizeToolCall({ name: "apply_patch", arguments: JSON.stringify({ input: multiInput }) })).toMatchObject({
      line: "Patched 3 files",
      category: "edit",
    });
    expect(formatToolCallTrace({ name: "apply_patch", arguments: { input: "*** Begin Pat" } })).toBe(
      "Applied patch",
    );
    expect(formatToolCallTrace({ name: "apply_patch", arguments: { input: singleInput } })).not.toContain(
      "secret body",
    );
  });

  it("extracts normalized unique apply_patch paths and stops at invalid control input", () => {
    const input = [
      "*** Begin Patch",
      "*** Add File: ./src//a.ts",
      "+*** Update File: fake.ts",
      "*** Update File: src\\a.ts",
      "@@",
      "-old",
      "+new",
      "invalid",
      "*** Add File: ignored.ts",
      "+ignored",
      "*** End Patch",
    ].join("\n");

    expect(extractApplyPatchSummaryPaths(input)).toEqual(["src/a.ts"]);
  });

  it("keeps non-exact apply patch aliases on the existing edit_file summary path", () => {
    for (const name of ["applypatch", "patch", "mcp_server_apply_patch"]) {
      expect(formatToolCallTrace({ name, arguments: { path: "src/legacy.ts" } })).toBe("Edited legacy.ts");
    }
  });
});
