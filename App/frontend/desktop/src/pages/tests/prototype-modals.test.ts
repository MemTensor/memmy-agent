/** Prototype modals tests. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pageDir = resolve(__dirname, "..");
const appDir = resolve(__dirname, "../..");

describe("2026-06-04 prototype modals", () => {
  it("改进计划弹窗照抄原型文案、Gift 图标和了解更多入口", () => {
    const pageSource = readSource(resolve(pageDir, "app-frame.tsx"));
    const modalSource = readSource(resolve(pageDir, "improvement-program-modal.tsx"));
    const messagesSource = readSource(resolve(appDir, "i18n/messages.ts"));
    const lucideImport = modalSource.match(/import \{([^}]+)\} from "lucide-react";/)?.[1] ?? "";

    expect(messagesSource).toContain('"onboarding.improvement.title": "帮我们变得更好"');
    expect(messagesSource).toContain('"onboarding.improvement.body": "获取崩溃和报错信息，帮我们快速定位问题，针对性改进"');
    expect(lucideImport).toContain("ExternalLink");
    expect(lucideImport).toContain("Gift");
    expect(modalSource).toContain('<Gift size={16} className="text-action-sky" />');
    expect(modalSource).toContain("<ExternalLink size={10} />");
    expect(pageSource).toContain("<ImprovementProgramModal");
    expect(pageSource).toContain('openExternalUrl(getLegalLinkUrl("data", language, state.bootstrap?.legal))');
    expect(pageSource).toContain(".setImprovementProgram(accepted)");
  });

  it("扫描授权弹窗允许扫描后检测插件冲突，同时后台提前启动 agent source 扫描", () => {
    const pageSource = readSource(resolve(pageDir, "onboarding-page.tsx"));

    expect(pageSource).toContain('import { startAgentSourceScan } from "./memory-source-scan.js"');
    expect(pageSource).toContain('if (permission !== "none")');
    expect(pageSource).toContain("if (clients) {");
    expect(pageSource).toContain('"checking_plugins"');
    expect(pageSource).toContain("clients.agentSources.getMemoryPluginConflicts()");
    expect(pageSource).toContain("void startFirstScanInBackground().catch((error)");
    expect(pageSource).toContain("await startFirstScanWithAnimation()");
    expect(pageSource).toContain("startAgentSourceScan({");
    expect(pageSource).toContain('queuedMessage: t("memory.scanQueued")');
  });

  it("体验 Token 用完弹窗照抄原型文案并接到全局路由", () => {
    const modalSource = readSource(resolve(pageDir, "token-exhausted-modal.tsx"));
    const messagesSource = readSource(resolve(appDir, "i18n/messages.ts"));
    const routerSource = readSource(resolve(appDir, "app/router.tsx"));
    const routesSource = readSource(resolve(appDir, "app/routes.ts"));
    const settingsSource = readSource(resolve(pageDir, "settings-page.tsx"));
    const applyMoreSource = readSource(resolve(appDir, "app/token-exhausted-apply-more.ts"));

    expect(messagesSource).toContain('"tokenExhausted.title": "体验额度已用完"');
    expect(messagesSource).toContain('"tokenExhausted.body": "赠送 Token 已耗尽，可以申请更多赠送，也可切换为自己的 API Key 继续使用。"');
    expect(messagesSource).toContain('"tokenExhausted.applyMore": "获取更多赠送 Token"');
    expect(messagesSource).toContain('"tokenExhausted.switchApiKey": "更换自己的 API Key"');
    expect(messagesSource).toContain('"tokenExhausted.later": "稍后再说"');
    expect(modalSource).toContain('import { Gift } from "lucide-react"');
    expect(modalSource).toContain('pose="sad"');
    expect(modalSource).toContain('t("tokenExhausted.title")');
    expect(modalSource).toContain('t("tokenExhausted.applyMore")');
    expect(modalSource).toContain('t("tokenExhausted.switchApiKey")');
    expect(routerSource).toContain("TokenExhaustedModal");
    expect(routerSource).toContain("shouldShowTokenExhaustedModal");
    expect(routerSource).toContain("state.bootstrap?.promotions?.applyMore ?? true");
    expect(routerSource).toContain("writeTokenExhaustedApplyMoreRequest");
    expect(routerSource).toContain("emitTokenExhaustedApplyMoreRequest");
    expect(routerSource).toContain('navigate("/settings")');
    expect(routerSource).toContain('document.getElementById("token-usage")');
    expect(routerSource).toContain('document.getElementById("model-config")');
    expect(routesSource).toContain("export function shouldShowTokenExhaustedModal");
    expect(applyMoreSource).toContain('TOKEN_EXHAUSTED_APPLY_MORE_EVENT = "memmy:token-exhausted-apply-more"');
    expect(settingsSource).toContain("consumeTokenExhaustedApplyMoreRequest");
    expect(settingsSource).toContain("TOKEN_EXHAUSTED_APPLY_MORE_EVENT");
    expect(settingsSource).toContain("canApplyMoreByPromotion");
    expect(settingsSource).toContain('sectionId="model-config"');
    expect(settingsSource).toContain('sectionId="token-usage"');
  });

  it("体验 Token 用完弹窗点「稍后再说」后本次运行不再复弹，仅重启可再弹", () => {
    const routerSource = readSource(resolve(appDir, "app/router.tsx"));
    const routesSource = readSource(resolve(appDir, "app/routes.ts"));

    expect(routesSource).toContain("export function readTokenExhaustedDismissed");
    expect(routesSource).toContain("export function writeTokenExhaustedDismissed");
    expect(routerSource).toContain("readTokenExhaustedDismissed");
    expect(routerSource).toContain("writeTokenExhaustedDismissed");
    expect(routerSource).not.toContain("setHasDismissedTokenExhaustedModal(false)");
  });

  it("体验 Token 用完弹窗在透明桌宠窗口里不渲染，避免遮罩盖住桌宠本体", () => {
    const routerSource = readSource(resolve(appDir, "app/router.tsx"));

    expect(routerSource).toContain("function isPetWindow(");
    expect(routerSource).toContain("isPetWindow(state.navigation.currentPath)");
    expect(routerSource).toContain("shouldShowTokenExhaustedModal(state.bootstrap) && !isPetWindowContext");
  });
});

describe("2026-06-09 prototype modals", () => {
  it("新的新人导览挂在 /onboarding flow 内，不再由主工作台路由直接弹出", () => {
    const onboardingSource = readSource(resolve(pageDir, "onboarding-page.tsx"));
    const routerSource = readSource(resolve(appDir, "app/router.tsx"));
    const tourSource = readSource(resolve(appDir, "app/product-tour.tsx"));
    const messagesSource = readSource(resolve(appDir, "i18n/messages.ts"));

    const appFrameSource = readSource(resolve(pageDir, "app-frame.tsx"));
    expect(onboardingSource).not.toContain("ProductTourGuide");
    expect(appFrameSource).toContain("<ProductTourGuide");
    expect(routerSource).not.toContain("<ProductTourGuide");
    expect(messagesSource).toContain('"productTour.memory.title": "记忆管理"');
    expect(messagesSource).toContain('"productTour.tools.title": "连接与工具"');
    expect(tourSource).toContain('t("productTour.memory.title")');
  });

  it("记忆插件冲突弹窗挂在扫描授权「全部允许」后的检测流程上", () => {
    const modalSource = readSource(resolve(pageDir, "memory-plugin-conflict-modal.tsx"));
    const onboardingSource = readSource(resolve(pageDir, "onboarding-page.tsx"));
    const messagesSource = readSource(resolve(appDir, "i18n/messages.ts"));
    const stylesSource = readSource(resolve(appDir, "styles.css"));

    expect(messagesSource).toContain('"onboarding.pluginConflict.title": "检测到已有记忆插件"');
    expect(messagesSource).toContain('"onboarding.pluginConflict.skillOnly": "仅 Skill"');
    expect(messagesSource).toContain('"onboarding.pluginConflict.replace": "替换插件"');
    expect(modalSource).toContain('import { createPortal } from "react-dom";');
    expect(modalSource).toContain("createPortal(body, document.body)");
    expect(modalSource).toContain('pose="shield"');
    expect(modalSource).toContain("memory-plugin-conflict-modal__backdrop");
    expect(modalSource).toContain('t("onboarding.pluginConflict.title")');
    expect(modalSource).toContain('t("onboarding.pluginConflict.replaceHint")');
    expect(modalSource).toContain('t("common.cancel")');
    expect(modalSource).toContain("onClick={props.onBack}");
    expect(modalSource).toContain("memory-plugin-conflict-modal__button--muted");
    expect(modalSource).toContain("props.onChoice(false)");
    expect(modalSource).toContain("props.onChoice(true)");
    expect(stylesSource).toContain(".memory-plugin-conflict-modal__backdrop");
    expect(stylesSource).toContain("position: fixed");
    expect(stylesSource).toContain(".memory-plugin-conflict-modal__button--muted");
    expect(stylesSource).toContain("width: min(448px, calc(100vw - 32px))");
    expect(stylesSource).toContain("border-radius: var(--radius-card-lg)");
    expect(stylesSource).toContain("height: 48px");
    expect(stylesSource).toContain("font-weight: 400");
    expect(stylesSource).toContain("font-weight: 600");
    expect(onboardingSource).toContain('"plugin_conflict"');
    expect(onboardingSource).toContain("void startFirstScanInBackground().catch((error)");
    expect(onboardingSource).toContain("await startFirstScanWithAnimation()");
    expect(onboardingSource).toContain("setFirstScanAnimationStartedAt(Date.now());");
    expect(onboardingSource).toContain("finishMemoryPluginConflictInstall(replace, conflicts)");
    expect(onboardingSource).not.toContain("completionPaused");
    expect(onboardingSource).not.toContain("key={activeFirstScanStep}");
    expect(onboardingSource).toContain("function detectExistingMemoryPluginConflicts()");
    expect(onboardingSource).toContain("clients.agentSources.getMemoryPluginConflicts()");
    expect(onboardingSource).toContain('permission === "scan_and_write_skill"');
    expect(onboardingSource).toContain("clients.agentSources.installPlugin(conflict.sourceId)");
    expect(onboardingSource).toContain("clients.agentSources.installSkill(conflict.sourceId)");
    expect(onboardingSource).toContain("function returnToScanPermission()");
    expect(onboardingSource).toContain('scanPermission: "unset"');
    expect(onboardingSource).toContain("setFirstScanStep(null)");
    expect(onboardingSource).toContain("updateScanPreferences(preferences)");
    expect(onboardingSource).toContain("<MemoryPluginConflictModal");
    expect(onboardingSource).toContain("onBack={returnToScanPermission}");
    expect(onboardingSource).toContain("resolving={pluginConflictResolving}");
  });

  it("新的桌宠引导弹窗只挂在首次关闭或最小化主窗口的 IPC 流程上", () => {
    const petGuideSource = readSource(resolve(appDir, "app/pet-guide.tsx"));
    const messagesSource = readSource(resolve(appDir, "i18n/messages.ts"));
    const routerSource = readSource(resolve(appDir, "app/router.tsx"));
    const mainSource = readSource(resolve(appDir, "../../../shell/desktop/src/main/main.ts"));

    expect(messagesSource).toContain('"petGuide.title": "把 Memmy 缩成桌宠陪你？"');
    expect(petGuideSource).toContain('t("petGuide.title")');
    expect(petGuideSource).toContain("PET_GUIDE_COMPLETED_STORAGE_KEY");
    expect(routerSource).toContain("onMainWindowActionRequest");
    expect(routerSource).toContain("readPetGuideCompleted(storage)");
    expect(routerSource).toContain("setPetGuideRequest(request)");
    expect(mainSource).toContain('mainWindow.on("close", handleMainWindowClose)');
    expect(mainSource).toContain('on("minimize", handleMainWindowMinimize)');
    expect(mainSource).toContain('webContents.send("memmy:main-window-action-requested"');
  });
});

function readSource(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
