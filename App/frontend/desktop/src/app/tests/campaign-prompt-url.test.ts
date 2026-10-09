import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCampaignActivityUrl } from "../campaign-prompt-url.js";

beforeEach(() => {
  vi.stubEnv("MEMMY_APP_EDITION", "cn");
  vi.stubEnv("MEMMY_LEGAL_CN_BASE_URL", "https://test.memmy.cn");
  vi.stubEnv("MEMMY_LEGAL_INTL_BASE_URL", "https://test.memmy.bot");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getCampaignActivityUrl", () => {
  it("uses the CN activity path and language prefix", () => {
    expect(getCampaignActivityUrl("zh-CN")).toBe("https://test.memmy.cn/activity/");
    expect(getCampaignActivityUrl("en-US")).toBe("https://test.memmy.cn/en/activity/");
  });

  it("uses the intl activity path and language prefix", () => {
    vi.stubEnv("MEMMY_APP_EDITION", "intl");
    expect(getCampaignActivityUrl("en-US")).toBe("https://test.memmy.bot/activity/");
    expect(getCampaignActivityUrl("zh-CN")).toBe("https://test.memmy.bot/cn/activity/");
  });
});
