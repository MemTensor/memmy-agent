import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextBuilder } from "../../../src/core/agent-runtime/context.js";

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

  it("generates an attachments manifest for non-image files instead of extracting text", () => {
    const root = tempRoot();
    const txt = path.join(root, "notes.txt");
    fs.writeFileSync(txt, "some text content", "utf8");

    const result = builder(root).buildUserContent("summarize", [txt]);

    // Should return an array with a text block containing the attachment manifest
    expect(Array.isArray(result)).toBe(true);
    const textBlocks = (result as any[]).filter((b) => b.type === "text");
    expect(textBlocks.length).toBeGreaterThan(0);
    const combined = textBlocks.map((b: any) => b.text ?? "").join("\n");
    expect(combined).toContain("notes.txt");
    expect(combined).toContain("<attachments>");
    expect(combined).not.toContain("some text content");
  });

  it("includes attachment manifest alongside images for mixed media", () => {
    const root = tempRoot();
    const png = path.join(root, "chart.png");
    const txt = path.join(root, "report.txt");
    fs.writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]));
    fs.writeFileSync(txt, "report text", "utf8");

    const result = builder(root).buildUserContent("analyze", [png, txt]);

    expect(Array.isArray(result)).toBe(true);
    expect((result as any[]).some((block) => block.type === "image_url")).toBe(true);
    const textParts = (result as any[]).filter((block) => block.type === "text").map((block: any) => block.text ?? "");
    const combined = textParts.join("\n");
    expect(combined).toContain("report.txt");
    expect(combined).not.toContain("report text");
  });

  it("includes the original user text alongside the attachment manifest", () => {
    const root = tempRoot();
    const report = path.join(root, "report.txt");
    fs.writeFileSync(report, "Quarterly revenue is $5M", "utf8");

    const result = builder(root).buildUserContent("summarize this", [report]);

    expect(Array.isArray(result)).toBe(true);
    const textParts = (result as any[]).filter((b: any) => b.type === "text").map((b: any) => b.text ?? "");
    const combined = textParts.join("\n");
    expect(combined).toContain("summarize this");
    expect(combined).toContain("report.txt");
    expect(combined).not.toContain("Quarterly revenue");
  });

  it("document text is not present in user content (model reads via read_file tool)", () => {
    const root = tempRoot();
    const report = path.join(root, "report.txt");
    fs.writeFileSync(report, "Secret data in document", "utf8");

    const result = builder(root).buildUserContent("summarize", [report]);

    const asString = JSON.stringify(result);
    expect(asString).not.toContain("Secret data");
  });
});
