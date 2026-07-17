/** Welcome page legal link tests. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getLegalLinkUrl } from "../../legal/legal-links.js";

const welcomePageSourcePath = fileURLToPath(new URL("../welcome-page.tsx", import.meta.url));

describe("WelcomePage 协议入口外链", () => {
  it("服务协议入口用当前语言的外链打开系统浏览器", () => {
    const source = readSource();

    expect(source).toContain('import { openExternalUrl } from "../utils/open-url.js"');
    expect(source).toContain('import { getLegalLinkUrl } from "../legal/legal-links.js"');
    expect(source).toContain('onOpenTerms={() => void openExternalUrl(getLegalLinkUrl("terms", language, state.bootstrap?.legal))}');
  });

  it("数据协议入口用当前语言的外链打开系统浏览器", () => {
    const source = readSource();

    expect(source).toContain('onOpenDataAgreement={() => void openExternalUrl(getLegalLinkUrl("data", language, state.bootstrap?.legal))}');
  });

  it("协议入口不再导航到应用内 /terms 或 /data-use 路由", () => {
    const source = readSource();

    expect(source).not.toContain('appActions.navigate("/terms")');
    expect(source).not.toContain('appActions.navigate("/data-use")');
  });

  it("getLegalLinkUrl 随语言联动:中英文取到不同的协议页地址", () => {
    expect(getLegalLinkUrl("terms", "zh-CN")).not.toBe(getLegalLinkUrl("terms", "en-US"));
    expect(getLegalLinkUrl("data", "zh-CN")).not.toBe(getLegalLinkUrl("data", "en-US"));
  });
});

function readSource(): string {
  return readFileSync(welcomePageSourcePath, "utf8");
}
