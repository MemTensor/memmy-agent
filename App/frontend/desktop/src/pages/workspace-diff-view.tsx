import { memo, useMemo } from "react";
import { Prism as SyntaxHighlighter, createElement, type SyntaxHighlighterProps } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";

export type WorkspaceDiffLineKind = "context" | "addition" | "deletion" | "notice";

export type WorkspaceDiffLine = {
  kind: WorkspaceDiffLineKind;
  lineNumber: number | null;
  content: string;
};

type WorkspaceDiffViewProps = {
  diff: string;
  path: string;
  ariaLabel: string;
};

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const MAX_HIGHLIGHT_CHARACTERS = 100_000;
const CODE_SELECTOR = 'code[class*="language-"]' as const;
const PRE_SELECTOR = 'pre[class*="language-"]' as const;
const DIFF_CODE_THEME = {
  ...oneLight,
  [CODE_SELECTOR]: { ...oneLight[CODE_SELECTOR], background: "transparent" },
  [PRE_SELECTOR]: { ...oneLight[PRE_SELECTOR], background: "transparent" },
} satisfies NonNullable<SyntaxHighlighterProps["style"]>;

export function parseWorkspaceDiff(diff: string): WorkspaceDiffLine[] {
  const parsed: WorkspaceDiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  let insideHunk = false;

  for (const rawLine of diff.split(/\r?\n/)) {
    if (rawLine.startsWith("diff --git ")) {
      insideHunk = false;
      continue;
    }
    const hunk = HUNK_HEADER.exec(rawLine);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      insideHunk = true;
      continue;
    }
    if (!insideHunk && isDiffHeader(rawLine)) continue;
    if (rawLine.startsWith("\\ No newline at end of file")) continue;

    if (rawLine.startsWith("+")) {
      parsed.push({ kind: "addition", lineNumber: newLine, content: rawLine.slice(1) });
      newLine += 1;
      continue;
    }
    if (rawLine.startsWith("-")) {
      parsed.push({ kind: "deletion", lineNumber: oldLine, content: rawLine.slice(1) });
      oldLine += 1;
      continue;
    }
    if (insideHunk && rawLine.startsWith(" ")) {
      parsed.push({ kind: "context", lineNumber: newLine, content: rawLine.slice(1) });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    if (insideHunk && rawLine === "") continue;
    if (rawLine) parsed.push({ kind: "notice", lineNumber: null, content: rawLine });
  }

  return parsed;
}

export function workspaceDiffLanguage(path: string): string | null {
  const extension = path.split(".").pop()?.toLocaleLowerCase() ?? "";
  return {
    bash: "bash",
    css: "css",
    go: "go",
    html: "markup",
    java: "java",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    kt: "kotlin",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    rs: "rust",
    scss: "scss",
    sh: "bash",
    sql: "sql",
    ts: "typescript",
    tsx: "tsx",
    xml: "markup",
    yaml: "yaml",
    yml: "yaml",
  }[extension] ?? null;
}

export const WorkspaceDiffView = memo(function WorkspaceDiffView({ diff, path, ariaLabel }: WorkspaceDiffViewProps) {
  const lines = useMemo(() => parseWorkspaceDiff(diff), [diff]);
  const language = useMemo(() => workspaceDiffLanguage(path), [path]);
  const source = useMemo(() => lines.map((line) => line.content).join("\n"), [lines]);
  const highlightLanguage = source.length <= MAX_HIGHLIGHT_CHARACTERS ? language : null;

  return (
    <div className="workspace-diff-view" role="region" aria-label={ariaLabel}>
      <SyntaxHighlighter
        language={highlightLanguage ?? undefined}
        style={DIFF_CODE_THEME}
        customStyle={{ margin: 0, padding: 0, background: "transparent", minWidth: "max-content" }}
        PreTag="div"
        CodeTag="div"
        renderer={({ rows, stylesheet, useInlineStyles }) => lines.map((line, index) => (
          <div
            key={`${line.kind}-${line.lineNumber ?? "notice"}-${index}`}
            className={`workspace-diff-view__line workspace-diff-view__line--${line.kind}`}
            data-kind={line.kind}
          >
            <span className="workspace-diff-view__line-number" aria-hidden="true">
              {line.lineNumber ?? ""}
            </span>
            <span className="workspace-diff-view__code">
              {line.kind !== "notice" && rows[index]
                ? createElement({
                  node: rows[index],
                  stylesheet,
                  useInlineStyles,
                  key: index,
                })
                : line.content || " "}
            </span>
          </div>
        ))}
      >
        {source}
      </SyntaxHighlighter>
    </div>
  );
});

function isDiffHeader(line: string): boolean {
  return line.startsWith("index ")
    || line.startsWith("--- ")
    || line.startsWith("+++ ");
}
