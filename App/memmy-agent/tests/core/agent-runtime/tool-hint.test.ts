import { describe, expect, it } from "vitest";
import { formatToolHints } from "../../../src/utils/tool-hints.js";

function tc(name: string, args: any): Record<string, any> {
  return { id: "c1", name, arguments: args };
}

function hint(calls: any[], maxLength = 40): string {
  return formatToolHints(calls, maxLength);
}

describe("Tool Hint Known Tools", () => {
  it("read file short path", () => {
    expect(hint([tc("read_file", { path: "foo.txt" })])).toBe("read foo.txt");
  });

  it("read file long path", () => {
    const result = hint([
      tc("read_file", { path: "/home/user/.local/share/uv/tools/memmy/agent/loop.ts" }),
    ]);
    expect(result).toContain("loop.ts");
    expect(result).toContain("read ");
  });

  it("write file shows path not content", () => {
    const result = hint([
      tc("write_file", { path: "docs/api.md", content: "# API Reference\n\nLong content..." }),
    ]);
    expect(result).toBe("write docs/api.md");
  });

  it("edit shows path", () => {
    const result = hint([tc("edit", { file_path: "src/main.ts", old_string: "x", new_string: "y" })]);
    expect(result).toContain("main.ts");
    expect(result).toContain("edit ");
  });

  it("grep shows pattern", () => {
    expect(hint([tc("grep", { pattern: "TODO|FIXME", path: "src" })])).toBe('grep "TODO|FIXME"');
  });

  it("exec shows command", () => {
    expect(hint([tc("exec", { command: "npm install typescript" })])).toBe("$ npm install typescript");
  });

  it("exec truncates long command", () => {
    const cmd = "cd /very/long/path && cat file && echo done && sleep 1 && ls -la";
    const result = hint([tc("exec", { command: cmd })]);
    expect(result).toMatch(/^\$ /);
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it("exec abbreviates paths in command", () => {
    const cmd =
      "cd D:\\Documents\\GitHub\\memmy-agent-enterprise\\.worktree\\tomain\\memmy-agent && git diff origin/main...pr-2706 --name-only 2>&1";
    const result = hint([tc("exec", { command: cmd })]);
    expect(result).toContain("\u2026/");
    expect(result).not.toContain("worktree");
  });

  it("exec abbreviates linux paths", () => {
    const cmd = "cd /home/user/projects/memmy-agent-enterprise/.worktree/tomain && make build";
    const result = hint([tc("exec", { command: cmd })]);
    expect(result).toContain("\u2026/");
    expect(result).not.toContain("projects");
  });

  it("exec abbreviates home paths", () => {
    const cmd = "cd ~/projects/memmy/workspace && npm test";
    const result = hint([tc("exec", { command: cmd })]);
    expect(result).toContain("\u2026/");
  });

  it("exec abbreviates quoted linux paths with spaces", () => {
    const cmd = 'cd "/home/user/My Documents/project" && npm test';
    const result = hint([tc("exec", { command: cmd })]);
    expect(result).toContain("\u2026/");
    expect(result).not.toContain('"/home/user/My Documents/project"');
    expect(result).toContain('"');
  });

  it("exec abbreviates quoted windows paths with spaces", () => {
    const cmd = 'cd "C:/Program Files/Git/project" && git status';
    const result = hint([tc("exec", { command: cmd })]);
    expect(result).toContain("\u2026/");
    expect(result).not.toContain('"C:/Program Files/Git/project"');
    expect(result).toContain('"');
  });

  it("exec short command unchanged", () => {
    expect(hint([tc("exec", { command: "npm install typescript" })])).toBe("$ npm install typescript");
  });

  it("exec chained commands truncated not mid path", () => {
    const cmd = "cd D:\\Documents\\GitHub\\project && npm run build && npm test";
    const result = hint([tc("exec", { command: cmd })]);
    expect(result).toContain("\u2026/");
    expect(result).toContain("npm");
  });

  it("web search", () => {
    expect(hint([tc("web_search", { query: "Claude 4 vs GPT-4" })])).toBe(
      'search "Claude 4 vs GPT-4"',
    );
  });

  it("web fetch", () => {
    expect(hint([tc("web_fetch", { url: "https://example.com/page" })])).toBe(
      "fetch https://example.com/page",
    );
  });
});

describe("Tool Hint MCP", () => {
  it("mcp standard format", () => {
    const result = hint([
      tc("mcp_4_5v_mcp__analyze_image", { imageSource: "https://img.jpg", prompt: "describe" }),
    ]);
    expect(result).toContain("4_5v");
    expect(result).toContain("analyze_image");
  });

  it("mcp simple name", () => {
    const result = hint([tc("mcp_github__create_issue", { title: "Bug fix" })]);
    expect(result).toContain("github");
    expect(result).toContain("create_issue");
  });
});

describe("Tool Hint Fallback", () => {
  it("unknown tool with string arg", () => {
    expect(hint([tc("custom_tool", { data: "hello world" })])).toBe('custom_tool("hello world")');
  });

  it("unknown tool with long arg truncates", () => {
    const result = hint([tc("custom_tool", { data: "a".repeat(60) })]);
    expect(result.length).toBeLessThan(80);
    expect(result).toContain("\u2026");
  });

  it("unknown tool no string arg", () => {
    expect(hint([tc("custom_tool", { count: 42 })])).toBe("custom_tool");
  });

  it("empty tool calls", () => {
    expect(hint([])).toBe("");
  });
});

describe("Tool Hint Folding", () => {
  it("single call no fold", () => {
    const result = hint([tc("grep", { pattern: "*.ts" })]);
    expect(result).not.toContain("\u00d7");
  });

  it("two consecutive different args not folded", () => {
    const result = hint([tc("grep", { pattern: "*.ts" }), tc("grep", { pattern: "*.tsx" })]);
    expect(result).not.toContain("\u00d7");
  });

  it("two consecutive same args folded", () => {
    const result = hint([tc("grep", { pattern: "TODO" }), tc("grep", { pattern: "TODO" })]);
    expect(result).toContain("\u00d7 2");
  });

  it("three consecutive different args not folded", () => {
    const result = hint([
      tc("read_file", { path: "a.ts" }),
      tc("read_file", { path: "b.ts" }),
      tc("read_file", { path: "c.ts" }),
    ]);
    expect(result).not.toContain("\u00d7");
  });

  it("different tools not folded", () => {
    const result = hint([tc("grep", { pattern: "TODO" }), tc("read_file", { path: "a.ts" })]);
    expect(result).not.toContain("\u00d7");
  });

  it("interleaved same tools not folded", () => {
    const result = hint([
      tc("grep", { pattern: "a" }),
      tc("read_file", { path: "f.ts" }),
      tc("grep", { pattern: "b" }),
    ]);
    expect(result).not.toContain("\u00d7");
  });
});

describe("Tool Hint Multiple Calls", () => {
  it("two different tools", () => {
    const result = hint([tc("grep", { pattern: "TODO" }), tc("read_file", { path: "main.ts" })]);
    expect(result).toContain('grep "TODO"');
    expect(result).toContain("read main.ts");
    expect(result).toContain(", ");
  });
});

describe("Tool Hint Edge Cases", () => {
  it("known tool empty list args", () => {
    expect(hint([tc("read_file", [])])).toBe("read_file");
  });

  it("known tool none args", () => {
    expect(hint([tc("read_file", null)])).toBe("read_file");
  });

  it("fallback empty list args", () => {
    expect(hint([tc("custom_tool", [])])).toBe("custom_tool");
  });

  it("fallback none args", () => {
    expect(hint([tc("custom_tool", null)])).toBe("custom_tool");
  });

  it("list dir registered", () => {
    expect(hint([tc("list_dir", { path: "/tmp" })])).toBe("ls /tmp");
  });
});

describe("Tool Hint Mixed Folding", () => {
  it("read read grep grep read", () => {
    const result = hint([
      tc("read_file", { path: "a.ts" }),
      tc("read_file", { path: "b.ts" }),
      tc("grep", { pattern: "x" }),
      tc("grep", { pattern: "y" }),
      tc("read_file", { path: "c.ts" }),
    ]);
    expect(result).not.toContain("\u00d7");
    expect(result.split(", ")).toHaveLength(5);
  });
});

describe("Tool Hint Max Length", () => {
  it("exec default truncates at 40", () => {
    const cmd = "cd /very/long/path/to/some/project && npm run build && npm test";
    const result = hint([tc("exec", { command: cmd })], 40);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result).toContain("\u2026");
  });

  it("exec larger max length shows more", () => {
    const cmd = "cd /very/long/path/to/some/project && npm run build && npm test";
    const short = hint([tc("exec", { command: cmd })], 40);
    const long = hint([tc("exec", { command: cmd })], 120);
    expect(long.length).toBeGreaterThan(short.length);
    expect(long).toContain("npm test");
  });

  it("exec max length 120 shows full command", () => {
    const cmd = "cd /home/user/project && npm install && npm run build";
    const result = hint([tc("exec", { command: cmd })], 120);
    expect(result).toContain("npm run build");
  });

  it("fallback respects max length", () => {
    const longVal = "a".repeat(100);
    const result = hint([tc("custom_tool", { data: longVal })], 60);
    const result40 = hint([tc("custom_tool", { data: longVal })], 40);
    expect(result).toContain("\u2026");
    expect(result.length).toBeGreaterThan(result40.length);
  });

  it("mcp respects max length", () => {
    const longUrl = "https://example.com/very/long/path/to/resource";
    const result = hint([tc("mcp_github__fetch", { url: longUrl })], 80);
    const result40 = hint([tc("mcp_github__fetch", { url: longUrl })], 40);
    expect(result.length).toBeGreaterThanOrEqual(result40.length);
  });

  it("path type respects max length", () => {
    const longPath = "/home/user/.local/share/npm/global/lib/node_modules/memmy-agent/src/core/agent-runtime/loop.ts";
    const short = hint([tc("read_file", { path: longPath })], 40);
    const long = hint([tc("read_file", { path: longPath })], 120);
    expect(long.length).toBeGreaterThan(short.length);
  });

  it("edit path respects max length", () => {
    const longPath = "/home/user/projects/memmy-agent-enterprise/src/core/agent-runtime/loop.ts";
    const short = hint([tc("edit", { file_path: longPath })], 40);
    const long = hint([tc("edit", { file_path: longPath })], 120);
    expect(long.length).toBeGreaterThan(short.length);
  });

  it("list dir path respects max length", () => {
    const longPath = "/home/user/.local/share/npm/global/lib/node_modules/memmy-agent/";
    const short = hint([tc("list_dir", { path: longPath })], 40);
    const long = hint([tc("list_dir", { path: longPath })], 120);
    expect(long.length).toBeGreaterThan(short.length);
  });
});
