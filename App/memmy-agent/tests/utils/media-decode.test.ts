import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileSizeExceeded as ApiFileSizeExceeded,
  MAX_FILE_SIZE as API_MAX_FILE_SIZE,
  saveBase64DataUrl as apiSaveBase64DataUrl,
} from "../../src/entrypoints/openai-like-api/server.js";
import {
  DEFAULT_MAX_BYTES,
  FileSizeExceeded,
  MAX_FILE_SIZE,
  saveBase64DataUrl,
} from "../../src/utils/media-decode.js";

function dataUrl(payload: Buffer, mime = "image/png"): string {
  return `data:${mime};base64,${payload.toString("base64")}`;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memmy-media-decode-"));
}

describe("saveBase64DataUrl", () => {
  it("saves PNG data with the correct extension", () => {
    const dir = tempDir();
    const result = saveBase64DataUrl(dataUrl(Buffer.from("fake png")), dir);
    expect(result).not.toBeNull();
    expect(result).toMatch(/\.png$/);
    expect(fs.readFileSync(result!, "utf8")).toBe("fake png");
  });

  it("returns null for malformed data URLs", () => {
    const dir = tempDir();
    expect(saveBase64DataUrl("not-a-data-url", dir)).toBeNull();
  });

  it("returns null for broken base64", () => {
    const dir = tempDir();
    expect(saveBase64DataUrl("data:image/png;base64,not-valid-base64!!!", dir)).toBeNull();
  });

  it("falls back to .bin for unknown MIME types", () => {
    expect(saveBase64DataUrl(dataUrl(Buffer.from("xyz"), "unknown/type"), tempDir())).toMatch(/\.bin$/);
  });

  it("preserves OpenXML document extensions from data URL MIME types", () => {
    const cases = [
      ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
      ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
      ["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
    ];

    for (const [mime, ext] of cases) {
      expect(saveBase64DataUrl(dataUrl(Buffer.from("document"), mime), tempDir())).toMatch(new RegExp(`\\${ext}$`));
    }
  });

  it("uses a 10MB default limit", () => {
    expect(DEFAULT_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_FILE_SIZE).toBe(10 * 1024 * 1024);
    expect(() => saveBase64DataUrl(dataUrl(Buffer.alloc(11 * 1024 * 1024)), tempDir())).toThrow(/10MB limit/);
  });

  it("supports explicit max byte overrides", () => {
    expect(() => saveBase64DataUrl(dataUrl(Buffer.alloc(9 * 1024 * 1024)), tempDir(), { maxBytes: 8 * 1024 * 1024 })).toThrow(
      /8MB limit/,
    );
  });

  it("saves files under the media directory", () => {
    const dir = tempDir();
    expect(saveBase64DataUrl(dataUrl(Buffer.from("ok")), dir)?.startsWith(dir)).toBe(true);
  });

  it("re-exports API server media helpers", () => {
    expect(apiSaveBase64DataUrl).toBe(saveBase64DataUrl);
    expect(ApiFileSizeExceeded).toBe(FileSizeExceeded);
    expect(API_MAX_FILE_SIZE).toBe(MAX_FILE_SIZE);
  });
});
