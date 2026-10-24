// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import {
  isLineOrientedDiff,
  parseWorkspaceDiff,
  WorkspaceDiffView,
  workspaceDiffSegments,
  workspaceDiffLanguage,
  workspaceDiffStats,
} from "../workspace-diff-view.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("WorkspaceDiffView", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("parses hunk line numbers and change kinds", () => {
    const lines = parseWorkspaceDiff([
      "diff --git a/src/panel.tsx b/src/panel.tsx",
      "--- a/src/panel.tsx",
      "+++ b/src/panel.tsx",
      "@@ -65,3 +65,4 @@",
      " context",
      "-old value",
      "+new value",
      "+extra value",
      "+++counter;",
      "---counter;",
    ].join("\n"));

    expect(lines).toEqual([
      { kind: "context", lineNumber: 65, content: "context" },
      { kind: "deletion", lineNumber: 66, content: "old value" },
      { kind: "addition", lineNumber: 66, content: "new value" },
      { kind: "addition", lineNumber: 67, content: "extra value" },
      { kind: "addition", lineNumber: 68, content: "++counter;" },
      { kind: "deletion", lineNumber: 67, content: "--counter;" },
    ]);
  });

  it("renders highlighted rows without raw diff prefixes", () => {
    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <WorkspaceDiffView
            path="src/panel.tsx"
            ariaLabel="src/panel.tsx 的代码改动"
            diff={"@@ -8 +8,2 @@\n const value = 1;\n+const next = 2;"}
          />
        </I18nProvider>,
      );
    });

    const additions = container.querySelectorAll('[data-kind="addition"]');
    expect(additions).toHaveLength(1);
    expect(additions[0]?.textContent).toContain("9const next = 2;");
    expect(container.textContent).toContain("7 行未修改");
    expect(container.textContent).not.toContain("+const next");
    expect(container.querySelector('[role="region"]')?.getAttribute("aria-label")).toBe("src/panel.tsx 的代码改动");
  });

  it("collapses unmodified stretches and expands them from the current file", () => {
    const diff = [
      "@@ -1,2 +1,2 @@",
      " kept",
      "-old",
      "+new",
      "@@ -8 +8 @@",
      "-gone",
      "+fresh",
    ].join("\n");
    const file = ["kept", "new", "gap-3", "gap-4", "gap-5", "gap-6", "gap-7", "fresh", "tail"].join("\n");

    expect(isLineOrientedDiff(diff)).toBe(true);
    expect(isLineOrientedDiff("Binary files a/pic.png and b/pic.png differ\n")).toBe(false);
    expect(workspaceDiffStats(diff)).toEqual({ added: 2, deleted: 2 });
    expect(workspaceDiffSegments(diff, 9).filter((segment) => segment.type === "fold")).toEqual([
      { type: "fold", id: "1:3:5", startLine: 3, count: 5 },
      { type: "fold", id: "3:9:1", startLine: 9, count: 1 },
    ]);

    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <WorkspaceDiffView path="sample.txt" ariaLabel="sample changes" diff={diff} fileText={file} />
        </I18nProvider>,
      );
    });

    expect(container.textContent).toContain("5 行未修改");
    expect(container.textContent).not.toContain("gap-3");
    const fold = container.querySelector<HTMLButtonElement>(".workspace-diff-view__fold")!;
    act(() => fold.click());
    expect(container.textContent).toContain("gap-3");
    expect(container.textContent).toContain("gap-7");
  });

  it("maps common file extensions to Prism languages", () => {
    expect(workspaceDiffLanguage("src/panel.tsx")).toBe("tsx");
    expect(workspaceDiffLanguage("scripts/release.sh")).toBe("bash");
    expect(workspaceDiffLanguage("NOTICE")).toBeNull();
  });

  it("keeps separate rows for files without a known language", () => {
    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <WorkspaceDiffView path="NOTICE" ariaLabel="NOTICE changes" diff={"+first\n+second"} />
        </I18nProvider>,
      );
    });

    expect(container.querySelectorAll('[data-kind="addition"]')).toHaveLength(2);
  });
});
