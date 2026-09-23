import { describe, expect, it } from "vitest";
import { cleanGeneratedTitle } from "../../../src/core/session/webui-turns.js";

describe("cleanGeneratedTitle", () => {
  it("keeps a plain title unchanged", () => {
    expect(cleanGeneratedTitle("Project scope")).toBe("Project scope");
  });

  it("strips a think block and keeps the visible title", () => {
    expect(cleanGeneratedTitle("<think>The user is asking about r…</think>Project scope")).toBe("Project scope");
  });

  it("strips a thought block before the existing prefix and quote cleaning", () => {
    expect(cleanGeneratedTitle("<thought>reasoning here</thought>Title: Q3 planning.")).toBe("Q3 planning");
  });

  it("strips a multiline think block", () => {
    expect(cleanGeneratedTitle("<think>line1\nline2\n</think>需求范围整理")).toBe("需求范围整理");
  });

  it("returns an empty title when the model only produced thinking", () => {
    expect(cleanGeneratedTitle("<think>The user is asking about r…")).toBe("");
    expect(cleanGeneratedTitle("<think>The user is asking about r…</think>")).toBe("");
  });

  it("still collapses whitespace and trims trailing punctuation after stripping", () => {
    expect(cleanGeneratedTitle("<think>x</think>  Q3   planning. ")).toBe("Q3 planning");
  });

  it("preserves backticked think mentions in prose", () => {
    expect(cleanGeneratedTitle("Fix `<think>` stripping in titles")).toBe("Fix `<think>` stripping in titles");
  });

  it("returns an empty string for empty input", () => {
    expect(cleanGeneratedTitle("")).toBe("");
    expect(cleanGeneratedTitle(null)).toBe("");
    expect(cleanGeneratedTitle(undefined)).toBe("");
  });
});
