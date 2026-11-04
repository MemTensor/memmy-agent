import { describe, expect, it } from "vitest";
import { toWorkspaceRelativePath } from "../workspace-relative-path.js";

describe("toWorkspaceRelativePath", () => {
  it("maps absolute workspace files to relative paths", () => {
    expect(toWorkspaceRelativePath(
      "/Users/yuan/project/outputs/review.pdf",
      "/Users/yuan/project"
    )).toBe("outputs/review.pdf");
  });

  it("accepts already-relative paths", () => {
    expect(toWorkspaceRelativePath("outputs/review.pdf", "/Users/yuan/project")).toBe("outputs/review.pdf");
    expect(toWorkspaceRelativePath("./notes/README.md", null)).toBe("notes/README.md");
  });

  it("rejects paths outside the workspace", () => {
    expect(toWorkspaceRelativePath(
      "/Users/yuan/other/review.pdf",
      "/Users/yuan/project"
    )).toBeNull();
  });

  it("handles file URLs and Windows roots", () => {
    expect(toWorkspaceRelativePath(
      "file:///Users/yuan/project/review.tex",
      "/Users/yuan/project"
    )).toBe("review.tex");
    expect(toWorkspaceRelativePath(
      "C:\\Users\\yuan\\project\\review.docx",
      "C:\\Users\\yuan\\project"
    )).toBe("review.docx");
  });
});
