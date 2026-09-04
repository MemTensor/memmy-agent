import { createHash } from "node:crypto";
import { redactSecrets } from "../agent-source/adapters/secret-redactor.js";
import { sanitizeMemmyProtocolText } from "./memmy-context-tags.js";

const QA_HASH_VERSION = "v1";

export function normalizeMemoryCaptureSource(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeMemoryCaptureText(value: string): string {
  return redactSecrets(sanitizeMemmyProtocolText(value))
    .replace(/\r\n?/g, "\n")
    .normalize("NFC")
    .trim();
}

export function memoryCaptureQaHash(query: string, answer: string): string {
  const payload = JSON.stringify([
    QA_HASH_VERSION,
    normalizeMemoryCaptureText(query),
    normalizeMemoryCaptureText(answer)
  ]);
  return `${QA_HASH_VERSION}:${createHash("sha256").update(payload).digest("hex")}`;
}
