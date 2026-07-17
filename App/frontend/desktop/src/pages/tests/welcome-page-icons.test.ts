/** Welcome page icons tests. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pageSourcePath = resolve(__dirname, "../welcome-page.tsx");
const nicknameModalSourcePath = resolve(__dirname, "../../components/nickname-modal.tsx");

describe("WelcomePage prototype icons", () => {
  it("照抄原型的礼物和钥匙图标", () => {
    const pageSource = readSource(pageSourcePath);

    expect(pageSource).toContain('import { Gift, Key } from "lucide-react"');
    expect(pageSource).toContain("<Gift size={14} strokeWidth={2.2} />");
    expect(pageSource).toContain("<Key size={15} />");
    expect(pageSource).not.toContain('{t("welcome.twitter")}');
    expect(pageSource).not.toContain('aria-hidden="true">key</span>');
    expect(pageSource).not.toContain(">T</span>");
  });

  it("昵称弹窗组件使用原型的重摇图标并限制长度", () => {
    const nicknameModalSource = readSource(nicknameModalSourcePath);

    expect(nicknameModalSource).toContain('import { Shuffle } from "lucide-react"');
    expect(nicknameModalSource).toContain("<Shuffle size={16} />");
    expect(nicknameModalSource).toContain("maxLength={32}");
    expect(nicknameModalSource).not.toContain(">\n                  *\n                </button>");
  });

  it("欢迎页不渲染底部社区链接栏", () => {
    const pageSource = readSource(pageSourcePath);

    expect(pageSource).not.toContain("communityLinks");
    expect(pageSource).not.toContain("community-wechat-preview-modal");
    expect(pageSource).not.toContain('t("welcome.wechatGroup")');
  });
});

function readSource(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

describe("WelcomePage 赠送活动开关", () => {
  it("登录页赠送黄条由 promotions.loginBanner 开关控制，取不到默认展示", () => {
    const pageSource = readSource(pageSourcePath);

    expect(pageSource).toContain("state.bootstrap?.promotions?.loginBanner ?? true");
    const gateIndex = pageSource.indexOf("promotions?.loginBanner ?? true");
    const giftLabelIndex = pageSource.indexOf('t("welcome.gift")');
    expect(gateIndex).toBeGreaterThanOrEqual(0);
    expect(giftLabelIndex).toBeGreaterThan(gateIndex);
  });
});
