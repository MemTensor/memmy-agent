import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SUPPORTED_EXTENSIONS, isTextExtension, extractText } from "../src/utils/document.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-document-parsing-"));
  roots.push(root);
  return root;
}

function zipTree(tree: Record<string, string>, filename: string): string {
  const root = tempRoot();
  for (const [rel, content] of Object.entries(tree)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }
  const out = path.join(root, filename);
  const result = spawnSync("zip", ["-qr", out, "."], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return out;
}

function makePdf(pages: string[], filename = "test.pdf"): string {
  const root = tempRoot();
  const file = path.join(root, filename);
  const escapePdfText = (text: string) => text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  const fontObj = 3 + pages.length * 2;
  pages.forEach((text, index) => {
    const pageObj = 3 + index * 2;
    const contentObj = 4 + index * 2;
    const stream = `BT /F1 24 Tf 72 720 Td (${escapePdfText(text)}) Tj ET`;
    objects[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>`;
    objects[contentObj] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });
  objects[fontObj] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i < objects.length; i += 1) {
    offsets[i] = Buffer.byteLength(body, "latin1");
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const startxref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i += 1) body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Root 1 0 R /Size ${objects.length} >>\nstartxref\n${startxref}\n%%EOF\n`;
  fs.writeFileSync(file, body, "latin1");
  return file;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("document parsing", () => {
  it("includes common document, text, and image extensions", async () => {
    for (const ext of [".pdf", ".docx", ".xlsx", ".pptx", ".txt", ".md", ".csv", ".json", ".yaml", ".yml", ".png", ".jpg", ".jpeg"]) {
      expect(SUPPORTED_EXTENSIONS.has(ext)).toBe(true);
    }
    expect(isTextExtension(".txt")).toBe(true);
    expect(isTextExtension(".pdf")).toBe(false);
  });

  it("returns null for unsupported files", async () => {
    const root = tempRoot();
    const file = path.join(root, "file.xyz");
    fs.writeFileSync(file, "content", "utf8");

    expect(await extractText(file)).toBeNull();
  });

  it("returns an error string for missing files", async () => {
    expect(await extractText(path.join(tempRoot(), "nonexistent.txt"))).toContain("[error: file not found:");
  });

  it("extracts plain text files", async () => {
    const root = tempRoot();
    const file = path.join(root, "test.txt");
    fs.writeFileSync(file, "Hello, world!\nThis is a test.", "utf8");

    expect(await extractText(file)).toBe("Hello, world!\nThis is a test.");
  });

  it("truncates large text files", async () => {
    const root = tempRoot();
    const file = path.join(root, "large.txt");
    fs.writeFileSync(file, "x".repeat(300_000), "utf8");

    const result = (await extractText(file))!;

    expect(result.length).toBeLessThan(300_000);
    expect(result).toContain("(truncated,");
    expect(result).toContain("chars total)");
  });

  it("extracts markdown, csv, and json as text", async () => {
    const root = tempRoot();
    for (const [name, content] of [
      ["test.md", "# Header\n\nSome markdown content."],
      ["test.csv", "name,age\nAlice,30\nBob,25"],
      ["test.json", '{"key": "value", "number": 42}'],
    ] as const) {
      const file = path.join(root, name);
      fs.writeFileSync(file, content, "utf8");
      expect(await extractText(file)).toBe(content);
    }
  });

  it("extracts markdown files as text", async () => {
    const root = tempRoot();
    const file = path.join(root, "test.md");
    const content = "# Header\n\nSome markdown content.";
    fs.writeFileSync(file, content, "utf8");

    expect(await extractText(file)).toBe(content);
  });

  it("extracts csv files as text", async () => {
    const root = tempRoot();
    const file = path.join(root, "test.csv");
    const content = "name,age\nAlice,30\nBob,25";
    fs.writeFileSync(file, content, "utf8");

    expect(await extractText(file)).toBe(content);
  });

  it("extracts json files as text", async () => {
    const root = tempRoot();
    const file = path.join(root, "test.json");
    const content = '{"key": "value", "number": 42}';
    fs.writeFileSync(file, content, "utf8");

    expect(await extractText(file)).toBe(content);
  });

  it("extracts xlsx worksheet text", async () => {
    const xlsx = zipTree(
      {
        "xl/sharedStrings.xml": "<sst><si><t>Name</t></si><si><t>Alice</t></si><si><t>Bob</t></si></sst>",
        "xl/worksheets/sheet1.xml":
          '<worksheet><sheetData><row><c t="s"><v>0</v></c></row><row><c t="s"><v>1</v></c><c><v>30</v></c></row><row><c t="s"><v>2</v></c><c><v>25</v></c></row></sheetData></worksheet>',
        "xl/worksheets/sheet2.xml":
          '<worksheet><sheetData><row><c><v>9.99</v></c></row></sheetData></worksheet>',
      },
      "test.xlsx",
    );

    const result = (await extractText(xlsx))!;

    expect(result).toContain("--- Sheet: Sheet1 ---");
    expect(result).toContain("--- Sheet: Sheet2 ---");
    expect(result).toContain("Alice");
    expect(result).toContain("Bob");
    expect(result).toContain("9.99");
  });

  it("returns empty text for xlsx files with empty sheets", async () => {
    const xlsx = zipTree(
      {
        "xl/worksheets/sheet1.xml": "<worksheet><sheetData /></worksheet>",
      },
      "empty.xlsx",
    );

    expect(await extractText(xlsx)).toBe("");
  });

  it("extracts docx text", async () => {
    const docx = zipTree(
      {
        "word/document.xml":
          "<w:document><w:body><w:p><w:r><w:t>Test Document</w:t></w:r></w:p><w:p><w:r><w:t>This is paragraph one.</w:t></w:r></w:p><w:p><w:r><w:t>This is paragraph two.</w:t></w:r></w:p></w:body></w:document>",
      },
      "test.docx",
    );

    const result = (await extractText(docx))!;

    expect(result).toContain("Test Document");
    expect(result).toContain("This is paragraph one.");
    expect(result).toContain("This is paragraph two.");
  });

  it("returns empty text for empty docx files", async () => {
    const docx = zipTree(
      {
        "word/document.xml": "<w:document><w:body /></w:document>",
      },
      "empty.docx",
    );

    expect(await extractText(docx)).toBe("");
  });

  it("extracts pptx slide text", async () => {
    const pptx = zipTree(
      {
        "ppt/slides/slide1.xml": "<p:sld><p:cSld><p:spTree><a:t>First Slide Title</a:t></p:spTree></p:cSld></p:sld>",
        "ppt/slides/slide2.xml": "<p:sld><p:cSld><p:spTree><a:t>Bullet point content</a:t></p:spTree></p:cSld></p:sld>",
      },
      "test.pptx",
    );

    const result = (await extractText(pptx))!;

    expect(result).toContain("--- Slide 1 ---");
    expect(result).toContain("--- Slide 2 ---");
    expect(result).toContain("Bullet point content");
  });

  it("extracts pptx table cell text", async () => {
    const pptx = zipTree(
      {
        "ppt/slides/slide1.xml":
          "<p:sld><p:cSld><p:spTree><a:tbl><a:tr><a:tc><a:t>Header A</a:t></a:tc><a:tc><a:t>Header B</a:t></a:tc></a:tr><a:tr><a:tc><a:t>Alice</a:t></a:tc><a:tc><a:t>Bob</a:t></a:tc></a:tr></a:tbl></p:spTree></p:cSld></p:sld>",
      },
      "table.pptx",
    );

    const result = (await extractText(pptx))!;

    expect(result).toContain("Header A");
    expect(result).toContain("Header B");
    expect(result).toContain("Alice");
    expect(result).toContain("Bob");
  });

  it("extracts text from grouped pptx shapes", async () => {
    const pptx = zipTree(
      {
        "ppt/slides/slide1.xml": "<p:sld><p:cSld><p:spTree><p:grpSp><p:sp><a:t>Inside group</a:t></p:sp></p:grpSp></p:spTree></p:cSld></p:sld>",
      },
      "grouped.pptx",
    );

    expect(await extractText(pptx)).toContain("Inside group");
  });

  it("returns an error string for missing pdf files", async () => {
    expect(await extractText(path.join(tempRoot(), "nonexistent.pdf"))).toContain("[error: file not found:");
  });

  it("extracts real pdf pages with page markers", async () => {
    const pdf = makePdf(["First page text", "Second page text"]);

    const result = (await extractText(pdf))!;

    expect(result).toContain("--- Page 1 ---");
    expect(result).toContain("First page text");
    expect(result).toContain("--- Page 2 ---");
    expect(result).toContain("Second page text");
  });

  it("returns image placeholders", async () => {
    const root = tempRoot();
    const png = path.join(root, "test.png");
    fs.writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]));

    const result = (await extractText(png))!;

    expect(result).toContain("[image:");
    expect(result).toContain("test.png");
  });

  it("identifies known text extensions", async () => {
    for (const ext of [".txt", ".md", ".csv", ".json", ".yaml", ".yml", ".xml", ".html", ".htm"]) {
      expect(isTextExtension(ext)).toBe(true);
    }
  });

  it("rejects non-text extensions", async () => {
    for (const ext of [".pdf", ".docx", ".xlsx", ".pptx", ".png", ".xyz"]) {
      expect(isTextExtension(ext)).toBe(false);
    }
  });

  it("keeps text extension checks case-sensitive", async () => {
    expect(isTextExtension(".txt")).toBe(true);
    expect(isTextExtension(".TXT")).toBe(false);
    expect(isTextExtension(".pdf")).toBe(false);
  });
});
