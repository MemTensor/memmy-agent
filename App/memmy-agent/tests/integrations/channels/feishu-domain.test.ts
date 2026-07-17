import { describe, expect, it } from "vitest";
import { FeishuChannel, FeishuConfig } from "../../../src/integrations/channels/feishu.js";

describe("Feishu domain config", () => {
  it("defaults to Feishu", () => {
    expect(new FeishuConfig().domain).toBe("feishu");
  });

  it("accepts Lark", () => {
    expect(new FeishuConfig({ domain: "lark" }).domain).toBe("lark");
  });

  it("accepts Feishu", () => {
    expect(new FeishuConfig({ domain: "feishu" }).domain).toBe("feishu");
  });

  it("includes domain in default config", () => {
    expect(FeishuChannel.defaultConfig().domain).toBe("feishu");
  });

  it("persists Lark domain on the channel", () => {
    expect(new FeishuChannel({ domain: "lark" }).config.domain).toBe("lark");
  });

  it("persists Feishu domain on the channel", () => {
    expect(new FeishuChannel({ domain: "feishu" }).config.domain).toBe("feishu");
  });
});
