import fs from "node:fs";
import path from "node:path";
import { extension } from "mime-types";

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_SIZE = DEFAULT_MAX_BYTES;

export class FileSizeExceeded extends Error {}

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "text/plain": ".txt",
};

function extensionForMime(mime: string): string {
  const normalized = mime.toLowerCase();
  const configured = EXTENSIONS[normalized];
  if (configured) return configured;
  const guessed = extension(normalized);
  return guessed ? `.${guessed}` : ".bin";
}

export function decodeDataUrl(dataUrl: string): { mime: string; data: Buffer } {
  const match = dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) throw new Error("Invalid data URL");
  const normalized = match[2].replace(/\s+/g, "");
  if (normalized.length % 4 === 1) throw new Error("Invalid base64 payload");
  return { mime: match[1], data: Buffer.from(normalized, "base64") };
}

export function saveBase64DataUrl(
  dataUrl: string,
  mediaDir: string,
  { maxBytes = DEFAULT_MAX_BYTES }: { maxBytes?: number } = {},
): string | null {
  let decoded: { mime: string; data: Buffer };
  try {
    decoded = decodeDataUrl(dataUrl);
  } catch {
    return null;
  }
  if (decoded.data.length > maxBytes) {
    throw new FileSizeExceeded(`File exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`);
  }
  fs.mkdirSync(mediaDir, { recursive: true });
  const ext = extensionForMime(decoded.mime);
  const filename = `upload_${Date.now()}_${crypto.randomUUID()}${ext}`;
  const target = path.join(mediaDir, filename);
  fs.writeFileSync(target, decoded.data);
  return target;
}
