import { basename } from "node:path";

/** Keep headerless message identities stable when a file is rotated. */
export function deepseekHarnessSessionFallbackId(filePath: string): string {
  return basename(filePath).replace(/(?:\.v\d+)?\.jsonl(?:\.zstd)?(?:\.bak-\d+)?$/u, "");
}
