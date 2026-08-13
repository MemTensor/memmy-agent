/** Shared file display classification used across desktop surfaces. */

export type FileDisplayKind =
  | "pdf"
  | "word"
  | "spreadsheet"
  | "presentation"
  | "markdown"
  | "text"
  | "code"
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "generic";

export interface ResolvedFileType {
  kind: FileDisplayKind;
  label: string;
  shortLabel: string;
  extension: string;
}

const FILE_KIND_BY_EXTENSION: Readonly<Record<string, FileDisplayKind>> = {
  ".pdf": "pdf",
  ".doc": "word",
  ".docx": "word",
  ".odt": "word",
  ".rtf": "word",
  ".xls": "spreadsheet",
  ".xlsx": "spreadsheet",
  ".ods": "spreadsheet",
  ".csv": "spreadsheet",
  ".ppt": "presentation",
  ".pptx": "presentation",
  ".odp": "presentation",
  ".key": "presentation",
  ".md": "markdown",
  ".mdx": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".log": "text",
  ".tex": "text",
  ".json": "code",
  ".jsonl": "code",
  ".xml": "code",
  ".html": "code",
  ".htm": "code",
  ".css": "code",
  ".scss": "code",
  ".less": "code",
  ".js": "code",
  ".jsx": "code",
  ".ts": "code",
  ".tsx": "code",
  ".py": "code",
  ".java": "code",
  ".go": "code",
  ".rs": "code",
  ".sh": "code",
  ".sql": "code",
  ".yaml": "code",
  ".yml": "code",
  ".toml": "code",
  ".ini": "code",
  ".cfg": "code",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".svg": "image",
  ".bmp": "image",
  ".heic": "image",
  ".mp4": "video",
  ".webm": "video",
  ".mov": "video",
  ".m4v": "video",
  ".avi": "video",
  ".mkv": "video",
  ".mp3": "audio",
  ".wav": "audio",
  ".m4a": "audio",
  ".aac": "audio",
  ".flac": "audio",
  ".ogg": "audio",
  ".zip": "archive",
  ".rar": "archive",
  ".7z": "archive",
  ".tar": "archive",
  ".gz": "archive",
  ".tgz": "archive"
};

const FILE_KIND_META: Readonly<Record<FileDisplayKind, Omit<ResolvedFileType, "extension">>> = {
  pdf: { kind: "pdf", label: "PDF document", shortLabel: "PDF" },
  word: { kind: "word", label: "Word document", shortLabel: "DOC" },
  spreadsheet: { kind: "spreadsheet", label: "Spreadsheet", shortLabel: "XLS" },
  presentation: { kind: "presentation", label: "Presentation", shortLabel: "PPT" },
  markdown: { kind: "markdown", label: "Markdown document", shortLabel: "MD" },
  text: { kind: "text", label: "Text document", shortLabel: "TXT" },
  code: { kind: "code", label: "Code or configuration file", shortLabel: "CODE" },
  image: { kind: "image", label: "Image file", shortLabel: "IMG" },
  video: { kind: "video", label: "Video file", shortLabel: "VIDEO" },
  audio: { kind: "audio", label: "Audio file", shortLabel: "AUDIO" },
  archive: { kind: "archive", label: "Archive", shortLabel: "ZIP" },
  generic: { kind: "generic", label: "File", shortLabel: "FILE" }
};

const EXACT_EXTENSION_LABEL_KINDS = new Set<FileDisplayKind>([
  "markdown",
  "text",
  "code",
  "image",
  "video",
  "audio",
  "archive"
]);

/** Resolve a display type without changing whether the file is uploadable. */
export function resolveFileType(name: string, mime?: string): ResolvedFileType {
  const extension = fileExtension(name);
  const kind = fileKindFromMime(mime) ?? FILE_KIND_BY_EXTENSION[extension] ?? "generic";
  return {
    ...FILE_KIND_META[kind],
    shortLabel: shortLabelForFile(kind, extension),
    extension
  };
}

export function fileExtension(name: string): string {
  const clean = String(name ?? "").split(/[?#]/, 1)[0] ?? "";
  const base = clean.split(/[\\/]/).pop() ?? "";
  const index = base.lastIndexOf(".");
  return index > 0 && index < base.length - 1 ? base.slice(index).toLowerCase() : "";
}

function fileKindFromMime(mime?: string): FileDisplayKind | null {
  const normalized = String(mime ?? "").toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (!normalized) return null;
  if (normalized === "application/pdf") return "pdf";
  if (normalized.includes("wordprocessingml") || normalized === "application/msword") return "word";
  if (
    normalized.includes("spreadsheetml")
    || normalized.includes("ms-excel")
    || normalized === "text/csv"
  ) return "spreadsheet";
  if (normalized.includes("presentationml") || normalized.includes("ms-powerpoint")) return "presentation";
  if (normalized.includes("markdown")) return "markdown";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("audio/")) return "audio";
  if (
    normalized.includes("zip")
    || normalized.includes("rar")
    || normalized.includes("7z")
    || normalized.includes("tar")
    || normalized.includes("gzip")
  ) return "archive";
  if (
    normalized.includes("json")
    || normalized.includes("xml")
    || normalized.includes("yaml")
    || normalized.includes("toml")
    || normalized === "text/html"
    || normalized === "text/css"
    || normalized === "application/javascript"
  ) return "code";
  if (normalized.startsWith("text/")) return "text";
  return null;
}

function shortLabelForFile(kind: FileDisplayKind, extension: string): string {
  const extensionLabel = extension.replace(/^\./, "").toUpperCase();
  if (kind === "spreadsheet" && extension === ".csv") return "CSV";
  if (kind === "presentation" && extension === ".key") return "KEY";
  if (EXACT_EXTENSION_LABEL_KINDS.has(kind) && extensionLabel && extensionLabel.length <= 5) {
    return extensionLabel;
  }
  return FILE_KIND_META[kind].shortLabel;
}
