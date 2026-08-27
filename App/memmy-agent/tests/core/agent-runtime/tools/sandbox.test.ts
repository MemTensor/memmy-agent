import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMediaDir } from "../../../../src/config/paths.js";
import { wrapCommand } from "../../../../src/core/agent-runtime/tools/sandbox.js";

function splitShell(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bwrap sandbox backend", () => {
  it("builds the basic structure", () => {
    const ws = path.join(process.cwd(), "project");
    const tokens = splitShell(wrapCommand("bwrap", "echo hi", ws, ws));

    expect(tokens[0]).toBe("bwrap");
    expect(tokens).toContain("--new-session");
    expect(tokens).toContain("--die-with-parent");
    expect(tokens).toContain("--ro-bind");
    expect(tokens).toContain("--proc");
    expect(tokens).toContain("--dev");
    expect(tokens).toContain("--tmpfs");
    const sep = tokens.indexOf("--");
    expect(tokens.slice(sep + 1)).toEqual(["sh", "-c", "echo hi"]);
  });

  it("mounts the workspace read-write", () => {
    const ws = path.join(process.cwd(), "project");
    const tokens = splitShell(wrapCommand("bwrap", "ls", ws, ws));
    const bindIndices = tokens.flatMap((token, index) => (token === "--bind" ? [index] : []));

    expect(bindIndices.some((index) => tokens[index + 1] === ws && tokens[index + 2] === ws)).toBe(true);
  });

  it("masks the parent directory with tmpfs", () => {
    const ws = path.join(process.cwd(), "project");
    const tokens = splitShell(wrapCommand("bwrap", "ls", ws, ws));
    const tmpfsTargets = new Set(tokens.flatMap((token, index) => (token === "--tmpfs" ? [tokens[index + 1]] : [])));

    expect(tmpfsTargets.has(path.dirname(ws))).toBe(true);
  });

  it("keeps cwd inside the workspace", () => {
    const ws = path.join(process.cwd(), "project");
    const sub = path.join(ws, "src", "lib");
    const tokens = splitShell(wrapCommand("bwrap", "pwd", ws, sub));

    expect(tokens[tokens.indexOf("--chdir") + 1]).toBe(sub);
  });

  it("falls back to workspace when cwd is outside", () => {
    const ws = path.join(process.cwd(), "project");
    const outside = path.join(process.cwd(), "other");
    const tokens = splitShell(wrapCommand("bwrap", "pwd", ws, outside));

    expect(tokens[tokens.indexOf("--chdir") + 1]).toBe(ws);
  });

  it("preserves command special characters", () => {
    const ws = path.join(process.cwd(), "project");
    const command = "echo 'hello world' && cat \"file with spaces.txt\"";
    const tokens = splitShell(wrapCommand("bwrap", command, ws, ws));
    const sep = tokens.indexOf("--");

    expect(tokens.slice(sep + 1)).toEqual(["sh", "-c", command]);
  });

  it("binds system directories read-only", () => {
    const ws = path.join(process.cwd(), "project");
    const tokens = splitShell(wrapCommand("bwrap", "ls", ws, ws));
    const roTargets = new Set(tokens.flatMap((token, index) => (token === "--ro-bind" ? [tokens[index + 1]] : [])));

    expect(roTargets.has("/usr")).toBe(true);
  });

  it("uses ro-bind-try for optional directories", () => {
    const ws = path.join(process.cwd(), "project");
    const tokens = splitShell(wrapCommand("bwrap", "ls", ws, ws));
    const targets = new Set(tokens.flatMap((token, index) => (token === "--ro-bind-try" ? [tokens[index + 1]] : [])));

    expect(targets.has("/bin")).toBe(true);
    expect(targets.has("/etc/ssl/certs")).toBe(true);
  });

  it("mounts the media directory read-only", () => {
    const ws = path.join(process.cwd(), "project");
    const tokens = splitShell(wrapCommand("bwrap", "ls", ws, ws));
    const media = path.resolve(getMediaDir());
    const pairs = tokens.flatMap((token, index) => (token === "--ro-bind-try" ? [[tokens[index + 1], tokens[index + 2]]] : []));

    expect(pairs).toContainEqual([media, media]);
  });
});

describe("unknown sandbox backend", () => {
  it("raises for an unknown backend", () => {
    expect(() => wrapCommand("nonexistent", "ls", process.cwd(), process.cwd())).toThrow(/Unknown sandbox backend/);
  });

  it("raises for an empty backend", () => {
    expect(() => wrapCommand("", "ls", process.cwd(), process.cwd())).toThrow();
  });
});
