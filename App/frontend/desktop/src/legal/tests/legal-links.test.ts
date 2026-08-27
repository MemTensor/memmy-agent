import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateLegalEnv } from "../../../vite.config.js";
import { getLegalLinkUrl, type LegalAgreementUrls, type LegalDocumentKind } from "../legal-links.js";
import type { ResolvedLanguage } from "../../i18n/messages.js";

const kinds: LegalDocumentKind[] = ["terms", "data"];
const languages: ResolvedLanguage[] = ["zh-CN", "en-US"];

const remoteLegal: LegalAgreementUrls = {
  terms: {
    "zh-CN": "https://legacy.example.cn/terms",
    "en-US": "https://legacy.example.cn/terms/en"
  },
  data: {
    "zh-CN": "https://legacy.example.cn/data",
    "en-US": "https://legacy.example.cn/data/en"
  }
};

beforeEach(() => {
  vi.stubEnv("MEMMY_APP_EDITION", "cn");
  vi.stubEnv("MEMMY_ACCOUNT_CHANNEL", "phone");
  vi.stubEnv("MEMMY_LEGAL_CN_BASE_URL", "https://test.memmy.cn");
  vi.stubEnv("MEMMY_LEGAL_INTL_BASE_URL", "https://test.memmy.bot");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getLegalLinkUrl", () => {
  it.each([
    ["cn", "email", "https://test.memmy.cn"],
    ["intl", "phone", "https://test.memmy.bot"]
  ] as const)("%s 包使用对应版本的协议域名且不依赖登录通道", (edition, channel, baseUrl) => {
    vi.stubEnv("MEMMY_APP_EDITION", edition);
    vi.stubEnv("MEMMY_ACCOUNT_CHANNEL", channel);

    for (const kind of kinds) {
      for (const language of languages) {
        const documentPath = kind === "data" ? "privacy" : "terms";
        const languagePath = language === "en-US" ? "en/" : "";
        expect(getLegalLinkUrl(kind, language)).toBe(`${baseUrl}/${documentPath}/${languagePath}`);
      }
    }
  });

  it("正式环境直接使用 env 中配置的两个正式域名", () => {
    vi.stubEnv("MEMMY_LEGAL_CN_BASE_URL", "https://memmy.cn/");
    vi.stubEnv("MEMMY_LEGAL_INTL_BASE_URL", "https://memmy.bot/");

    expect(getLegalLinkUrl("terms", "zh-CN")).toBe("https://memmy.cn/terms/");
    vi.stubEnv("MEMMY_APP_EDITION", "intl");
    expect(getLegalLinkUrl("data", "en-US")).toBe("https://memmy.bot/privacy/en/");
  });

  it("后端旧地址不能覆盖当前包配置的协议地址", () => {
    expect(getLegalLinkUrl("terms", "zh-CN", remoteLegal)).toBe("https://test.memmy.cn/terms/");
  });

  it("当前版本对应的地址缺失时直接报错", () => {
    vi.stubEnv("MEMMY_LEGAL_CN_BASE_URL", "");
    expect(() => getLegalLinkUrl("terms", "zh-CN")).toThrow(/MEMMY_LEGAL_CN_BASE_URL/);
  });

  it("本地未通过打包脚本指定版本时默认使用国内地址", () => {
    vi.stubEnv("MEMMY_APP_EDITION", "");
    expect(getLegalLinkUrl("terms", "zh-CN")).toBe("https://test.memmy.cn/terms/");
  });
});

describe("validateLegalEnv", () => {
  const validEnv = {
    MEMMY_LEGAL_CN_BASE_URL: "https://test.memmy.cn",
    MEMMY_LEGAL_INTL_BASE_URL: "https://test.memmy.bot"
  };

  it("接受两个合法的 HTTPS 地址", () => {
    expect(() => validateLegalEnv(validEnv)).not.toThrow();
  });

  it.each([
    [{ ...validEnv, MEMMY_LEGAL_CN_BASE_URL: "" }, "MEMMY_LEGAL_CN_BASE_URL"],
    [{ ...validEnv, MEMMY_LEGAL_INTL_BASE_URL: "not-a-url" }, "MEMMY_LEGAL_INTL_BASE_URL"],
    [{ ...validEnv, MEMMY_LEGAL_CN_BASE_URL: "http://memmy.cn" }, "MEMMY_LEGAL_CN_BASE_URL"],
    [{ ...validEnv, MEMMY_LEGAL_CN_BASE_URL: "https://memmy.cn/legal" }, "MEMMY_LEGAL_CN_BASE_URL"]
  ])("拒绝缺失或非法配置", (env, expectedKey) => {
    expect(() => validateLegalEnv(env)).toThrow(expectedKey);
  });
});
