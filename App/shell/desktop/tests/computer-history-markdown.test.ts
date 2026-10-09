import path from "node:path";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { resolveComputerHistoryMarkdownPath } from "../src/main/computer-history-markdown.js";

describe("Computer History Markdown path", () => {
  const home = path.resolve("/Users/tester");
  const memmyHome = path.join(home, ".memmy-test");
  const histories = path.join(memmyHome, "computer-history", "histories");

  it("accepts a direct Markdown file in the configured history directory", () => {
    const file = path.join(histories, "2026-09-14T00-00-00Z-6h-summary.md");
    expect(resolveComputerHistoryMarkdownPath(file, { MEMMY_HOME: memmyHome }, home)).toBe(file);
  });

  it("expands a home-relative Memmy directory", () => {
    const file = path.join(histories, "entry.md");
    expect(resolveComputerHistoryMarkdownPath(file, { MEMMY_HOME: "~/.memmy-test" }, home)).toBe(file);
  });

  it.each([
    "/tmp/outside.md",
    path.join(histories, "nested", "entry.md"),
    path.join(histories, "entry.txt"),
    `${path.join(histories, "entry.md")}\n/tmp/other.md`,
    "",
  ])("rejects a path outside the flat Markdown summary store: %s", (file) => {
    expect(() => resolveComputerHistoryMarkdownPath(file, { MEMMY_HOME: memmyHome }, home)).toThrow();
  });
});


describe("Computer History Finder action", () => {
  const source = readFileSync(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "openComputerHistoryMarkdown");
  if (!declaration) throw new Error("Missing Computer History Markdown handler");
  const compiled = ts.transpileModule(`${declaration.getText(ast)}; return openComputerHistoryMarkdown;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;

  function setup() {
    const shell = { showItemInFolder: vi.fn(), openPath: vi.fn() };
    const lstat = vi.fn().mockResolvedValue({ isFile: () => true });
    const resolvePath = (value: unknown) => resolveComputerHistoryMarkdownPath(value, { MEMMY_HOME: "/tmp/history-reveal-test" });
    const reveal = Function("shell", "lstat", "resolveComputerHistoryMarkdownPath", compiled)(shell, lstat, resolvePath);
    return { shell, lstat, reveal };
  }

  it("selects the summary file in Finder without launching its Markdown editor", async () => {
    const { shell, reveal } = setup();
    const file = "/tmp/history-reveal-test/computer-history/histories/summary.md";
    await reveal(file);
    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(file);
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it("rejects outside paths, directories, symlinks and missing files before revealing", async () => {
    const { shell, lstat, reveal } = setup();
    const file = "/tmp/history-reveal-test/computer-history/histories/summary.md";
    await expect(reveal("/tmp/outside.md")).rejects.toThrow(/outside/);
    expect(lstat).not.toHaveBeenCalled();
    lstat.mockResolvedValue({ isFile: () => false });
    await expect(reveal(file)).rejects.toThrow(/not a regular file/);
    lstat.mockRejectedValue(new Error("ENOENT"));
    await expect(reveal(file)).rejects.toThrow("ENOENT");
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });
});
