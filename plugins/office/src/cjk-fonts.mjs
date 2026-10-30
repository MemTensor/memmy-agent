import fs from "node:fs/promises";
import path from "node:path";
import { openSync } from "fontkit";

const MAX_FONT_FILES = 16;
const MAX_FONT_BYTES = 256 * 1024 * 1024;
const error = (code, message) => Object.assign(new Error(message), { code });

/** Only the Host supplies these canonical files; document input cannot select paths. */
export async function selectCjkFont(text, serialized = process.env.MEMMY_OFFICE_CJK_FONTS) {
  const codePoints = [...new Set([...text].filter(character => /\p{Script=Han}/u.test(character)).map(character => character.codePointAt(0)))];
  if (!codePoints.length) return null;
  let files;
  try { files = serialized === undefined ? [] : JSON.parse(serialized); }
  catch { throw error("office_cjk_font_configuration_invalid", "The Host CJK font list is invalid."); }
  if (!Array.isArray(files) || files.length > MAX_FONT_FILES || files.some(file => typeof file !== "string" || !path.isAbsolute(file))) {
    throw error("office_cjk_font_configuration_invalid", "The Host CJK font list must contain at most 16 canonical absolute files.");
  }
  const candidates = [];
  for (const file of new Set(files)) {
    let info, canonical;
    try { info = await fs.lstat(file); canonical = await fs.realpath(file); }
    catch { continue; }
    if (info.isSymbolicLink() || canonical !== file || !info.isFile() || info.size < 1 || info.size > MAX_FONT_BYTES) {
      throw error("office_cjk_font_configuration_invalid", "A Host CJK font is not a canonical regular file within the size limit.");
    }
    candidates.push(file);
  }
  for (const file of candidates) {
    try {
      const font = openSync(file);
      const faces = font.fonts ?? [font];
      for (const face of faces) {
        const familyName = face.familyName?.trim();
        if (!familyName || familyName.length > 128 || /[\x00-\x1f\x7f]/u.test(familyName)) continue;
        if (codePoints.every(codePoint => face.hasGlyphForCodePoint(codePoint))) {
          return { familyName, postscriptName: face.postscriptName, path: file };
        }
      }
    } catch { /* An unreadable or unsupported candidate cannot establish glyph coverage. */ }
  }
  throw error("office_cjk_font_missing", "No Host-approved font covers the Han text. Provide a verified CJK font and retry; no document was generated.");
}
