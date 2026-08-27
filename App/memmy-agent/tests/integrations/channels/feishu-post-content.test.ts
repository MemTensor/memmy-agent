import { describe, expect, it } from "vitest";
import { FeishuChannel, extractPostContent } from "../../../src/integrations/channels/feishu.js";

describe("Feishu post content", () => {
  it("extracts post content from the post wrapper shape", () => {
    expect(
      extractPostContent({
        post: { zh_cn: { title: "日报", content: [[{ tag: "text", text: "完成" }, { tag: "img", image_key: "img_1" }]] } },
      }),
    ).toEqual(["日报 完成", ["img_1"]]);
  });

  it("keeps direct shape behavior", () => {
    expect(
      extractPostContent({
        title: "Daily",
        content: [[{ tag: "text", text: "report" }, { tag: "img", image_key: "img_a" }, { tag: "img", image_key: "img_b" }]],
      }),
    ).toEqual(["Daily report", ["img_a", "img_b"]]);
  });

  it("keeps the builder when an optional event method is missing", () => {
    const builder = {};
    const handler = {};

    expect(FeishuChannel.registerOptionalEvent(builder, "missing", handler)).toBe(builder);
  });

  it("calls supported optional event methods", () => {
    const called: any[] = [];
    const builder = {
      register_event: (handler: any) => {
        called.push(handler);
        return builder;
      },
    };
    const handler = {};

    expect(FeishuChannel.registerOptionalEvent(builder, "register_event", handler)).toBe(builder);
    expect(called).toEqual([handler]);
  });
});
