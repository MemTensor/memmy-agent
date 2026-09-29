import { basename } from "node:path";

/** DSH generations and timestamped rotation backups share the same event format. */
export function isDeepseekHarnessSessionFile(name: string): boolean {
  return /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?(?:\.bak-\d+)?$/u.test(name);
}

export function isDeepseekHarnessCompressedSession(filePath: string): boolean {
  return /\.zstd(?:\.bak-\d+)?$/u.test(filePath);
}

/** Keep headerless message identities stable when a file is rotated. */
export function deepseekHarnessSessionFallbackId(filePath: string): string {
  return basename(filePath).replace(/(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?(?:\.bak-\d+)?$/u, "");
}
