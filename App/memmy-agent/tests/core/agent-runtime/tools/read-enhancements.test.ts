import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileStates,
  ReadFileTool,
  WriteFileTool,
  bindFileStates,
  checkRead,
  clear,
  recordRead,
  resetFileStates,
} from "../../../../src/core/agent-runtime/tools/index.js";

const documentMocks = vi.hoisted(() => ({
  extractText: vi.fn(),
}));

vi.mock("../../../../src/utils/document.js", async (importOriginal: () => Promise<typeof import("../../../../src/utils/document.js")>) => {
  const actual = await importOriginal();
  documentMocks.extractText.mockImplementation(actual.extractText);
  return { ...actual, extractText: documentMocks.extractText };
});

const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-read-enhanced-"));
  roots.push(root);
  return root;
}

function zipTree(tree: Record<string, string>, filename: string): string {
  const root = tmpRoot();
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

function makePdf(root: string, name: string, parts: string[]): string {
  const file = path.join(root, name);
  const escapePdfText = (text: string) => text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${parts.map((_, index) => `${3 + index * 2} 0 R`).join(" ")}] /Count ${parts.length} >>`;
  const fontObj = 3 + parts.length * 2;
  parts.forEach((part, index) => {
    const pageObj = 3 + index * 2;
    const contentObj = 4 + index * 2;
    const stream = `BT /F1 24 Tf 72 720 Td (${escapePdfText(part)}) Tj ET`;
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
  clear();
  documentMocks.extractText.mockClear();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ReadFileTool enhanced behavior", () => {
  it("mentions image support in its description", () => {
    expect(new ReadFileTool().description.toLowerCase()).toContain("image");
  });

  it("does not claim images cannot be read", () => {
    expect(new ReadFileTool().description.toLowerCase()).not.toContain("cannot read binary files or images");
  });

  it("returns an unchanged stub on a repeated read", async () => {
    const root = tmpRoot();
    const target = path.join(root, "data.txt");
    fs.writeFileSync(target, [...Array(100).keys()].map((i) => `line ${i}`).join("\n"), "utf8");
    const tool = new ReadFileTool({ workspace: root });
    const first = await tool.execute({ path: target });
    const second = await tool.execute({ path: target });
    expect(first).toContain("line 0");
    expect(second.toLowerCase()).toContain("unchanged");
    expect(second).not.toContain("line 0");
  });

  it("returns full content after external modification", async () => {
    const root = tmpRoot();
    const target = path.join(root, "data.txt");
    fs.writeFileSync(target, "original", "utf8");
    const tool = new ReadFileTool({ workspace: root });
    await tool.execute({ path: target });
    fs.writeFileSync(target, "modified content", "utf8");
    expect(await tool.execute({ path: target })).toContain("modified content");
  });

  it("returns full content for a different offset", async () => {
    const root = tmpRoot();
    const target = path.join(root, "data.txt");
    fs.writeFileSync(target, [...Array(20).keys()].map((i) => `line ${i + 1}`).join("\n"), "utf8");
    const tool = new ReadFileTool({ workspace: root });
    await tool.execute({ path: target, offset: 1, limit: 5 });
    expect(await tool.execute({ path: target, offset: 6, limit: 5 })).toContain("line 6");
  });

  it("returns full content on the first read after write_file", async () => {
    const root = tmpRoot();
    const target = path.join(root, "fresh.txt");
    const writeResult = await new WriteFileTool({ workspace: root }).execute({ path: target, content: "hello" });
    const readResult = await new ReadFileTool({ workspace: root }).execute({ path: target });
    expect(writeResult).toContain("Successfully");
    expect(readResult).toContain("hello");
    expect(readResult.toLowerCase()).not.toContain("unchanged");
  });

  it("does not deduplicate image reads", async () => {
    const root = tmpRoot();
    const image = path.join(root, "img.png");
    fs.writeFileSync(image, Buffer.from("\x89PNG\r\n\x1a\nfake-png-data"));
    const tool = new ReadFileTool({ workspace: root });
    expect(Array.isArray(await tool.execute({ path: image }))).toBe(true);
    expect(Array.isArray(await tool.execute({ path: image }))).toBe(true);
  });

  it("keeps read-dedup state isolated across tool instances", async () => {
    const root = tmpRoot();
    const target = path.join(root, "shared.txt");
    fs.writeFileSync(target, [...Array(10).keys()].map((i) => `line ${i}`).join("\n"), "utf8");
    const first = await new ReadFileTool({ workspace: root }).execute({ path: target });
    const second = await new ReadFileTool({ workspace: root }).execute({ path: target });
    expect(first).toContain("line 0");
    expect(second.toLowerCase()).not.toContain("unchanged");
    expect(second).toContain("line 0");
  });

  it("uses bound FileStates for a shared loop tool", async () => {
    const root = tmpRoot();
    const target = path.join(root, "shared.txt");
    fs.writeFileSync(target, [...Array(10).keys()].map((i) => `line ${i}`).join("\n"), "utf8");
    const sharedTool = new ReadFileTool({ workspace: root });
    const sessionA = new FileStates();
    const sessionB = new FileStates();

    let first = "";
    let repeat = "";
    let token = bindFileStates(sessionA);
    try {
      first = await sharedTool.execute({ path: target });
      repeat = await sharedTool.execute({ path: target });
    } finally {
      resetFileStates(token);
    }

    token = bindFileStates(sessionB);
    let secondSessionRead = "";
    try {
      secondSessionRead = await sharedTool.execute({ path: target });
    } finally {
      resetFileStates(token);
    }

    expect(first).toContain("line 0");
    expect(repeat.toLowerCase()).toContain("unchanged");
    expect(secondSessionRead.toLowerCase()).not.toContain("unchanged");
    expect(secondSessionRead).toContain("line 0");
  });

  it("reads text content from PDFs", async () => {
    const root = tmpRoot();
    const pdf = makePdf(root, "test.pdf", ["Hello PDF World"]);
    expect(await new ReadFileTool({ workspace: root }).execute({ path: pdf })).toContain("Hello PDF World");
  });

  it("honors the PDF pages parameter", async () => {
    const root = tmpRoot();
    const pdf = makePdf(root, "multi.pdf", [
      "Page 1 content",
      "Page 2 content",
      "Page 3 content",
      "Page 4 content",
    ]);
    const result = await new ReadFileTool({ workspace: root }).execute({ path: pdf, pages: "2-3" });
    expect(result).toContain("Page 2 content");
    expect(result).toContain("Page 3 content");
    expect(result).not.toContain("Page 1 content");
  });

  it("reports missing PDF files", async () => {
    const root = tmpRoot();
    const result = await new ReadFileTool({ workspace: root }).execute({ path: path.join(root, "nope.pdf") });
    expect(result).toContain("Error");
    expect(result.toLowerCase()).toContain("not found");
  });

  it("blocks /dev/random", async () => {
    const result = await new ReadFileTool().execute({ path: "/dev/random" });
    expect(result).toContain("Error");
    expect(result.toLowerCase()).toMatch(/blocked|device/);
  });

  it("blocks /dev/urandom", async () => {
    expect(await new ReadFileTool().execute({ path: "/dev/urandom" })).toContain("Error");
  });

  it("blocks /dev/zero", async () => {
    expect(await new ReadFileTool().execute({ path: "/dev/zero" })).toContain("Error");
  });

  it("blocks /proc fd paths", async () => {
    expect(await new ReadFileTool().execute({ path: "/proc/self/fd/0" })).toContain("Error");
  });

  it("blocks symlinks to device paths", async () => {
    const root = tmpRoot();
    const link = path.join(root, "zero-link");
    fs.symlinkSync("/dev/zero", link);
    const result = await new ReadFileTool({ workspace: root }).execute({ path: link });
    expect(result).toContain("Error");
    expect(result.toLowerCase()).toMatch(/blocked|device/);
  });

  it("warns when content changes but mtime is unchanged", () => {
    const root = tmpRoot();
    const target = path.join(root, "data.txt");
    fs.writeFileSync(target, "original", "utf8");
    recordRead(target);
    const originalMtime = fs.statSync(target).mtime;
    fs.writeFileSync(target, "modified", "utf8");
    fs.utimesSync(target, originalMtime, originalMtime);
    const warning = checkRead(target);
    expect(warning).toContain("modified");
  });

  it("does not warn when content and mtime are unchanged", () => {
    const root = tmpRoot();
    const target = path.join(root, "data.txt");
    fs.writeFileSync(target, "stable", "utf8");
    recordRead(target);
    expect(checkRead(target)).toBeNull();
  });

  it("normalizes CRLF text output to LF", async () => {
    const root = tmpRoot();
    const target = path.join(root, "crlf.txt");
    fs.writeFileSync(target, "alpha\r\nbeta\r\ngamma\r\n", "utf8");
    const result = await new ReadFileTool({ workspace: root }).execute({ path: target });
    expect(result).not.toContain("\r");
    expect(result).toContain("alpha");
    expect(result).toContain("beta");
    expect(result).toContain("gamma");
  });

  it("preserves LF-only text output", async () => {
    const root = tmpRoot();
    const target = path.join(root, "lf.txt");
    fs.writeFileSync(target, "alpha\nbeta\ngamma\n", "utf8");
    const result = await new ReadFileTool({ workspace: root }).execute({ path: target });
    expect(result).not.toContain("\r");
    expect(result).toContain("alpha");
    expect(result).toContain("beta");
    expect(result).toContain("gamma");
  });

  it("extracts text from DOCX files", async () => {
    const docx = zipTree(
      { "word/document.xml": "<w:document><w:body><w:p><w:r><w:t>Title</w:t></w:r></w:p><w:p><w:r><w:t>Paragraph 1</w:t></w:r></w:p></w:body></w:document>" },
      "test.docx",
    );
    const result = await new ReadFileTool({ workspace: path.dirname(docx) }).execute({ path: docx });
    expect(result).toContain("Title");
    expect(result).toContain("Paragraph 1");
    expect(result).not.toContain("Error");
  });

  it("extracts text from XLSX files", async () => {
    const xlsx = zipTree(
      {
        "xl/sharedStrings.xml": "<sst><si><t>Name</t></si><si><t>Alice</t></si></sst>",
        "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row><c t="s"><v>0</v></c></row><row><c t="s"><v>1</v></c><c><v>30</v></c></row></sheetData></worksheet>',
      },
      "test.xlsx",
    );
    const result = await new ReadFileTool({ workspace: path.dirname(xlsx) }).execute({ path: xlsx });
    expect(result).toContain("Sheet1");
    expect(result).toContain("Alice\t30");
  });

  it("extracts text from PPTX files", async () => {
    const pptx = zipTree(
      { "ppt/slides/slide1.xml": "<p:sld><p:cSld><p:spTree><a:t>Welcome</a:t><a:t>Content</a:t></p:spTree></p:cSld></p:sld>" },
      "test.pptx",
    );
    const result = await new ReadFileTool({ workspace: path.dirname(pptx) }).execute({ path: pptx });
    expect(result).toContain("Welcome");
    expect(result).toContain("Content");
  });

  it("surfaces DOCX missing-library errors", async () => {
    documentMocks.extractText.mockReturnValueOnce("[error: DOCX parser not installed]");
    const root = tmpRoot();
    const file = path.join(root, "test.docx");
    fs.writeFileSync(file, "PK", "utf8");
    const result = await new ReadFileTool({ workspace: root }).execute({ path: file });
    expect(result).toContain("Error");
    expect(result).toContain("DOCX parser not installed");
  });

  it("surfaces corrupt DOCX extraction errors", async () => {
    const root = tmpRoot();
    const file = path.join(root, "test.docx");
    fs.writeFileSync(file, "not-a-zip", "utf8");
    const result = await new ReadFileTool({ workspace: root }).execute({ path: file });
    expect(result).toContain("Error");
    expect(result).toContain("failed to extract DOCX");
  });

  it("reports unsupported document extraction results", async () => {
    documentMocks.extractText.mockReturnValueOnce(null);
    const root = tmpRoot();
    const file = path.join(root, "test.docx");
    fs.writeFileSync(file, "PK", "utf8");
    const result = await new ReadFileTool({ workspace: root }).execute({ path: file });
    expect(result).toContain("Error");
    expect(result).toContain("Unsupported");
  });

  it("describes empty extracted documents", async () => {
    documentMocks.extractText.mockReturnValueOnce("");
    const root = tmpRoot();
    const file = path.join(root, "empty.docx");
    fs.writeFileSync(file, "PK", "utf8");
    expect(await new ReadFileTool({ workspace: root }).execute({ path: file })).toContain("no extractable text");
  });

  it("truncates large extracted documents", async () => {
    documentMocks.extractText.mockReturnValueOnce("x".repeat(200_000));
    const root = tmpRoot();
    const file = path.join(root, "large.docx");
    fs.writeFileSync(file, "PK", "utf8");
    const result = await new ReadFileTool({ workspace: root }).execute({ path: file });
    expect(result.length).toBeLessThanOrEqual(ReadFileTool.MAX_CHARS + 100);
    expect(result).toContain("truncated at ~128K chars");
  });

  it("does not truncate small extracted documents", async () => {
    documentMocks.extractText.mockReturnValueOnce("Hello world");
    const root = tmpRoot();
    const file = path.join(root, "small.docx");
    fs.writeFileSync(file, "PK", "utf8");
    const result = await new ReadFileTool({ workspace: root }).execute({ path: file });
    expect(result).not.toContain("truncated");
    expect(result).toContain("Hello world");
  });

  it("does not truncate document error responses", async () => {
    documentMocks.extractText.mockReturnValueOnce("[error: failed to extract DOCX: something went wrong]");
    const root = tmpRoot();
    const file = path.join(root, "bad.docx");
    fs.writeFileSync(file, "PK", "utf8");
    const result = await new ReadFileTool({ workspace: root }).execute({ path: file });
    expect(result).toContain("Error");
    expect(result).not.toContain("truncated");
  });

  it("mentions document support in its description", () => {
    const description = new ReadFileTool().description.toLowerCase();
    expect(description.includes("document") || description.includes("docx") || description.includes("xlsx") || description.includes("pptx")).toBe(true);
  });

  it("does not say it cannot read supported file types", () => {
    expect(new ReadFileTool().description.toLowerCase()).not.toContain("cannot read");
  });
});
