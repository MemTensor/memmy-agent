import { describe, expect, it } from "vitest";
import { FeishuChannel } from "../../../src/integrations/channels/feishu.js";

describe("Feishu media filename security", () => {
  it("sanitizes downloaded media filenames to local basenames", () => {
    expect(FeishuChannel.safeMediaFilename("../escaped.txt", "fallback.bin")).toBe("escaped.txt");
    expect(FeishuChannel.safeMediaFilename("..\\evil?.png", "fallback.bin")).toContain("_evil_.png");
    expect(FeishuChannel.safeMediaFilename("", "fallback.bin")).toBe("fallback.bin");
  });
});
