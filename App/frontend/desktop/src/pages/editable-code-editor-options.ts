export function editableCodeEditorOptions(fontFamily: string) {
  return {
    readOnly: false,
    domReadOnly: false,
    automaticLayout: true,
    scrollBeyondLastLine: true,
    wordWrap: "off" as const,
    fontSize: 14,
    fontFamily,
    minimap: { enabled: false },
    lineNumbers: "on" as const,
    folding: true,
    glyphMargin: false,
    renderLineHighlight: "line" as const,
    matchBrackets: "always" as const,
    selectionHighlight: true,
    occurrencesHighlight: "singleFile" as const,
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true as const, indentation: true },
    stickyScroll: { enabled: false },
    tabSize: 4,
    insertSpaces: true,
    detectIndentation: true,
    contextmenu: true,
    links: true,
    colorDecorators: true,
    fixedOverflowWidgets: true,
    unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: true },
    scrollbar: {
      vertical: "auto" as const,
      horizontal: "auto" as const,
      verticalScrollbarSize: 8,
      horizontalScrollbarSize: 8,
    },
    padding: { top: 8, bottom: 8 },
  };
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bash: "shell",
  c: "c",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  go: "go",
  h: "cpp",
  htm: "html",
  html: "html",
  java: "java",
  js: "javascript",
  jsx: "javascript",
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
  sh: "shell",
  sql: "sql",
  svg: "xml",
  swift: "swift",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  vue: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shell",
};

export function monacoLanguageId(path: string): string {
  const fileName = path.split(/[?#]/u, 1)[0]?.split(/[/\\]/u).pop() ?? "";
  const extension = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() ?? "" : "";
  return LANGUAGE_BY_EXTENSION[extension] ?? "plaintext";
}

export function canEditWorkspacePreview(path: string, workspaceRoot: string | null | undefined): boolean {
  if (!workspaceRoot || !isAbsoluteClientPath(workspaceRoot) || !isAbsoluteClientPath(path)) return false;
  return typeof window !== "undefined" && typeof window.memmy?.writeWorkspaceFile === "function";
}

function isAbsoluteClientPath(value: string): boolean {
  return value.startsWith("/") || /^[a-z]:[\\/]/iu.test(value);
}
