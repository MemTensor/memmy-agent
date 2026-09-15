import { agentImageAccept, agentImageExtensionForMime, isAgentImageMime, type AgentImageMime } from "./agent-image-encode.js";

export const AGENT_ATTACHMENT_MAX_COUNT = 4;
export const AGENT_FILE_TARGET_MAX_BYTES = 10 * 1024 * 1024;
/** Recordings run far past the document limit, so audio carries its own ceiling. */
export const AGENT_AUDIO_TARGET_MAX_BYTES = 200 * 1024 * 1024;

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

export const AGENT_AUDIO_MIME_BY_EXTENSION = {
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
} as const;

export type AgentFileMime =
  | typeof AGENT_DOCUMENT_MIME_BY_EXTENSION[keyof typeof AGENT_DOCUMENT_MIME_BY_EXTENSION]
  | typeof AGENT_TEXT_MIME_BY_EXTENSION[keyof typeof AGENT_TEXT_MIME_BY_EXTENSION]
  | "text/xml"
  | "text/yaml";

export type AgentAudioMime = typeof AGENT_AUDIO_MIME_BY_EXTENSION[keyof typeof AGENT_AUDIO_MIME_BY_EXTENSION];

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

export type AgentUploadMime = AgentImageMime | AgentFileMime | AgentAudioMime;
export type AgentAttachmentKind = "image" | "file" | "audio";

export interface AgentAttachmentClassification {
  kind: AgentAttachmentKind;
  mime: AgentUploadMime;
  extension: string;
}

export interface ClassifyAgentAttachmentOptions {
  /**
   * Accepts audio files. Off by default: the chat composer hands attachments to
   * the model as documents, where a recording is useless. Surfaces that route
   * audio somewhere that understands it — the plugin file-input card feeding the
   * `asr` host service — opt in.
   */
  allowAudio?: boolean;
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

export function classifyAgentAttachmentFile(
  file: Pick<File, "name" | "type">,
  options: ClassifyAgentAttachmentOptions = {},
): AgentAttachmentClassification | null {
  const declaredMime = String(file.type ?? "").toLowerCase();
  if (isAgentImageMime(declaredMime)) {
    return {
      kind: "image",
      mime: declaredMime,
      extension: agentImageExtensionForMime(declaredMime),
    };
  }

  const extension = fileExtension(file.name);

  const audioMime = AGENT_AUDIO_MIME_BY_EXTENSION[extension as keyof typeof AGENT_AUDIO_MIME_BY_EXTENSION];
  if (audioMime) {
    // Browsers label the same recording audio/mp4, audio/x-m4a or nothing at
    // all depending on the platform, so the extension decides and the declared
    // type only has to not contradict it. The Host verifies the container
    // signature before storing the upload.
    const contradicts = declaredMime !== "" && !declaredMime.startsWith("audio/") && declaredMime !== "application/octet-stream";
    if (!options.allowAudio || contradicts) {
      return null;
    }
    return {
      kind: "audio",
      mime: audioMime,
      extension,
    };
  }

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
