import { describe, expect, it } from "vitest";
import {
  assessLiteratureSourceBatch,
  isSupportedLiteratureSourceName
} from "../literature-source-files.js";

describe("literature source files", () => {
  it("only accepts PDF, DOCX, DOC, TXT, and Markdown files", () => {
    expect(["paper.PDF", "notes.docx", "draft.doc", "readme.txt", "research.md"].every(isSupportedLiteratureSourceName)).toBe(true);
    expect(["data.csv", "image.png", "paper.tex", "pdf"].some(isSupportedLiteratureSourceName)).toBe(false);
  });

  it("keeps every supported file in the selected local scope", () => {
    const files = Array.from({ length: 250 }, (_, index) => ({
      name: `paper-${index}.pdf`,
      size: 100
    }));
    const result = assessLiteratureSourceBatch(files);

    expect(result.accepted).toHaveLength(250);
    expect(result.unsupportedCount).toBe(0);
  });
});
