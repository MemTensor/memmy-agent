import path from "node:path";
import { describe, expect, it } from "vitest";
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
