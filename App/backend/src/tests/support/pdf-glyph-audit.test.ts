import { readFileSync } from "node:fs";
import { join } from "node:path";
import { create as createFont } from "fontkit";
import {
  PDFDocument, PDFDict, PDFHexString, PDFName, PDFOperator, PDFOperatorNames, StandardFonts
} from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { auditPdfGlyphs, pdfStandardFontsRoot } from "./pdf-glyph-audit.js";

function liberation(cloneMissingGlyph: boolean): Buffer {
  const bytes = Buffer.from(readFileSync(join(pdfStandardFontsRoot, "LiberationSans-Regular.ttf")));
  if (!cloneMissingGlyph) return bytes;
  const tables = new Map<string, number>();
  for (let offset = 12; offset < 12 + 16 * bytes.readUInt16BE(4); offset += 16) {
    tables.set(bytes.toString("ascii", offset, offset + 4), bytes.readUInt32BE(offset + 8));
  }
  const font = createFont(bytes);
  if (!("glyphForCodePoint" in font)) throw new Error("Expected a TrueType fixture");
  const glyphId = font.glyphForCodePoint(65).id;
  const short = bytes.readInt16BE(tables.get("head")! + 50) === 0;
  const location = (id: number) => short
    ? bytes.readUInt16BE(tables.get("loca")! + id * 2) * 2
    : bytes.readUInt32BE(tables.get("loca")! + id * 4);
  const base = tables.get("glyf")!;
  const missing = Buffer.from(bytes.subarray(base + location(0), base + location(1)));
  const start = base + location(glyphId), end = base + location(glyphId + 1);
  if (glyphId === 0 || missing.length === 0 || missing.length > end - start) throw new Error("Invalid open-font fixture layout");
  bytes.fill(0, start, end); missing.copy(bytes, start);
  const changed = createFont(bytes);
  if (!("glyphForCodePoint" in changed)) throw new Error("Expected a TrueType fixture");
  expect(changed.glyphForCodePoint(65).id).toBeGreaterThan(0);
  expect(changed.glyphForCodePoint(65).path.toSVG()).toBe(changed.getGlyph(0).path.toSVG());
  return bytes;
}

async function fixture(format: "TrueType" | "CFF", invalid: boolean, partialChinese = false): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const embeddingFontkit = {
    create(bytes: Uint8Array) {
      const font = createFont(Buffer.from(bytes));
      if (!("glyphForCodePoint" in font)) throw new Error("Expected a single fixture font");
      return font;
    }
  };
  // pdf-lib's older declaration includes private font-table fields omitted by
  // fontkit's public types; the supported create interface is exercised below.
  pdf.registerFontkit(embeddingFontkit as unknown as Parameters<PDFDocument["registerFontkit"]>[0]);
  const font = format === "TrueType"
    ? await pdf.embedFont(liberation(invalid), { subset: false })
    : await pdf.embedFont(StandardFonts.TimesRoman);
  const page = pdf.addPage([300, 150]);
  if (invalid) page.pushOperators(PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [
    PDFName.of("Span"), pdf.context.obj({ ActualText: PDFHexString.fromText("中文") }).toString()
  ]));
  if (format === "CFF" && invalid) {
    page.pushOperators(
      PDFOperator.of(PDFOperatorNames.BeginText),
      PDFOperator.of(PDFOperatorNames.SetFontAndSize, [page.node.newFontDictionary(font.name, font.ref), pdf.context.obj(16)]),
      PDFOperator.of(PDFOperatorNames.ShowText, [PDFHexString.of("00")]),
      PDFOperator.of(PDFOperatorNames.EndText)
    );
  } else page.drawText(invalid || partialChinese ? "A" : "ABC", { font, size: 16, x: 30, y: 90 });
  if (invalid) page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent));
  const code = format === "CFF" ? "00" : font.encodeText("A").asString();
  await font.embed();
  if (invalid || partialChinese) {
    const dictionary = pdf.context.lookup(font.ref, PDFDict);
    const cmap = [
      "/CIDInit /ProcSet findresource begin", "12 dict begin", "begincmap",
      "1 begincodespacerange", format === "CFF" ? "<00> <FF>" : "<0000> <FFFF>", "endcodespacerange",
      "1 beginbfchar", "<" + code + "> " + (partialChinese ? "<4E2D>" : "<4E2D6587>"), "endbfchar", "endcmap", "end", "end"
    ].join("\n");
    dictionary.set(PDFName.of("ToUnicode"), pdf.context.register(pdf.context.flateStream(cmap)));
  }
  return await pdf.save({ useObjectStreams: false });
}

async function extracted(bytes: Uint8Array): Promise<string> {
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, useWorkerFetch: false, standardFontDataUrl: pdfStandardFontsRoot });
  try {
    const pdf = await task.promise, page = await pdf.getPage(1);
    const text = await page.getTextContent();
    return text.items.map(item => "str" in item ? item.str : "").join("");
  } finally { await task.destroy(); }
}

describe("PDF drawn glyph audit", () => {
  it.each(["TrueType", "CFF"] as const)("audits actual %s glyphs without relying on Han filtering", async format => {
    const result = await auditPdfGlyphs(await fixture(format, false), "ABC", "all");
    expect(result.auditedGlyphs).toBe(3);
    expect(result.fonts.some(font => font.format === format && font.glyphs === 3)).toBe(true);
  });

  it.each(["TrueType", "CFF"] as const)("rejects %s missing glyphs even when Unicode metadata claims Chinese", async format => {
    const bytes = await fixture(format, true);
    expect(await extracted(bytes)).toContain("中文");
    await expect(auditPdfGlyphs(bytes, "中文", "all")).rejects.toThrow(format === "TrueType"
      ? /cloned \.notdef outline/ : /\.notdef|not mapped/);
  });

  it("fails instead of passing when Han filtering finds no actual drawn glyph", async () => {
    await expect(auditPdfGlyphs(await fixture("CFF", false), "中文")).rejects.toThrow("no visible glyphs were audited");
  });

  it("rejects partial Chinese output even when its remaining Unicode metadata still contains Han", async () => {
    const originalSource = "中文";
    const bytes = await fixture("TrueType", false, true);
    const remainingText = await extracted(bytes);
    expect(remainingText).toBe("中");
    await expect(auditPdfGlyphs(bytes, originalSource, "all")).rejects.toThrow("drawn character coverage differs from the source");
  });
});
