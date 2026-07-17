import { describe, expect, it } from "vitest";
import { stripInlineMediaPayloads } from "../inline-media-sanitizer.js";

describe("inline media sanitizer", () => {
  it("removes data URL media, markdown images, html img tags, and high-confidence base64 blobs", () => {
    const pngDataUrl = `data:image/png;base64,iVBORw0KGgo${"A".repeat(900)}`;
    const rawJpegBase64 = `/9j/${"ABCD+/".repeat(180)}`;
    const text = [
      "先看这个截图",
      `![screenshot](${pngDataUrl})`,
      `<img src="${pngDataUrl}" alt="screen">`,
      rawJpegBase64,
      "然后继续生成初见报告"
    ].join("\n");

    const sanitized = stripInlineMediaPayloads(text);

    expect(sanitized).toContain("先看这个截图");
    expect(sanitized).toContain("然后继续生成初见报告");
    expect(sanitized).toContain("[inline media omitted]");
    expect(sanitized).not.toContain("data:image/png;base64");
    expect(sanitized).not.toContain(rawJpegBase64);
    expect(sanitized).not.toContain("<img");
  });

  it("keeps ordinary long text that is not media-like base64", () => {
    const longText = `普通长文本 ${"x".repeat(1_500)} tail`;

    expect(stripInlineMediaPayloads(longText)).toContain("tail");
  });
});
