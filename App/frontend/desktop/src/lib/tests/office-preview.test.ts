// @vitest-environment happy-dom

/** OOXML preview parser tests. */
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { readDocxBlocks, readXlsxSheets } from "../office-preview.js";

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const OFFICE_RELS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

describe("docx preview parser", () => {
  it("reads headings, styled runs, tabs, line breaks, and tables in document order", async () => {
    const blocks = await readDocxBlocks(await buildDocx(`
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>用工风险与合规诊断报告</w:t></w:r></w:p>
      <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>结论：</w:t></w:r><w:r><w:t>存在</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>高风险</w:t></w:r></w:p>
      <w:p><w:r><w:t>第一行</w:t><w:br/><w:t>第二行</w:t><w:tab/><w:t>缩进</w:t></w:r></w:p>
      <w:p/>
      <w:tbl>
        <w:tr><w:tc><w:p><w:r><w:t>板块</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>判定</w:t></w:r></w:p></w:tc></w:tr>
        <w:tr><w:tc><w:p><w:r><w:t>社保</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>不合规</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl>
    `));

    expect(blocks[0]).toEqual({
      kind: "paragraph",
      headingLevel: 1,
      spans: [{ text: "用工风险与合规诊断报告", bold: false, italic: false }]
    });
    expect(blocks[1]).toEqual({
      kind: "paragraph",
      headingLevel: null,
      spans: [
        { text: "结论：", bold: true, italic: false },
        { text: "存在", bold: false, italic: false },
        { text: "高风险", bold: false, italic: true }
      ]
    });
    expect(blocks[2]).toMatchObject({ spans: [{ text: "第一行\n第二行\t缩进" }] });
    expect(blocks[3]).toEqual({ kind: "paragraph", headingLevel: null, spans: [] });
    expect(blocks[4]).toEqual({
      kind: "table",
      rows: [
        [[{ text: "板块", bold: false, italic: false }], [{ text: "判定", bold: false, italic: false }]],
        [[{ text: "社保", bold: false, italic: false }], [{ text: "不合规", bold: false, italic: false }]]
      ]
    });
  });

  it("treats a toggle turned off as not styled", async () => {
    const blocks = await readDocxBlocks(await buildDocx(
      `<w:p><w:r><w:rPr><w:b w:val="0"/><w:i w:val="true"/></w:rPr><w:t>正文</w:t></w:r></w:p>`
    ));

    expect(blocks[0]).toMatchObject({ spans: [{ text: "正文", bold: false, italic: true }] });
  });

  it("does not attribute a nested table paragraph to the enclosing cell twice", async () => {
    const blocks = await readDocxBlocks(await buildDocx(`
      <w:tbl><w:tr><w:tc>
        <w:p><w:r><w:t>外层</w:t></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>内层</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      </w:tc></w:tr></w:tbl>
    `));

    const table = blocks[0] as Extract<typeof blocks[number], { kind: "table" }>;
    expect(table.rows[0]?.[0]).toEqual([{ text: "外层", bold: false, italic: false }]);
  });

  it("rejects an archive that is not a Word document", async () => {
    const zip = new JSZip();
    zip.file("hello.txt", "not a document");
    await expect(readDocxBlocks(await zip.generateAsync({ type: "arraybuffer" }))).rejects.toThrow(/word\/document\.xml/);
  });
});

describe("xlsx preview parser", () => {
  it("resolves shared strings, inline strings, booleans, formula values, and date formats", async () => {
    const sheets = await readXlsxSheets(await buildXlsx([{
      name: "诊断表",
      rows: `
        <row r="1">
          <c r="A1" t="s"><v>0</v></c>
          <c r="B1" t="s"><v>1</v></c>
          <c r="C1" t="inlineStr"><is><t>备注</t></is></c>
        </row>
        <row r="2">
          <c r="A2" t="s"><v>2</v></c>
          <c r="B2" s="1"><v>45000</v></c>
          <c r="C2" t="b"><v>1</v></c>
        </row>
        <row r="3">
          <c r="A3"><f>SUM(B1:B2)</f><v>42</v></c>
        </row>
      `
    }]));

    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.name).toBe("诊断表");
    expect(sheets[0]?.rows).toEqual([
      ["板块", "判定", "备注"],
      ["社保", "2023-03-15", "TRUE"],
      ["42", "", ""]
    ]);
  });

  it("aligns sparse cells to the columns named by their references", async () => {
    const sheets = await readXlsxSheets(await buildXlsx([{
      name: "Sparse",
      rows: `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="D1" t="s"><v>1</v></c></row>`
    }]));

    expect(sheets[0]?.rows).toEqual([["板块", "", "", "判定"]]);
  });

  it("reads every worksheet in workbook order", async () => {
    const sheets = await readXlsxSheets(await buildXlsx([
      { name: "风险汇总", rows: `<row r="1"><c r="A1" t="s"><v>0</v></c></row>` },
      { name: "交付清单", rows: `<row r="1"><c r="A1" t="s"><v>1</v></c></row>` }
    ]));

    expect(sheets.map((sheet) => sheet.name)).toEqual(["风险汇总", "交付清单"]);
    expect(sheets[1]?.rows).toEqual([["判定"]]);
  });

  it("fills the rows a worksheet skips over, leaving nothing for a caller to trip on", async () => {
    // The generated diagnosis workbook numbers its rows with gaps, which used
    // to leave holes in this grid. `map` preserves holes, so the preview read
    // `undefined` for a row it had been promised and took the whole app down
    // with it. Spreading here is what a caller does, and what exposes a hole.
    const sheets = await readXlsxSheets(await buildXlsx([{
      name: "Gaps",
      rows: `<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="4"><c r="A4" t="s"><v>1</v></c></row>`
    }]));

    const rows = sheets[0]?.rows ?? [];
    expect([...rows]).toEqual([["板块"], [""], [""], ["判定"]]);
    expect(rows.every((row) => Array.isArray(row))).toBe(true);
  });

  it("drops trailing blank rows", async () => {
    const sheets = await readXlsxSheets(await buildXlsx([{
      name: "Trailing",
      rows: `<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="9"><c r="A9"/></row>`
    }]));

    expect(sheets[0]?.rows).toEqual([["板块"]]);
  });

  it("rejects an archive that is not a workbook", async () => {
    const zip = new JSZip();
    zip.file("hello.txt", "not a workbook");
    await expect(readXlsxSheets(await zip.generateAsync({ type: "arraybuffer" }))).rejects.toThrow(/xl\/workbook\.xml/);
  });
});

async function buildDocx(body: string): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${WORD_NS}"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "arraybuffer" });
}

async function buildXlsx(sheets: ReadonlyArray<{ name: string; rows: string }>): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${SHEET_NS}" xmlns:r="${OFFICE_RELS_NS}"><sheets>${
      sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")
    }</sheets></workbook>`
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PACKAGE_RELS_NS}">${
      sheets.map((_sheet, index) => `<Relationship Id="rId${index + 1}" Target="worksheets/sheet${index + 1}.xml" Type="${OFFICE_RELS_NS}/worksheet"/>`).join("")
    }</Relationships>`
  );
  zip.file(
    "xl/sharedStrings.xml",
    `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${SHEET_NS}"><si><t>板块</t></si><si><t>判定</t></si><si><r><t>社</t></r><r><t>保</t></r></si></sst>`
  );
  // cellXfs index 1 points at the built-in date format 14, which the parser must detect.
  zip.file(
    "xl/styles.xml",
    `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${SHEET_NS}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`
  );
  for (const [index, sheet] of sheets.entries()) {
    zip.file(
      `xl/worksheets/sheet${index + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${SHEET_NS}"><sheetData>${sheet.rows}</sheetData></worksheet>`
    );
  }
  return zip.generateAsync({ type: "arraybuffer" });
}
