import { memo, useEffect, useMemo, useState } from "react";
import { Prism as SyntaxHighlighter, createElement, type SyntaxHighlighterProps } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useTranslation } from "../i18n/use-translation.js";

export type WorkspaceDiffLineKind = "context" | "addition" | "deletion" | "notice";

export type WorkspaceDiffLine = {
  kind: WorkspaceDiffLineKind;
  lineNumber: number | null;
  content: string;
};

export type WorkspaceDiffSegment =
  | { type: "lines"; lines: WorkspaceDiffLine[] }
  | { type: "fold"; id: string; startLine: number; count: number };

type WorkspaceDiffViewProps = {
  diff: string;
  path: string;
  ariaLabel: string;
  fileText?: string | null;
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
    c: "c",
    cjs: "javascript",
    cpp: "cpp",
    cs: "csharp",
    css: "css",
    go: "go",
    htm: "markup",
    html: "markup",
    java: "java",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    kt: "kotlin",
    less: "less",
    md: "markdown",
    mjs: "javascript",
    php: "php",
    py: "python",
    rb: "ruby",
    rs: "rust",
    scss: "scss",
    sh: "bash",
    sql: "sql",
    svg: "markup",
    swift: "swift",
    toml: "toml",
    ts: "typescript",
    tsx: "tsx",
    vue: "markup",
    xml: "markup",
    yaml: "yaml",
    yml: "yaml",
    zsh: "bash",
  }[extension] ?? null;
}

export function workspaceSourceLines(text: string, kind: "context" | "addition" = "context"): WorkspaceDiffLine[] {
  const rows = text.replace(/\r\n?/g, "\n").split("\n");
  if (rows.length > 1 && rows.at(-1) === "") rows.pop();
  return rows.map((content, index) => ({ kind, lineNumber: index + 1, content }));
}

export function workspaceFileLineCount(text: string): number {
  return workspaceSourceLines(text).length;
}

export function isLineOrientedDiff(diff: string): boolean {
  return /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(diff);
}

export function workspaceDiffStats(diff: string): { added: number; deleted: number } {
  return parseWorkspaceDiff(diff).reduce(
    (stats, line) => ({
      added: stats.added + (line.kind === "addition" ? 1 : 0),
      deleted: stats.deleted + (line.kind === "deletion" ? 1 : 0),
    }),
    { added: 0, deleted: 0 },
  );
}

export function workspaceDiffSegments(diff: string, fileLineCount: number | null = null): WorkspaceDiffSegment[] {
  const segments: WorkspaceDiffSegment[] = [];
  let lines: WorkspaceDiffLine[] = [];
  let pendingDeletions: WorkspaceDiffLine[] = [];
  let lastNewLine = 0;

  const flushLines = () => {
    if (!lines.length) return;
    segments.push({ type: "lines", lines });
    lines = [];
  };
  const fold = (startLine: number, count: number) => {
    if (count <= 0) return;
    flushLines();
    segments.push({ type: "fold", id: `${segments.length}:${startLine}:${count}`, startLine, count });
  };
  const takeDeletions = () => {
    if (!pendingDeletions.length) return;
    lines.push(...pendingDeletions);
    pendingDeletions = [];
  };

  for (const line of parseWorkspaceDiff(diff)) {
    if (line.kind === "deletion") {
      pendingDeletions.push(line);
      continue;
    }
    if (line.kind === "addition" || line.kind === "context") {
      const lineNumber = line.lineNumber ?? lastNewLine + 1;
      if (lineNumber > lastNewLine + 1) {
        fold(lastNewLine + 1, lineNumber - lastNewLine - 1);
      }
      takeDeletions();
      lines.push({ ...line, lineNumber });
      lastNewLine = lineNumber;
      continue;
    }
    takeDeletions();
    lines.push(line);
  }
  takeDeletions();
  flushLines();
  if (fileLineCount != null && fileLineCount > lastNewLine) {
    fold(lastNewLine + 1, fileLineCount - lastNewLine);
  }
  return segments;
}

function fileLines(text: string, startLine: number, count: number): WorkspaceDiffLine[] {
  return workspaceSourceLines(text).slice(startLine - 1, startLine - 1 + count).map((line, index) => ({
    ...line,
    kind: "context",
    lineNumber: startLine + index,
  }));
}

export const WorkspaceDiffView = memo(function WorkspaceDiffView({ diff, path, ariaLabel, fileText = null }: WorkspaceDiffViewProps) {
  const { t } = useTranslation();
  const fileLineCount = fileText == null ? null : workspaceFileLineCount(fileText);
  const segments = useMemo(() => workspaceDiffSegments(diff, fileLineCount), [diff, fileLineCount]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    setExpanded(new Set());
  }, [diff, fileText]);

  return (
    <div className="workspace-diff-view" role="region" aria-label={ariaLabel}>
      {segments.map((segment, index) => {
        if (segment.type === "lines") {
          return <WorkspaceLinesView key={`lines-${index}`} lines={segment.lines} path={path} embedded />;
        }
        const expandedLines = expanded.has(segment.id) && fileText != null
          ? fileLines(fileText, segment.startLine, segment.count)
          : [];
        const canExpand = fileText != null && workspaceFileLineCount(fileText) >= segment.startLine;
        const label = t(segment.count === 1 ? "home.threadPanel.diff.unmodified.one" : "home.threadPanel.diff.unmodified", { count: segment.count });
        return (
          <div key={segment.id}>
            <button
              type="button"
              className="workspace-diff-view__fold"
              aria-expanded={expanded.has(segment.id)}
              disabled={!canExpand}
              onClick={() => {
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(segment.id)) next.delete(segment.id);
                  else next.add(segment.id);
                  return next;
                });
              }}
            >
              {label}
            </button>
            {expandedLines.length ? <WorkspaceLinesView lines={expandedLines} path={path} embedded /> : null}
          </div>
        );
      })}
    </div>
  );
});

export const WorkspaceSourceView = memo(function WorkspaceSourceView(props: {
  text: string;
  path: string;
  ariaLabel: string;
  kind?: "context" | "addition";
}) {
  const lines = useMemo(() => workspaceSourceLines(props.text, props.kind), [props.kind, props.text]);
  return <WorkspaceLinesView lines={lines} path={props.path} ariaLabel={props.ariaLabel} />;
});

function WorkspaceLinesView({ lines, path, ariaLabel, embedded = false }: { lines: WorkspaceDiffLine[]; path: string; ariaLabel?: string; embedded?: boolean }) {
  const language = useMemo(() => workspaceDiffLanguage(path), [path]);
  const source = useMemo(() => lines.map((line) => line.content).join("\n"), [lines]);
  const highlightLanguage = source.length <= MAX_HIGHLIGHT_CHARACTERS ? language : null;

  return (
    <div className={embedded ? "workspace-diff-view__hunk" : "workspace-diff-view"} role={embedded ? undefined : "region"} aria-label={embedded ? undefined : ariaLabel}>
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
}

function isDiffHeader(line: string): boolean {
  return line.startsWith("index ")
    || line.startsWith("--- ")
    || line.startsWith("+++ ");
}
