// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  highlightPdfTextLayer,
  nextPdfMatchIndex
} from "../file-preview/pdf-preview-state.js";

describe("PDF preview navigation", () => {
  it("wraps search results in both directions", () => {
    expect(nextPdfMatchIndex(0, 1, 3)).toBe(1);
    expect(nextPdfMatchIndex(2, 1, 3)).toBe(0);
    expect(nextPdfMatchIndex(0, -1, 3)).toBe(2);
    expect(nextPdfMatchIndex(-1, 1, 0)).toBe(-1);
  });

  it("highlights exact PDF text matches and distinguishes the active occurrence", () => {
    const layer = document.createElement("div");
    layer.innerHTML = "<span>Alpha beta alpha</span><span>alphabet</span>";

    const active = highlightPdfTextLayer(layer, "alpha", 1);
    const marks = [...layer.querySelectorAll("mark")];

    expect(marks.map((mark) => mark.textContent)).toEqual(["Alpha", "alpha", "alpha"]);
    expect(active).toBe(marks[1]);
    expect(marks[0]?.classList.contains("pdf-preview__search-hit--active")).toBe(false);
    expect(marks[1]?.classList.contains("pdf-preview__search-hit--active")).toBe(true);
    expect(layer.textContent).toBe("Alpha beta alphaalphabet");
  });

  it("scrolls only the PDF pages container when navigating search results", () => {
    const source = readFileSync(resolve(process.cwd(), "src/pages/file-preview/pdf-preview.tsx"), "utf8");
    expect(source).toContain("container.scrollTop +=");
    expect(source).not.toContain("scrollIntoView");
  });
});
