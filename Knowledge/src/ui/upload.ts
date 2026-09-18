import { MAX_UPLOAD_BYTES } from "../types.js";

export const DOCUMENT_EXTENSIONS =
  ".pdf,.docx,.doc,.txt,.json,.md,.xml";
export type UploadFailureReason = "format" | "size" | "other";
export interface UploadResult {
  name: string;
  ok: boolean;
  error?: string;
  reason?: UploadFailureReason;
}
export interface UploadBatch {
  results: UploadResult[];
  stopped: boolean;
}
export interface UploadSummary {
  succeeded: number;
  failed: number;
  format: number;
  size: number;
  other: number;
  stopped: boolean;
}

const JUNK_FILE =
  /(?:^|\/)(?:\.DS_Store|Thumbs\.db|desktop\.ini|\._[^/]+)$/i;
const JUNK_DIR = /(?:^|\/)(?:__MACOSX|\.git|\.svn)(?:\/|$)/i;

export function fileRelativePath(file: File): string {
  const relative =
    "webkitRelativePath" in file &&
    typeof file.webkitRelativePath === "string"
      ? file.webkitRelativePath
      : "";
  return relative.replaceAll("\\", "/").replace(/^\/+/, "") || file.name;
}

export function isJunkUpload(path: string): boolean {
  return JUNK_FILE.test(path) || JUNK_DIR.test(path);
}

export function folderSegments(relativePath: string): string[] {
  return relativePath
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .slice(0, -1);
}

export function summarizeUploads(
  results: readonly UploadResult[],
  stopped = false,
): UploadSummary {
  return {
    succeeded: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    format: results.filter((result) => result.reason === "format").length,
    size: results.filter((result) => result.reason === "size").length,
    other: results.filter((result) => result.reason === "other").length,
    stopped,
  };
}

export async function resolveFolderId(
  segments: readonly string[],
  rootId: string,
  lookup: (parentId: string, name: string) => string | undefined,
  create: (parentId: string, name: string) => Promise<string>,
): Promise<string> {
  let parentId = rootId;
  for (const name of segments) {
    const existing = lookup(parentId, name);
    if (existing) {
      parentId = existing;
      continue;
    }
    parentId = await create(parentId, name);
  }
  return parentId;
}

export async function filesFromDrop(event: {
  dataTransfer: DataTransfer | null;
}): Promise<File[]> {
  const items = [...(event.dataTransfer?.items ?? [])];
  const fallback = [...(event.dataTransfer?.files ?? [])];
  const collected: File[] = [];
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) await collectEntry(entry, "", collected);
  }
  return collected.length ? collected : fallback;
}

async function collectEntry(
  entry: FileSystemEntry,
  prefix: string,
  collected: File[],
): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    const relative = `${prefix}${file.name}`;
    try {
      Object.defineProperty(file, "webkitRelativePath", { value: relative });
    } catch {
      // Some runtimes expose a read-only path; the file name is still usable.
    }
    collected.push(file);
    return;
  }
  if (!entry.isDirectory) return;
  const next = `${prefix}${entry.name}/`;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (!batch.length) break;
    for (const child of batch) await collectEntry(child, next, collected);
  }
}

/** Process one file at a time so a batch keeps the same per-file request/memory limit. */
export async function uploadDocuments(
  files: readonly File[],
  upload: (
    file: File,
    content: string,
    signal?: AbortSignal,
  ) => Promise<unknown>,
  onProgress: (completed: number, total: number, name: string) => void,
  zh = true,
  signal?: AbortSignal,
  onSettled?: (result: UploadResult) => void,
): Promise<UploadBatch> {
  const results: UploadResult[] = [];
  for (const file of files) {
    if (signal?.aborted) return { results, stopped: true };
    onProgress(results.length, files.length, file.name);
    try {
      if (!file.size)
        throw Object.assign(
          new Error(zh ? "文件为空或超过 20 MB" : "File is empty or exceeds 20 MB"),
          { reason: "size" as const },
        );
      if (file.size > MAX_UPLOAD_BYTES)
        throw Object.assign(
          new Error(zh ? "文件为空或超过 20 MB" : "File is empty or exceeds 20 MB"),
          { reason: "size" as const },
        );
      if (!/\.(pdf|docx|doc|txt|json|md|xml)$/i.test(file.name))
        throw Object.assign(
          new Error(
            zh
              ? "不支持的文档格式（支持 PDF、Word、TXT、Markdown、JSON、XML）"
              : "Unsupported file type (supported: PDF, Word, TXT, Markdown, JSON, XML)",
          ),
          { reason: "format" as const },
        );
      const content = await readFileContent(file, zh, signal);
      await upload(file, content, signal);
      const result = { name: file.name, ok: true };
      results.push(result);
      onSettled?.(result);
    } catch (error) {
      if (isAbortError(error) || signal?.aborted)
        return { results, stopped: true };
      const result: UploadResult = {
        name: file.name,
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : zh
              ? "上传失败"
              : "Upload failed",
        reason: uploadReason(error),
      };
      results.push(result);
      onSettled?.(result);
    }
  }
  return { results, stopped: Boolean(signal?.aborted) };
}

function uploadReason(error: unknown): UploadFailureReason {
  if (
    error &&
    typeof error === "object" &&
    "reason" in error &&
    (error.reason === "format" ||
      error.reason === "size" ||
      error.reason === "other")
  )
    return error.reason;
  const message = error instanceof Error ? error.message : "";
  if (/不支持的文档格式|unsupported file type/i.test(message)) return "format";
  if (/超过 20 mb|exceeds 20 mb|文件为空/i.test(message)) return "size";
  return "other";
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && /abort/i.test(error.name + error.message))
  );
}

function readFileContent(
  file: File,
  zh: boolean,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const onAbort = () => {
      reader.abort();
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    reader.onload = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve(String(reader.result).split(",")[1] ?? "");
    };
    reader.onerror = reader.onabort = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(
        signal?.aborted
          ? new DOMException("Aborted", "AbortError")
          : new Error(zh ? "读取文件失败" : "Could not read file"),
      );
    };
    reader.readAsDataURL(file);
  });
}
