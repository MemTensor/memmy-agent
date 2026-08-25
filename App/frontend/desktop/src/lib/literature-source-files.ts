export const LITERATURE_SOURCE_ACCEPT = ".pdf,.docx,.doc,.txt,.md";

const SUPPORTED_EXTENSIONS = new Set(["pdf", "docx", "doc", "txt", "md"]);

export interface LiteratureSourceBatchAssessment<T> {
  accepted: T[];
  unsupportedCount: number;
}

export function isSupportedLiteratureSourceName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  const extensionStart = normalized.lastIndexOf(".");
  if (extensionStart <= 0 || extensionStart === normalized.length - 1) return false;
  return SUPPORTED_EXTENSIONS.has(normalized.slice(extensionStart + 1));
}

export function assessLiteratureSourceBatch<T extends { name: string; size: number }>(
  files: T[]
): LiteratureSourceBatchAssessment<T> {
  const accepted = files.filter((file) => isSupportedLiteratureSourceName(file.name));
  const unsupportedCount = files.length - accepted.length;
  return { accepted, unsupportedCount };
}

export function formatLiteratureSourceSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(kilobytes >= 10 ? 0 : 1)} KB`;
  const megabytes = kilobytes / 1024;
  return `${megabytes.toFixed(megabytes >= 10 ? 0 : 1)} MB`;
}
