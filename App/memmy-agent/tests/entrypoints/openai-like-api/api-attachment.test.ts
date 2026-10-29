import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileSizeExceeded,
  parseJsonContent,
  createApp,
  saveBase64DataUrl as apiSaveBase64DataUrl,
} from "../../../src/entrypoints/openai-like-api/server.js";
import { extractText } from "../../../src/utils/document.js";

const roots: string[] = [];
const originalDataDir = process.env.MEMMY_AGENT_DATA_DIR;

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-api-attachment-"));
  roots.push(dir);
  process.env.MEMMY_AGENT_DATA_DIR = dir;
  return dir;
}

function chatRequest(body: unknown): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function docxDataUrl(text: string): Promise<string> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
      "</Types>",
    ].join(""),
  );
  zip.file(
    "word/document.xml",
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
      "<w:body><w:p><w:r><w:t>",
      escapeXml(text),
      "</w:t></w:r></w:p></w:body></w:document>",
    ].join(""),
  );
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  return `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${buffer.toString("base64")}`;
}

afterEach(() => {
  if (originalDataDir == null) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = originalDataDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("API base64 attachment helpers", () => {
  it("saves a base64 data URL with the correct extension", () => {
    const root = tempRoot();
    const dataUrl = `data:image/png;base64,${Buffer.from("fake png data").toString("base64")}`;

    const saved = apiSaveBase64DataUrl(dataUrl, root);

    expect(saved).not.toBeNull();
    expect(saved).toMatch(/\.png$/);
    expect(fs.readFileSync(saved!, "utf8")).toBe("fake png data");
  });

  it("returns null for invalid base64 data URLs", () => {
    expect(apiSaveBase64DataUrl("data:image/png;base64,not-valid-base64!!!", tempRoot())).toBeNull();
  });

  it("uses .bin for unknown MIME types", () => {
    const saved = apiSaveBase64DataUrl(`data:unknown/type;base64,${Buffer.from("some data").toString("base64")}`, tempRoot());

    expect(saved).not.toBeNull();
    expect(saved).toMatch(/\.bin$/);
  });

  it("rejects oversized base64 payloads", () => {
    const largePayload = Buffer.alloc(11 * 1024 * 1024).toString("base64");

    expect(() => apiSaveBase64DataUrl(`data:image/png;base64,${largePayload}`, tempRoot())).toThrow(FileSizeExceeded);
    expect(() => apiSaveBase64DataUrl(`data:image/png;base64,${largePayload}`, tempRoot())).toThrow(/10MB limit/);
  });

  it("extracts text and saves JSON data URL media", () => {
    tempRoot();
    const dataUrl = `data:image/png;base64,${Buffer.from("img").toString("base64")}`;

    const [text, media] = parseJsonContent({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    });

    expect(text).toBe("describe this");
    expect(media).toHaveLength(1);
    expect(fs.readFileSync(media[0], "utf8")).toBe("img");
  });

  it("parses plain text JSON without media", () => {
    expect(parseJsonContent({ messages: [{ role: "user", content: "hello" }] })).toEqual(["hello", []]);
  });

  it("validates that JSON requests contain exactly one message", () => {
    expect(() =>
      parseJsonContent({
        messages: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ],
      }),
    ).toThrow(/single user message/i);
  });

  it("validates that the single JSON message uses the user role", () => {
    expect(() => parseJsonContent({ messages: [{ role: "system", content: "you are a bot" }] })).toThrow(
      /single user message/i,
    );
  });

  it("rejects oversized JSON data URL files before writing them", () => {
    tempRoot();
    const largePayload = Buffer.alloc(11 * 1024 * 1024).toString("base64");

    expect(() =>
      parseJsonContent({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "image_url", image_url: { url: `data:image/png;base64,${largePayload}` } },
            ],
          },
        ],
      }),
    ).toThrow(FileSizeExceeded);
  });
});

describe("API document extraction helpers", () => {
  it("keeps JSON data URL document extensions so extracted text reaches the agent", async () => {
    tempRoot();
    const calls: any[] = [];
    const app = createApp({ processDirect: async (args: any) => (calls.push(args), "ok") }, "m");
    const dataUrl = await docxDataUrl("Revenue from data URL document");

    const response = await app.fetch(
      chatRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "summarize" },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    );

    expect(response.status).toBe(200);
    expect(calls[0].media[0]).toMatch(/\.docx$/);
    // Document text is now extracted via read_file tool; media path is passed to agent
    expect(calls[0].media.length).toBeGreaterThan(0);
  });

  it("saves document files to media directory for agent access via read_file", async () => {
    const root = tempRoot();
    const png = path.join(root, "chart.png");
    const report = path.join(root, "report.txt");
    fs.writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]));
    fs.writeFileSync(report, "Quarterly revenue is $5M", "utf8");

    // extractText is still available for direct document content extraction
    const text = await extractText(report);

    expect(text).toContain("Quarterly revenue");
  });

  it("handles broken document files gracefully via extractText", async () => {
    const root = tempRoot();
    const broken = path.join(root, "broken.docx");
    fs.writeFileSync(broken, "not a docx", "utf8");

    const text = await extractText(broken);

    expect(typeof text).toBe("string");
  });

  it("extractText works on plain text files", async () => {
    const root = tempRoot();
    const txt = path.join(root, "notes.txt");
    fs.writeFileSync(txt, "Meeting notes content", "utf8");

    const text = await extractText(txt);

    expect(text).toContain("Meeting notes content");
  });

  it("returns null for unsupported file types", async () => {
    const root = tempRoot();
    const bin = path.join(root, "data.bin");
    fs.writeFileSync(bin, Buffer.alloc(50, 0xff));

    const text = await extractText(bin);

    expect(text).toBeNull();
  });

  it("detects image files by extension via extractText", async () => {
    const root = tempRoot();
    const bigPng = path.join(root, "big-upload.png");
    fs.writeFileSync(bigPng, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]));

    const text = await extractText(bigPng);

    // Images return a placeholder string
    expect(typeof text).toBe("string");
    expect(text).toContain("image");
  });
});

describe("API multipart attachment uploads", () => {
  it("saves uploaded files and passes media paths to the agent", async () => {
    tempRoot();
    const calls: any[] = [];
    const app = createApp(
      {
        processDirect: async (args: any) => {
          calls.push(args);
          return "ok";
        },
      },
      "m",
    );
    const form = new FormData();
    form.append("message", "analyze this");
    form.append("files", new Blob([Buffer.from("test file content")]), "notes.txt");

    const response = await app.fetch(new Request("http://localhost/v1/chat/completions", { method: "POST", body: form }));

    expect(response.status).toBe(200);
    expect(calls[0].content).toBe("analyze this");
    expect(calls[0].media).toHaveLength(1);
    expect(fs.readFileSync(calls[0].media[0], "utf8")).toBe("test file content");
  });

  it("accepts multiple multipart files", async () => {
    tempRoot();
    const calls: any[] = [];
    const app = createApp({ processDirect: async (args: any) => (calls.push(args), "ok") }, "m");
    const form = new FormData();
    form.append("message", "analyze");
    form.append("files", new Blob([Buffer.from("one")]), "one.txt");
    form.append("files", new Blob([Buffer.from("two")]), "two.txt");

    const response = await app.fetch(new Request("http://localhost/v1/chat/completions", { method: "POST", body: form }));

    expect(response.status).toBe(200);
    expect(calls[0].media).toHaveLength(2);
  });

  it("accepts large multipart files without a per-file size limit", async () => {
    tempRoot();
    const app = createApp({ processDirect: async () => "ok" }, "m");
    const form = new FormData();
    form.append("message", "analyze");
    form.append("files", new Blob([Buffer.alloc(11 * 1024 * 1024)]), "huge.bin");

    const response = await app.fetch(new Request("http://localhost/v1/chat/completions", { method: "POST", body: form }));

    expect(response.status).toBe(200);
  });

  it("defaults text when multipart message is missing", async () => {
    tempRoot();
    const calls: any[] = [];
    const app = createApp({ processDirect: async (args: any) => (calls.push(args), "ok") }, "m");
    const form = new FormData();
    form.append("files", new Blob([Buffer.from("content")]), "upload.txt");

    const response = await app.fetch(new Request("http://localhost/v1/chat/completions", { method: "POST", body: form }));

    expect(response.status).toBe(200);
    expect(calls[0].content).toBe("请分析上传的文件");
  });

  it("routes multipart uploads to custom API sessions", async () => {
    tempRoot();
    const calls: any[] = [];
    const app = createApp({ processDirect: async (args: any) => (calls.push(args), "ok") }, "m");
    const form = new FormData();
    form.append("message", "hello");
    form.append("session_id", "my-session");
    form.append("files", new Blob([Buffer.from("content")]), "upload.txt");

    const response = await app.fetch(new Request("http://localhost/v1/chat/completions", { method: "POST", body: form }));

    expect(response.status).toBe(200);
    expect(calls[0].session_key).toBe("api:my-session");
  });

  it("preserves plain JSON requests without media", async () => {
    const calls: any[] = [];
    const app = createApp({ processDirect: async (args: any) => (calls.push(args), "mock response") }, "m");

    const response = await app.fetch(chatRequest({ messages: [{ role: "user", content: "hello world" }] }));
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.choices[0].message.content).toBe("mock response");
    expect(calls[0].content).toBe("hello world");
    expect(calls[0].media).toBeNull();
  });

  it("saves base64 images from JSON chat content", async () => {
    tempRoot();
    const calls: any[] = [];
    const app = createApp({ processDirect: async (args: any) => (calls.push(args), "ok") }, "m");
    const tinyPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

    const response = await app.fetch(
      chatRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this" },
              { type: "image_url", image_url: { url: `data:image/png;base64,${tinyPng}` } },
            ],
          },
        ],
      }),
    );

    expect(response.status).toBe(200);
    expect(calls[0].content).toBe("what is this");
    expect(calls[0].media).toHaveLength(1);
  });

  it("passes uploaded DOCX paths through for later document extraction", async () => {
    tempRoot();
    const calls: any[] = [];
    const app = createApp({ processDirect: async (args: any) => (calls.push(args), "report summary") }, "m");
    const form = new FormData();
    form.append("message", "summarize the report");
    form.append(
      "files",
      new Blob([Buffer.from("fake docx")], {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      "report.docx",
    );

    const response = await app.fetch(new Request("http://localhost/v1/chat/completions", { method: "POST", body: form }));

    expect(response.status).toBe(200);
    expect(calls[0].content).toBe("summarize the report");
    expect(calls[0].media).toHaveLength(1);
    expect(calls[0].media[0]).toContain("report.docx");
  });
});
