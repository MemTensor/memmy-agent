import { basename } from "node:path";

const MEDIA_TOKEN = /^[A-Za-z0-9_-]{16,}$/u;
const FILE_EXTENSION = /\.[A-Za-z0-9]{1,8}$/u;
const INTERNAL_ID_PREFIX = /^[0-9a-f]{6,}-/iu;

/** Default name for the desktop Save As dialog. Media URL tokens decode to the original file name. */
export function desktopSaveFileName(name: string | undefined): string {
  const base = basename(String(name ?? "").split(/[?#]/u)[0] ?? "").trim();
  const decoded = humanNameFromMediaToken(base);
  const chosen = sanitizeSaveFileName(decoded || base);
  return chosen || "download";
}

export function humanNameFromMediaToken(value: string): string | null {
  if (!MEDIA_TOKEN.test(value)) {
    return null;
  }
  let text = "";
  try {
    text = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!text || text.includes("\u0000")) {
    return null;
  }
  const file = text.split(/[\\/]/u).pop()?.trim() ?? "";
  const stripped = file.replace(INTERNAL_ID_PREFIX, "");
  if (!stripped || !FILE_EXTENSION.test(stripped)) {
    return null;
  }
  return stripped;
}

function sanitizeSaveFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-").replace(/\s+/gu, " ").trim().slice(0, 180);
}
