/**
 * memmy-agent tool trace helper tests.
 */
import { describe, expect, it } from "vitest";
import {
  formatToolCallTrace,
  mergeToolProgressEvents,
  mergeUniqueToolTraceLines,
  normalizeToolProgressEvents,
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
});
