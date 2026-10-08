export interface KnowledgeBase {
  id: string;
  name: string;
  selected: boolean;
  shared?: boolean;
  sharedByMe?: boolean;
  ownerName?: string;
  memberCount?: number;
}
export interface KnowledgeMember { userId: string; name: string; status: string; contact?: string; }
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
  /** ISO 时间；上游未返回时为空字符串。 */
  createdAt?: string;
}
export interface KnowledgeFolder {
  id: string;
  /** 父目录 id，空字符串表示位于知识库根目录。 */
  parentId: string;
  name: string;
  /** ISO 时间；上游未返回时为空字符串。 */
  createdAt?: string;
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
/** 从上游对象里取出创建时间，统一成 ISO 字符串；缺失或无法解析时返回空字符串。 */
export function createdAtText(value: Record<string, unknown>): string {
  const raw =
    value.createdAt ??
    value.created_at ??
    value.createTime ??
    value.createdTime ??
    value.gmtCreate;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  if (typeof raw !== "string" || !raw.trim()) return "";
  const parsed = Date.parse(raw.trim());
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString();
}
export function requiredText(value: unknown, label: string, max = 500): string {
  const result = text(value).trim();
  if (!result || result.length > max)
    throw new KnowledgeError(`${label}不能为空，且最多 ${max} 个字符`);
  return result;
}
