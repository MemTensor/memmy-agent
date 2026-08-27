/** Contracts endpoints tests. */
import { describe, expect, it } from "vitest";
import { LEGAL_PAGE_PATH, legalPageUrl } from "@memmy/local-api-contracts";

describe("legalPageUrl", () => {
  it("按契约拼接 type 与 lang 查询参数", () => {
    expect(legalPageUrl("https://gw.example.cn", "terms", "zh-CN")).toBe(
      "https://gw.example.cn/api/memmy/desktop/legal/page?type=terms&lang=zh-CN"
    );
    expect(legalPageUrl("https://gw2.example.cn", "data", "en-US")).toBe(
      "https://gw2.example.cn/api/memmy/desktop/legal/page?type=data&lang=en-US"
    );
  });

  it("使用契约约定的协议页路径", () => {
    expect(legalPageUrl("https://x", "terms", "zh-CN")).toContain(LEGAL_PAGE_PATH);
  });

  it("对 lang 做 URL 编码", () => {
    expect(legalPageUrl("https://x", "terms", "zh-CN")).toContain(`lang=${encodeURIComponent("zh-CN")}`);
  });

  it("terms 与 data、zh-CN 与 en-US 拼出的 URL 互不相同", () => {
    const base = "https://x";
    expect(legalPageUrl(base, "terms", "zh-CN")).not.toBe(legalPageUrl(base, "data", "zh-CN"));
    expect(legalPageUrl(base, "terms", "zh-CN")).not.toBe(legalPageUrl(base, "terms", "en-US"));
  });
});
