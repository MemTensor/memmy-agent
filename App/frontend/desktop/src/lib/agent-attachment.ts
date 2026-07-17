import { agentImageAccept, agentImageExtensionForMime, isAgentImageMime, type AgentImageMime } from "./agent-image-encode.js";

export const AGENT_ATTACHMENT_MAX_COUNT = 4;
export const AGENT_FILE_TARGET_MAX_BYTES = 10 * 1024 * 1024;

const AGENT_ATTACHMENT_UNSAFE_FILENAME_CHARS = /[<>:"\/\\|?*\x00-\x1F]/g;

export const AGENT_DOCUMENT_MIME_BY_EXTENSION = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;

export const AGENT_TEXT_MIME_BY_EXTENSION = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".log": "text/plain",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".ini": "text/plain",
  ".cfg": "text/plain",
} as const;

export type AgentFileMime =
  | typeof AGENT_DOCUMENT_MIME_BY_EXTENSION[keyof typeof AGENT_DOCUMENT_MIME_BY_EXTENSION]
  | typeof AGENT_TEXT_MIME_BY_EXTENSION[keyof typeof AGENT_TEXT_MIME_BY_EXTENSION]
  | "text/xml"
  | "text/yaml";

const AGENT_FILE_MIME_TYPES: readonly AgentFileMime[] = [
  ...new Set<AgentFileMime>([
    ...Object.values(AGENT_DOCUMENT_MIME_BY_EXTENSION),
    ...Object.values(AGENT_TEXT_MIME_BY_EXTENSION),
    "text/xml",
    "text/yaml",
  ]),
];

const AGENT_FILE_MIME_ALLOWED = new Set<string>(AGENT_FILE_MIME_TYPES);
const AGENT_FILE_EXTENSIONS = new Set([
  ...Object.keys(AGENT_DOCUMENT_MIME_BY_EXTENSION),
  ...Object.keys(AGENT_TEXT_MIME_BY_EXTENSION),
]);

export type AgentUploadMime = AgentImageMime | AgentFileMime;
export type AgentAttachmentKind = "image" | "file";

export interface AgentAttachmentClassification {
  kind: AgentAttachmentKind;
  mime: AgentUploadMime;
  extension: string;
}

export function agentAttachmentAccept(): string {
  return [
    agentImageAccept(),
    ...Object.values(AGENT_DOCUMENT_MIME_BY_EXTENSION),
    ...Object.values(AGENT_TEXT_MIME_BY_EXTENSION),
    "text/xml",
    "text/yaml",
    ...Object.keys(AGENT_DOCUMENT_MIME_BY_EXTENSION),
    ...Object.keys(AGENT_TEXT_MIME_BY_EXTENSION),
  ].join(",");
}

export function classifyAgentAttachmentFile(file: Pick<File, "name" | "type">): AgentAttachmentClassification | null {
  const declaredMime = String(file.type ?? "").toLowerCase();
  if (isAgentImageMime(declaredMime)) {
    return {
      kind: "image",
      mime: declaredMime,
      extension: agentImageExtensionForMime(declaredMime),
    };
  }

  const extension = fileExtension(file.name);
  if (!AGENT_FILE_EXTENSIONS.has(extension)) {
    return null;
  }

  const documentMime = AGENT_DOCUMENT_MIME_BY_EXTENSION[extension as keyof typeof AGENT_DOCUMENT_MIME_BY_EXTENSION];
  if (documentMime) {
    if (declaredMime && declaredMime !== documentMime) {
      return null;
    }
    return {
      kind: "file",
      mime: documentMime,
      extension,
    };
  }

  const textMime = AGENT_TEXT_MIME_BY_EXTENSION[extension as keyof typeof AGENT_TEXT_MIME_BY_EXTENSION];
  if (!textMime) {
    return null;
  }

  if (declaredMime && !AGENT_FILE_MIME_ALLOWED.has(declaredMime) && !declaredMime.startsWith("text/")) {
    return null;
  }
  return {
    kind: "file",
    mime: textMime,
    extension,
  };
}

export function safeAgentAttachmentFilename(name: string, classification: AgentAttachmentClassification): string {
  const fallback = classification.kind === "image"
    ? `image${agentImageExtensionForMime(classification.mime as AgentImageMime)}`
    : `attachment${classification.extension}`;
  const safe = safeAgentAttachmentBaseName(name, fallback);
  const ext = classification.kind === "image"
    ? agentImageExtensionForMime(classification.mime as AgentImageMime)
    : classification.extension;
  return safe.replace(/\.[^.]*$/, "") + ext;
}

function safeAgentAttachmentBaseName(name: string, fallback: string): string {
  const base = (name || fallback).split(/[\\/]/).pop()?.replace(AGENT_ATTACHMENT_UNSAFE_FILENAME_CHARS, "_").trim() || fallback;
  return base && base !== "." && base !== ".." ? base : fallback;
}

function fileExtension(name: string): string {
  const base = (name || "").split(/[\\/]/).pop() ?? "";
  const index = base.lastIndexOf(".");
  return index > 0 ? base.slice(index).toLowerCase() : "";
}
