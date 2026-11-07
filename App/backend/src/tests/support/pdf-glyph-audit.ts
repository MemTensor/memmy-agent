import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { create as createFont, type Font } from "fontkit";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));
// PDF.js requires a trailing slash; forward slashes remain valid Node paths on Windows.
const assetDirectory = (...parts: string[]) => join(...parts).split(sep).join("/") + "/";
export const pdfStandardFontsRoot = assetDirectory(pdfjsRoot, "standard_fonts");
const han = /\p{Unified_Ideograph}/u;

interface PdfFontData {
  name?: string;
  data?: Uint8Array;
  missingFile?: boolean;
  isType3Font?: boolean;
}

interface DrawnGlyph {
  unicode: string;
  fontChar: string;
  isSpace?: boolean;
  isInFont?: boolean;
}

interface TextState {
  fontId: string | null;
  size: number;
  mode: number;
  fillAlpha: number;
  strokeAlpha: number;
}

export interface PdfGlyphAudit {
  auditedGlyphs: number;
  drawnText: string;
  sourceText: string;
  fonts: Array<{ name: string; format: "TrueType" | "CFF"; glyphs: number }>;
}

function selectedText(text: string, mode: "han" | "all"): string[] {
  return Array.from(text).filter(character => mode === "han" ? han.test(character) : !/\s/u.test(character));
}

function fail(message: string): never {
  throw new Error("PDF glyph audit: " + message);
}

/** Inspect drawn font glyphs, rather than accessibility text or ActualText. */
export async function auditPdfGlyphs(
  bytes: Uint8Array,
  expectedText: string,
  mode: "han" | "all" = "han"
): Promise<PdfGlyphAudit> {
  const expected = selectedText(expectedText, mode);
  if (expected.length === 0) fail("expected text has no characters to audit");
  if (bytes.byteLength > 40 * 1024 * 1024) fail("PDF exceeds audit limit");
  const task = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    fontExtraProperties: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    isEvalSupported: false,
    stopAtErrors: true,
    standardFontDataUrl: pdfStandardFontsRoot,
    cMapUrl: assetDirectory(pdfjsRoot, "cmaps"),
    cMapPacked: true
  });
  const cache = new Map<string, {
    font: Font;
    missingOutline: string;
    record: PdfGlyphAudit["fonts"][number];
  }>();
  const drawn: string[] = [];
  let auditedGlyphs = 0;
  try {
    const document = await task.promise;
    if (document.numPages < 1 || document.numPages > 200) fail("invalid page count");
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const operators = await page.getOperatorList();
      let state: TextState = { fontId: null, size: 0, mode: 0, fillAlpha: 1, strokeAlpha: 1 };
      const stack: TextState[] = [];
      for (let index = 0; index < operators.fnArray.length; index++) {
        const operation = operators.fnArray[index];
        const args = operators.argsArray[index] as unknown[];
        if (operation === OPS.save) stack.push({ ...state });
        else if (operation === OPS.restore) state = stack.pop() ?? fail("unbalanced text state");
        else if (operation === OPS.setFont) {
          state.fontId = String(args[0]); state.size = Number(args[1]);
        } else if (operation === OPS.setTextRenderingMode) state.mode = Number(args[0]);
        else if (operation === OPS.setGState) {
          for (const [key, value] of args[0] as Array<[string, unknown]>) {
            if (key === "Font") {
              const font = value as [string, number];
              state.fontId = font[0]; state.size = font[1];
            } else if (key === "ca") state.fillAlpha = Number(value);
            else if (key === "CA") state.strokeAlpha = Number(value);
          }
        } else if (operation === OPS.showText) {
          const paintingMode = state.mode & 3;
          const visible = paintingMode === 0 ? state.fillAlpha > 0
            : paintingMode === 1 ? state.strokeAlpha > 0
              : paintingMode === 2 && (state.fillAlpha > 0 || state.strokeAlpha > 0);
          if (!visible || !Number.isFinite(state.size) || state.size <= 0) continue;
          for (const item of args[0] as Array<DrawnGlyph | number>) {
            if (typeof item === "number" || item.isSpace) continue;
            if (typeof item.unicode !== "string" || typeof item.fontChar !== "string") fail("invalid drawn glyph");
            const characters = selectedText(item.unicode, mode);
            if (characters.length === 0) continue;
            if (!state.fontId) fail("drawn glyph has no font");
            let entry = cache.get(state.fontId);
            if (!entry) {
              const data = page.commonObjs.get(state.fontId) as PdfFontData;
              if (data.missingFile || data.isType3Font || !(data.data instanceof Uint8Array)) fail("drawn font cannot be verified");
              const fontBytes = Buffer.from(data.data);
              const parsed = createFont(fontBytes);
              if (!("glyphForCodePoint" in parsed)) fail("unexpected font collection");
              const format = fontBytes.toString("ascii", 0, 4) === "OTTO" ? "CFF" : "TrueType";
              entry = {
                font: parsed,
                missingOutline: parsed.getGlyph(0).path.toSVG(),
                record: { name: data.name ?? state.fontId, format, glyphs: 0 }
              };
              cache.set(state.fontId, entry);
            }
            const character = item.fontChar.codePointAt(0);
            if (character === undefined || item.isInFont === false) fail("drawn glyph is not mapped in its font");
            const glyph = entry.font.glyphForCodePoint(character);
            const outline = glyph.path.toSVG();
            if (glyph.id === 0 || !outline || outline === entry.missingOutline) {
              fail("drawn glyph is .notdef or a cloned .notdef outline");
            }
            auditedGlyphs++;
            entry.record.glyphs++;
            drawn.push(...characters);
          }
        }
      }
    }
    if (auditedGlyphs === 0) fail("no visible glyphs were audited");
    if (JSON.stringify([...drawn].sort()) !== JSON.stringify([...expected].sort())) {
      fail("drawn character coverage differs from the source");
    }
    return { auditedGlyphs, drawnText: drawn.join(""), sourceText: expected.join(""), fonts: [...cache.values()].map(entry => entry.record) };
  } finally {
    await task.destroy();
  }
}
