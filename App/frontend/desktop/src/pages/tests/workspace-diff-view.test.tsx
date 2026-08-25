// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseWorkspaceDiff, WorkspaceDiffView, workspaceDiffLanguage } from "../workspace-diff-view.js";

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
        <WorkspaceDiffView
          path="src/panel.tsx"
          ariaLabel="src/panel.tsx 的代码改动"
          diff={"@@ -8 +8,2 @@\n const value = 1;\n+const next = 2;"}
        />
      );
    });

    const additions = container.querySelectorAll('[data-kind="addition"]');
    expect(additions).toHaveLength(1);
    expect(additions[0]?.textContent).toContain("9const next = 2;");
    expect(container.textContent).not.toContain("+const next");
    expect(container.querySelector('[role="region"]')?.getAttribute("aria-label")).toBe("src/panel.tsx 的代码改动");
  });

  it("maps common file extensions to Prism languages", () => {
    expect(workspaceDiffLanguage("src/panel.tsx")).toBe("tsx");
    expect(workspaceDiffLanguage("scripts/release.sh")).toBe("bash");
    expect(workspaceDiffLanguage("NOTICE")).toBeNull();
  });

  it("keeps separate rows for files without a known language", () => {
    act(() => {
      root.render(<WorkspaceDiffView path="NOTICE" ariaLabel="NOTICE changes" diff={"+first\n+second"} />);
    });

    expect(container.querySelectorAll('[data-kind="addition"]')).toHaveLength(2);
  });
});
