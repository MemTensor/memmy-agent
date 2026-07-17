/** Model page source tests. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pagesDir = resolve(__dirname, "..");
const appDir = resolve(__dirname, "../..");

describe("ModelPage source", () => {
  it("按原型保留 API Key 第二步页面、路由和后续跳转", () => {
    const pageSource = readSource(resolve(pagesDir, "model-page.tsx"));
    const messagesSource = readSource(resolve(appDir, "i18n/messages.ts"));
    const routerSource = readSource(resolve(appDir, "app/router.tsx"));
    const routesSource = readSource(resolve(appDir, "app/routes.ts"));

    expect(pageSource).toContain('t("apiKey.modelPage.title")');
    expect(messagesSource).toContain('"apiKey.modelPage.title": "再配一下记忆相关的模型"');
    expect(messagesSource).toContain('"apiKey.modelPage.subtitle": "想省成本可以单独换~"');
    expect(messagesSource).toContain('"apiKey.modelPage.memoryTitle": "记忆摘要"');
    expect(messagesSource).toContain('"apiKey.modelPage.skillTitle": "技能进化"');
    expect(messagesSource).toContain('"apiKey.modelPage.reusePrevious": "沿用上一步的 Agent 任务模型"');
    expect(messagesSource).toContain('"apiKey.modelPage.memoryHint": "可以换个更便宜的模型（如 30B 级别），性价比更高"');
    expect(pageSource).toContain('t("apiKey.modelPage.title")');
    expect(pageSource).toContain('title={t("apiKey.modelPage.memoryTitle")}');
    expect(pageSource).toContain('title={t("apiKey.modelPage.skillTitle")}');
    expect(pageSource).toContain('dispatch(appActions.navigate("/api-key"))');
    expect(pageSource).toContain('dispatch(appActions.navigate("/api-key-optional"))');
    expect(pageSource).not.toContain("resolveByokModelCompletion");
    expect(pageSource).not.toContain("persistLoginModeSelection({");
    expect(pageSource).toContain("state.modelConfig");
    expect(pageSource).toContain("useState<PrimaryModelValues>(() => ({");
    expect(pageSource).toContain("apiKeyMasked: state.modelConfig.apiKeyMasked");
    expect(pageSource).toContain("configured: state.modelConfig.configured");
    expect(pageSource).toContain("canUseModelConfig");
    expect(pageSource).toContain("createMemmyMemoryProviderConfig");
    expect(pageSource).toContain("createModelFormValues");
    expect(pageSource).toContain("createModelProtocolPatch");
    expect(pageSource).toContain("testModelConnection");
    expect(pageSource).toContain("clients?.config");
    expect(pageSource).toContain("clients?.config.saveModelConfig(nextConfig)");
    expect(pageSource).not.toContain("persistLoginModeSelection({");
    expect(pageSource).not.toContain("dispatch(appActions.navigate(byokCompletion.nextRoute))");
    expect(pageSource).not.toContain('dispatch(appActions.navigate("/onboarding"))');
    expect(pageSource).not.toContain('track({ name: "byok_completed"');
    expect(pageSource).toContain("DEFAULT_MODEL_IDS[props.cfg.protocol]");
    expect(pageSource).toContain("<ValidationMessage validation={props.cfg.validation} stale={isTestStale} />");
    expect(pageSource).not.toContain("shouldContinueOnboarding");
    expect(pageSource).not.toContain("MOCK_PRIMARY_LLM");
    expect(pageSource).not.toContain("useNavigate");
    expect(pageSource).not.toContain("RoleConfig");
    expect(pageSource).not.toContain("role-model-config");
    expect(pageSource).not.toContain("RoleCard");
    expect(pageSource).not.toContain("function simulateTest");
    expect(pageSource).not.toContain("window.setTimeout");
    expect(routerSource).toContain('import { ModelPage } from "../pages/model-page.js";');
    expect(routerSource).toContain('case "/api-key-models":');
    expect(routerSource).toContain('case "/api-key-optional":');
    expect(routesSource).toContain('| "/api-key-models"');
    expect(routesSource).toContain('| "/api-key-optional"');
    expect(routesSource).toContain('"/api-key-models": { path: "/api-key-models", navKey: "nav.apiKeyModels", requiresBootstrap: true }');
    expect(routesSource).toContain('"/api-key-optional": { path: "/api-key-optional", navKey: "nav.apiKeyOptional", requiresBootstrap: true }');
  });

  it("重新进入第二步时展示上次保存的记忆摘要和技能进化模型配置", () => {
    const pageSource = readSource(resolve(pagesDir, "model-page.tsx"));

    expect(pageSource).toContain('hydrateModelConfigForm(state.modelConfig, "local")');
    expect(pageSource).toContain("const [mem, setMem] = useState<ModelConfig>(() => initialModelForm.memoryModel)");
    expect(pageSource).toContain("const [skill, setSkill] = useState<ModelConfig>(() => initialModelForm.skillModel)");
    expect(pageSource).toContain("apiKeyMasked: state.modelConfig.apiKeyMasked");
    expect(pageSource).toContain("configured: state.modelConfig.configured");
  });
});

function readSource(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
