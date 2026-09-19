export interface KnowledgeBase {
  id: string;
  name: string;
  selected: boolean;
  shared?: boolean;
  sharedByMe?: boolean;
  ownerName?: string;
  memberCount?: number;
}
export interface KnowledgeMember { userId: string; name: string; status: string; }
export interface KnowledgeSettings {
  authenticated: boolean;
  enabled: boolean;
  bases: KnowledgeBase[];
  serviceAvailable: boolean;
  maxBases?: number;
}
export interface KnowledgeFile {
  id: string;
  name: string;
  status: string;
  message: string;
  folderId?: string;
}
export interface KnowledgeFolder {
  id: string;
  /** 父目录 id，空字符串表示位于知识库根目录。 */
  parentId: string;
  name: string;
}
export interface KnowledgeFiles {
  files: KnowledgeFile[];
  total: number;
  page: number;
}
export interface KnowledgeEvidence {
  id: string;
  content: string;
  title: string;
  url?: string;
}
/** Matches MemOS knowledge-base documents: 100 MiB. */
export const MAX_UPLOAD_MB = 100;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
export const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_BYTES + 64 * 1024;
export const UPLOAD_TIMEOUT_MS = 300_000;
export const FILES_PAGE_SIZE = 20;
/** Sidebar labels stay readable; 20 CJK chars also fits bilingual titles. */
export const MAX_BASE_NAME_LENGTH = 20;
export class KnowledgeError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
  }
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
export function requiredText(value: unknown, label: string, max = 500): string {
  const result = text(value).trim();
  if (!result || result.length > max)
    throw new KnowledgeError(`${label}不能为空，且最多 ${max} 个字符`);
  return result;
}
