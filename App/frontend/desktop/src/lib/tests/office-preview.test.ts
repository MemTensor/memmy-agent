// @vitest-environment happy-dom

/** OOXML preview parser tests. */
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { docxLineHeightCss, readDocxBlocks, readXlsxSheets, type DocxBlock, type DocxTableCell } from "../office-preview.js";

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
      columnWidths: [],
      rows: [
        [cell("板块"), cell("判定")],
        [cell("社保"), cell("不合规")]
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
    expect(table.rows[0]?.[0]?.content).toEqual([
      paragraph("外层"),
      {
        kind: "table",
        columnWidths: [],
        rows: [[cell("内层")]]
      }
    ]);
  });

  it("keeps content controls, merged cells, column widths, and separate paragraphs", async () => {
    const blocks = await readDocxBlocks(await buildDocx(`
      <w:sdt><w:sdtContent><w:p><w:r><w:t>控件内</w:t></w:r></w:p></w:sdtContent></w:sdt>
      <w:tbl>
        <w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="4000"/></w:tblGrid>
        <w:tr>
          <w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>标题</w:t></w:r></w:p><w:p><w:r><w:t>副题</w:t></w:r></w:p></w:tc>
        </w:tr>
        <w:tr>
          <w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>合并</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>右上</w:t></w:r></w:p></w:tc>
        </w:tr>
        <w:tr>
          <w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p><w:r><w:t>被并入</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>右下</w:t></w:r></w:p></w:tc>
        </w:tr>
      </w:tbl>
    `));

    expect(blocks[0]).toEqual(paragraph("控件内"));
    const table = blocks[1] as Extract<typeof blocks[number], { kind: "table" }>;
    expect(table.columnWidths).toEqual([2000, 4000]);
    expect(table.rows[0]).toEqual([cell("标题", { colSpan: 2, content: [paragraph("标题"), paragraph("副题")] })]);
    expect(table.rows[1]?.[0]).toMatchObject({ rowSpan: 2, content: [paragraph("合并")] });
    expect(table.rows[1]?.map((item) => item.content[0])).toEqual([paragraph("合并"), paragraph("右上")]);
    expect(table.rows[2]).toEqual([cell("右下")]);
  });

  it("applies direct paragraph metrics and inherits style spacing", async () => {
    const blocks = await readDocxBlocks(await buildDocx(`
      <w:p>
        <w:pPr>
          <w:ind w:left="720" w:firstLineChars="200"/>
          <w:spacing w:before="200" w:after="80" w:line="276" w:lineRule="exact"/>
          <w:jc w:val="right"/>
        </w:pPr>
        <w:r><w:t>直接</w:t></w:r>
      </w:p>
      <w:p>
        <w:pPr><w:pStyle w:val="Note"/></w:pPr>
        <w:r><w:t>样式</w:t></w:r>
      </w:p>
      <w:p>
        <w:pPr>
          <w:pStyle w:val="Note"/>
          <w:ind w:hanging="360"/>
          <w:spacing w:after="0" w:beforeLines="100"/>
        </w:pPr>
        <w:r><w:t>悬挂</w:t></w:r>
      </w:p>
    `, `
      <w:docDefaults><w:pPrDefault><w:pPr>
        <w:spacing w:after="120" w:line="360" w:lineRule="auto"/>
      </w:pPr></w:pPrDefault></w:docDefaults>
      <w:style w:styleId="Body"><w:pPr>
        <w:ind w:left="420"/>
        <w:jc w:val="both"/>
      </w:pPr></w:style>
      <w:style w:styleId="Note"><w:basedOn w:val="Body"/><w:pPr>
        <w:jc w:val="center"/>
      </w:pPr></w:style>
    `));

    expect(blocks[0]).toMatchObject({
      format: {
        align: "right",
        indentLeft: 720,
        firstLineChars: 200,
        before: 200,
        after: 80,
        line: 276,
        lineRule: "exact"
      }
    });
    expect(blocks[1]).toMatchObject({
      format: {
        align: "center",
        indentLeft: 420,
        after: 120,
        line: 360,
        lineRule: "auto"
      }
    });
    expect(docxLineHeightCss(14, "auto")).toBe(1);
    expect(docxLineHeightCss(360, "auto")).toBe(1.5);
    expect(docxLineHeightCss(320, "exact")).toBe("max(16pt, 1.15em)");
    expect(blocks[2]).toMatchObject({
      format: {
        align: "center",
        indentLeft: 420,
        firstLine: -360,
        beforeLines: 100,
        after: 0,
        line: 360,
        lineRule: "auto"
      }
    });
  });

  it("draws embedded images and positioned diagrams without flattening their text", async () => {
    const png = Uint8Array.from(atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    ), (char) => char.charCodeAt(0));
    const blocks = await readDocxBlocks(await buildDocx(`
      <w:p>
        <w:r>
          <w:drawing>
            <wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
              <wp:extent cx="1270000" cy="635000"/>
              <a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_RELS_NS}" r:embed="rId9"/>
            </wp:inline>
          </w:drawing>
        </w:r>
        <w:r><w:t>图注</w:t></w:r>
      </w:p>
      <w:p>
        <w:r>
          <mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
            <mc:Choice Requires="wps">
              <w:drawing>
                <w:txbxContent><w:p><w:r><w:t>不要重复</w:t></w:r></w:p></w:txbxContent>
              </w:drawing>
            </mc:Choice>
            <mc:Fallback>
              <w:pict>
                <v:group xmlns:v="urn:schemas-microsoft-com:vml" style="width:200pt;height:100pt;" coordsize="2000,1000">
                  <v:rect style="position:absolute;left:100;top:100;width:600;height:300;" filled="t" stroked="t">
                    <v:textbox><w:txbxContent><w:p><w:r><w:t>工控计算机</w:t></w:r></w:p></w:txbxContent></v:textbox>
                  </v:rect>
                  <v:shape style="position:absolute;left:800;top:200;width:400;height:20;" filled="f" stroked="t" xmlns:o="urn:schemas-microsoft-com:office:office" o:spt="32">
                    <v:stroke endarrow="block"/>
                  </v:shape>
                </v:group>
              </w:pict>
            </mc:Fallback>
          </mc:AlternateContent>
        </w:r>
      </w:p>
    `, undefined, {
      "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PACKAGE_RELS_NS}"><Relationship Id="rId9" Type="${OFFICE_RELS_NS}/image" Target="media/image1.png"/></Relationships>`,
      "word/media/image1.png": png
    }));

    expect(blocks[0]).toMatchObject({ kind: "image", widthPt: 100, heightPt: 50 });
    expect((blocks[0] as Extract<DocxBlock, { kind: "image" }>).src.startsWith("data:image/png;base64,")).toBe(true);
    expect(blocks[1]).toMatchObject({ kind: "paragraph", spans: [{ text: "图注" }] });
    expect(blocks[2]).toMatchObject({
      kind: "drawing",
      widthPt: 200,
      heightPt: 100,
      shapes: [
        { role: "box", text: "工控计算机", left: 5, top: 10, width: 30, height: 30 },
        { role: "line", text: "", endArrow: true, left: 40, top: 20, width: 20, height: 2 }
      ]
    });
    expect(JSON.stringify(blocks)).not.toContain("不要重复");
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

function paragraph(text: string): Extract<DocxBlock, { kind: "paragraph" }> {
  return { kind: "paragraph", headingLevel: null, spans: [{ text, bold: false, italic: false }] };
}

function cell(text: string, extra?: Partial<DocxTableCell>): DocxTableCell {
  return {
    content: [paragraph(text)],
    colSpan: 1,
    rowSpan: 1,
    ...extra
  };
}

async function buildDocx(body: string, styles?: string, files?: Record<string, string | Uint8Array>): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${WORD_NS}"><w:body>${body}</w:body></w:document>`);
  if (styles) {
    zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${WORD_NS}">${styles}</w:styles>`);
  }
  for (const [path, contents] of Object.entries(files ?? {})) zip.file(path, contents);
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
