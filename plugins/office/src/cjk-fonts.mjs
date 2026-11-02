import fs from "node:fs/promises";
import path from "node:path";
import { openSync } from "fontkit";

const MAX_FONT_FILES = 16;
const MAX_FONT_BYTES = 256 * 1024 * 1024;
const error = (code, message) => Object.assign(new Error(message), { code });

function hostFontFiles(serialized) {
  let files;
  try { files = serialized === undefined ? [] : JSON.parse(serialized); }
  catch { throw error("office_cjk_font_configuration_invalid", "The Host CJK font list is invalid."); }
  if (!Array.isArray(files) || files.length > MAX_FONT_FILES || files.some(file => typeof file !== "string" || !path.isAbsolute(file))) {
    throw error("office_cjk_font_configuration_invalid", "The Host CJK font list must contain at most 16 canonical absolute files.");
  }
  return [...new Set(files)];
}

/** Only the Host supplies these canonical files; document input cannot select paths. */
export async function selectCjkFont(text, serialized = process.env.MEMMY_OFFICE_CJK_FONTS, platform = process.platform) {
  const codePoints = [...new Set([...text].filter(character => /\p{Script=Han}/u.test(character)).map(character => character.codePointAt(0)))];
  if (!codePoints.length) return null;
  const files = hostFontFiles(serialized);
  const candidates = [];
  for (const file of new Set(files)) {
    let info, canonical, parent;
    if (platform === "win32" && path.normalize(file) !== file) {
      throw error("office_cjk_font_configuration_invalid", "A Host CJK font path is not normalized.");
    }
    try {
      info = await fs.lstat(file);
      if (platform === "win32") {
        // The exact file is the Host-approved authority, not its parent directory.
        // The Host canonicalized all ancestors in readonly sources. AppContainer
        // may deny Mount Manager queries, so inspect only this leaf and its parent;
        // never traverse C:\\ or turn a derived directory into a new grant.
        parent = await fs.lstat(path.dirname(file));
        canonical = file;
      } else canonical = await fs.realpath(file);
    }
    catch { continue; }
    if (info.isSymbolicLink() || canonical !== file || !info.isFile() || info.size < 1 || info.size > MAX_FONT_BYTES
      || (parent && (!parent.isDirectory() || parent.isSymbolicLink()))) {
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

/** Bounded operator diagnostics for a fixed probe, never document text or paths. */
export async function diagnoseCjkFonts(serialized = process.env.MEMMY_OFFICE_CJK_FONTS) {
  let files;
  try { files = hostFontFiles(serialized); }
  catch { return { hostListValid: false, hostFileCount: 0, files: [] }; }
  const probe = [...new Set([..."中文内容文档生成预览与交付"].map(character => character.codePointAt(0)))];
  const report = { hostListValid: true, hostFileCount: files.length, probeCodePointCount: probe.length, files: [] };
  const errno = caught => typeof caught?.code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/u.test(caught.code) ? caught.code : "ERROR";
  for (const [index, file] of files.entries()) {
    const record = { index };
    try { const info = await fs.lstat(file); record.lstat = { ok: true, regular: info.isFile(), symbolicLink: info.isSymbolicLink(), withinSizeLimit: info.size > 0 && info.size <= MAX_FONT_BYTES }; }
    catch (caught) { record.lstat = { ok: false, errno: errno(caught) }; }
    try { const info = await fs.lstat(path.dirname(file)); record.parentLstat = { ok: true, directory: info.isDirectory(), symbolicLink: info.isSymbolicLink() }; }
    catch (caught) { record.parentLstat = { ok: false, errno: errno(caught) }; }
    try { record.realpath = { ok: true, matchesHostPath: await fs.realpath(file) === file }; }
    catch (caught) { record.realpath = { ok: false, errno: errno(caught) }; }
    if (path.normalize(file) === file && record.lstat.ok && record.lstat.regular && !record.lstat.symbolicLink && record.lstat.withinSizeLimit
      && record.parentLstat.ok && record.parentLstat.directory && !record.parentLstat.symbolicLink
      && (!record.realpath.ok || record.realpath.matchesHostPath)) {
      try { const handle = await fs.open(file, "r"); await handle.close(); record.open = { ok: true }; }
      catch (caught) { record.open = { ok: false, errno: errno(caught) }; }
      try {
        const loaded = openSync(file), faces = (loaded.fonts ?? [loaded]).slice(0, 128);
        const coverage = faces.map(face => probe.filter(codePoint => face.hasGlyphForCodePoint(codePoint)).length);
        record.cmap = { ok: true, faceCount: faces.length, bestCoverage: Math.max(0, ...coverage), coveringFaces: coverage.filter(count => count === probe.length).length };
      } catch (caught) { record.cmap = { ok: false, errno: errno(caught) }; }
    }
    report.files.push(record);
  }
  return report;
}
