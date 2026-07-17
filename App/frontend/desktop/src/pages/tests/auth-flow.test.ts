/** Auth flow tests. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("auth flow pages", () => {
  it.each([
    ["welcome-page.tsx"],
    ["token-detail-page.tsx"],
    ["login-page.tsx"]
  ])("%s 通过本地账号 API 完成登录会话后再推进状态机", (fileName) => {
    const source = readSource(fileName);
    const verifyIndex = source.indexOf("phoneAuth.login");
    const persistIndex = source.lastIndexOf("persistLoginModeSelection({");

    expect(source).toContain("usePhoneAuth");
    expect(source).toContain("phoneAuth.sendCode");
    expect(source).toContain("phoneAuth.login");
    expect(verifyIndex).toBeGreaterThanOrEqual(0);
    expect(persistIndex).toBeGreaterThan(verifyIndex);
  });

  it.each([
    ["welcome-page.tsx"],
    ["token-detail-page.tsx"],
    ["login-page.tsx"]
  ])("%s 对无效账号或验证码给出可见错误", (fileName) => {
    const source = readSource(fileName);
    const hookSource = readFileSync(resolve(__dirname, "../../components/use-phone-auth.ts"), "utf8");

    expect(source).toContain("feedback={modePersistenceFeedback ?? phoneAuth.feedback}");
    expect(source).toContain("sendCodeDisabled={phoneAuth.sendCodeDisabled}");
    expect(source).toContain("sendCodeLabel={phoneAuth.sendCodeLabel}");
    expect(source).toContain("disabled={!canContinue || phoneAuth.loginPending || modePersistencePending}");
    expect(hookSource).toContain("validateAuthIdentifier(channel, rawIdentifier)");
    expect(hookSource).toContain("resolveIdentifierValidationMessage(channel, validation.reason, t)");
    expect(hookSource).toContain('"login.error.invalidPhone"');
    expect(hookSource).toContain('"login.error.invalidEmail"');
    expect(hookSource).toContain('t("login.loginFailed")');
    expect(source).toContain('t("login.error.modePersistenceFailed")');
  });

  it("验证码接口错误统一映射为当前语言文案，不直接展示后端 message", () => {
    const hookSource = readFileSync(resolve(__dirname, "../../components/use-phone-auth.ts"), "utf8");

    expect(hookSource).toContain("resolveAuthErrorMessage(error, t,");
    expect(hookSource).not.toContain("error instanceof Error ? error.message");
    expect(hookSource).toContain('"\\u9A8C\\u8BC1\\u7801\\u9519\\u8BEF"');
    expect(hookSource).toContain("invalidCodeBackendMarkers.some((marker) => normalized.includes(marker))");
    expect(hookSource).toContain('t("login.error.invalidCode")');
  });

  it.each([
    ["welcome-page.tsx"],
    ["token-detail-page.tsx"],
    ["login-page.tsx"]
  ])("%s 账号通道由包配置决定，不随界面语言切换", (fileName) => {
    const source = readSource(fileName);
    const hookSource = readFileSync(resolve(__dirname, "../../components/use-phone-auth.ts"), "utf8");

    expect(source).toContain("resolveDesktopAccountChannel()");
    expect(source).not.toContain('language === "en-US" ? "email" : "phone"');
    expect(source).toContain("phoneAuth.resetInteractionState();");
    expect(source).toContain("setModePersistenceFeedback(null);");
    expect(hookSource).toContain("resetInteractionState:");
    expect(hookSource).toContain("clearInterval(timerRef.current);");
  });

  it.each([
    ["welcome-page.tsx"],
    ["token-detail-page.tsx"],
    ["login-page.tsx"]
  ])("%s 切换界面语言时只清除已有登录错误，不重置输入或重发倒计时", (fileName) => {
    const source = readSource(fileName);
    const hookSource = readFileSync(resolve(__dirname, "../../components/use-phone-auth.ts"), "utf8");
    const toggleStart = source.indexOf("function toggleLanguage()");
    const toggleEnd = source.indexOf("\n  }", toggleStart);
    const toggleSource = source.slice(toggleStart, toggleEnd);

    expect(toggleStart).toBeGreaterThanOrEqual(0);
    expect(toggleSource).toContain("phoneAuth.clearFeedback();");
    expect(toggleSource).toContain("setModePersistenceFeedback(null);");
    expect(toggleSource).not.toContain("setIdentifier(");
    expect(toggleSource).not.toContain("setCode(");
    expect(toggleSource).not.toContain("phoneAuth.resetInteractionState();");
    expect(hookSource).toContain("clearFeedback:");
    expect(hookSource).toContain("setFeedback(null);");
  });

  it("欢迎页自有 API Key 入口先持久化模式选择，再进入配置页", () => {
    const source = readSource("welcome-page.tsx");
    const handlerIndex = source.indexOf("async function useOwnApiKey()");
    const navigateIndex = source.indexOf("dispatch(appActions.navigate(byokEntry.nextRoute));", handlerIndex);
    const persistIndex = source.indexOf("persistLoginModeSelection({", handlerIndex);

    expect(handlerIndex).toBeGreaterThanOrEqual(0);
    expect(navigateIndex).toBeGreaterThan(handlerIndex);
    expect(persistIndex).toBeGreaterThan(handlerIndex);
    expect(persistIndex).toBeLessThan(navigateIndex);
    expect(source).toContain('console.error("persist byok entry failed", error)');
    expect(source).toContain("setModePersistenceFeedback");
    expect(source).toContain('t("login.error.modePersistenceFailed")');
  });

  it.each([
    ["welcome-page.tsx"],
    ["token-detail-page.tsx"],
    ["login-page.tsx"]
  ])("%s 账号云端未完成引导时重置为账号新人引导起点", (fileName) => {
    const source = readSource(fileName);

    expect(source).toContain("buildAccountOnboardingStartPatch");
    expect(source).toContain("const onboardingPatch = forcedOnboarding ?? buildAccountOnboardingStartPatch();");
    expect(source).not.toContain("const shouldContinueOnboarding = !onboarding?.completed;");
  });

  it("欢迎页 BYOK 入口经 resolveByokEntry 守卫，已完成引导时不重置 completed", () => {
    const source = readSource("welcome-page.tsx");
    const handlerIndex = source.indexOf("async function useOwnApiKey()");
    const guardIndex = source.indexOf("const byokEntry = resolveByokEntry({ onboarding: state.bootstrap?.onboarding });", handlerIndex);
    const persistIndex = source.indexOf("onboarding: byokEntry.onboardingPatch", handlerIndex);
    const navigateIndex = source.indexOf("dispatch(appActions.navigate(byokEntry.nextRoute));", handlerIndex);

    expect(handlerIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeGreaterThan(handlerIndex);
    expect(persistIndex).toBeGreaterThan(guardIndex);
    expect(navigateIndex).toBeGreaterThan(persistIndex);
    expect(source).not.toContain("const onboardingPatch = buildByokOnboardingSetupPatch();");
  });
});

/** Reads read source. */
function readSource(fileName: string): string {
  return readFileSync(resolve(__dirname, "..", fileName), "utf8");
}
