import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextBuilder } from "../../../src/core/agent-runtime/context.js";
import { extractDocuments } from "../../../src/utils/document.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-context-documents-"));
  roots.push(root);
  return root;
}

function builder(root: string): ContextBuilder {
  return new ContextBuilder({ workspace: root, timezone: "UTC" });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("context builder document handling", () => {
  it("returns a string when there is no media", () => {
    const root = tempRoot();

    expect(builder(root).buildUserContent("hello", null)).toBe("hello");
  });

  it("returns image content blocks for image media", () => {
    const root = tempRoot();
    const png = path.join(root, "test.png");
    fs.writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]));

    const result = builder(root).buildUserContent("describe this", [png]);

    expect(Array.isArray(result)).toBe(true);
    const types = (result as any[]).map((block) => block.type);
    expect(types).toContain("image_url");
    expect(types).toContain("text");
  });

  it("ignores non-image media files", () => {
    const root = tempRoot();
    const txt = path.join(root, "notes.txt");
    fs.writeFileSync(txt, "some text", "utf8");

    expect(builder(root).buildUserContent("summarize", [txt])).toBe("summarize");
  });

  it("keeps only images from mixed media", () => {
    const root = tempRoot();
    const png = path.join(root, "chart.png");
    const txt = path.join(root, "report.txt");
    fs.writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]));
    fs.writeFileSync(txt, "report text", "utf8");

    const result = builder(root).buildUserContent("analyze", [png, txt]);

    expect(Array.isArray(result)).toBe(true);
    expect((result as any[]).some((block) => block.type === "image_url")).toBe(true);
    const textParts = (result as any[]).filter((block) => block.type === "text").map((block) => block.text ?? "");
    expect(textParts.every((text) => !text.includes("report text"))).toBe(true);
  });

  it("preserves document text when extraction runs before user content building", async () => {
    const root = tempRoot();
    const report = path.join(root, "report.txt");
    fs.writeFileSync(report, "Quarterly revenue is $5M", "utf8");

    const [newContent, imageOnly] = await extractDocuments("summarize", [report]);
    const result = builder(root).buildUserContent(newContent, imageOnly.length ? imageOnly : null);

    expect(result).toContain("Quarterly revenue");
    expect(result).toContain("summarize");
  });

  it("loses document text when extraction is skipped", () => {
    const root = tempRoot();
    const report = path.join(root, "report.txt");
    fs.writeFileSync(report, "Secret data in document", "utf8");

    const result = builder(root).buildUserContent("summarize", [report]);

    expect(result).toBe("summarize");
    expect(result).not.toContain("Secret data");
  });
});
