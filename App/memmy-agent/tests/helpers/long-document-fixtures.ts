import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

export const REPORT_FACTS = ["PE=38.95", "HOLDING=61.35%", "ISSUED=112000000", "RAISED=2110000000"];

export function reportText(chars = 260_000): string {
  const section = "Synthetic company disclosure. Figures in this fixture are not investment advice.\n";
  const padding = section.repeat(Math.ceil(chars / 4 / section.length));
  return REPORT_FACTS.map((fact, index) => `Section ${index + 1}\n${padding}\nVERIFIED: ${fact}\n`).join("\n");
}

export async function writeDocx(root: string, text: string): Promise<string> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = text.split("\n").map((line) => `<w:p><w:r><w:t xml:space="preserve">${escape(line)}</w:t></w:r></w:p>`).join("");
  zip.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  const file = path.join(root, "synthetic-report.docx");
  await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  return file;
}

export async function writePdf(root: string, pageCount: number): Promise<string> {
  const objects: string[] = [];
  const font = 3 + pageCount * 2;
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pageCount} >>`;
  for (let i = 0; i < pageCount; i += 1) {
    // 120 visible lines at 4pt: ~15K extracted chars/page, all within page bounds.
    const lines = Array.from({ length: 120 }, (_, row) => `Page ${i + 1} row ${row + 1} synthetic report ` + "data ".repeat(19));
    if (i === pageCount - 1) lines[119] = "VERIFIED: " + REPORT_FACTS.join("; ");
    const stream = `BT /F1 4 Tf 5 TL 36 760 Td ${lines.map((line, row) => `${row ? "T* " : ""}(${line}) Tj`).join("\n")} ET`;
    objects[3 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`;
    objects[4 + i * 2] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  }
  objects[font] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i < objects.length; i += 1) {
    offsets[i] = Buffer.byteLength(body);
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const start = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i += 1) body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Root 1 0 R /Size ${objects.length} >>\nstartxref\n${start}\n%%EOF\n`;
  const file = path.join(root, "synthetic-report.pdf");
  await fs.writeFile(file, body);
  return file;
}
