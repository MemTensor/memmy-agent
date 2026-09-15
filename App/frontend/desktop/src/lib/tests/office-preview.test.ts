// @vitest-environment happy-dom

/** Word preview parser tests. */
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { readDocxBlocks } from "../office-preview.js";

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

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

async function buildDocx(body: string): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${WORD_NS}"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "arraybuffer" });
}
