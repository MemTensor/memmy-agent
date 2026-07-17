/** Api key page source tests. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const apiKeyPageSourcePath = fileURLToPath(new URL("../api-key-page.tsx", import.meta.url));
const optionalPageSourcePath = fileURLToPath(new URL("../api-key-optional-page.tsx", import.meta.url));

describe("ApiKeyPage source", () => {
  it("第一步仅保留大模型与 Embedding，测试连接按钮布局固定", () => {
    const source = readFileSync(apiKeyPageSourcePath, "utf8");
    const fieldsSource = readFileSync(fileURLToPath(new URL("../api-key-form-fields.tsx", import.meta.url)), "utf8");
    const messageIndex = source.indexOf("<ValidationMessage validation={llmValidation} stale={isTestStale} />");
    const buttonIndex = source.indexOf("<TestButton status={llmValidation.status} onClick={testLlmConnection} label={t(\"apiKey.test\")} />");

    expect(source).toContain('Brain, ChevronLeft, Search');
    expect(source).not.toContain("Mic");
    expect(source).not.toContain("ImageIcon");
    expect(source).toContain('icon={<ChevronLeft aria-hidden="true" size={16} strokeWidth={2.2} className="shrink-0 -mr-0.5" />}');
    expect(source).toContain('<Brain size={18} className="text-action-sky" />');
    expect(source).toContain('<Search size={18} className="text-action-sky" />');
    expect(source).not.toContain('<Mic size={18} className="text-action-sky" />');
    expect(source).toContain("<PasswordConfigField");
    expect(source).toContain("showPassword={showApiKey}");
    expect(source).toContain("onTogglePassword={() => setShowApiKey((value) => !value)}");
    expect(source).toContain('from "./api-key-form-fields.js"');
    expect(source).toContain("API_KEY_CARD_CLASS");
    expect(source).toContain('className="flex justify-center mb-2"');
    expect(source).toContain('className="flex min-h-9 items-center justify-end gap-3"');
    expect(fieldsSource).toContain("inline-flex w-[112px] h-10 shrink-0 items-center justify-center px-4");
    expect(fieldsSource).toContain("auth-code-form-input");
    expect(source).toContain("testEmbeddingConnection");
    expect(source).toContain('"embedding"');
    expect(source).not.toContain("testAsrConnection");
    expect(source).not.toContain("testImageGenConnection");
    expect(source).not.toContain("optionalModelMissingWarning");
    expect(source).not.toContain("<OptionalModelMissingWarningModal");
    expect(source).toContain('dispatch(appActions.navigate("/api-key-models"))');
    expect(source).toContain("asr: state.modelConfig.asr ?? null");
    expect(source).toContain("imageGen: state.modelConfig.imageGen ?? null");
    expect(messageIndex).toBeGreaterThanOrEqual(0);
    expect(buttonIndex).toBeGreaterThanOrEqual(0);
    expect(messageIndex).toBeLessThan(buttonIndex);
  });

  it("下一步先写入当前表单并跳到模型页，后端保存不阻塞导航", () => {
    const source = readFileSync(apiKeyPageSourcePath, "utf8");
    const handlerIndex = source.indexOf("function saveConfig()");
    const draftIndex = source.indexOf("const configDraft = createModelConfigDraft();", handlerIndex);
    const stateIndex = source.indexOf("dispatch(appActions.modelConfigUpdated(configDraft));", handlerIndex);
    const navigateIndex = source.indexOf('dispatch(appActions.navigate("/api-key-models"));', handlerIndex);
    const saveIndex = source.indexOf("clients?.config.saveModelConfig(configDraft)", handlerIndex);
    const persistIndex = source.indexOf("persistLoginModeSelection({", handlerIndex);

    expect(handlerIndex).toBeGreaterThanOrEqual(0);
    expect(draftIndex).toBeGreaterThan(handlerIndex);
    expect(stateIndex).toBeGreaterThan(draftIndex);
    expect(navigateIndex).toBeGreaterThan(stateIndex);
    expect(saveIndex).toBeGreaterThan(navigateIndex);
    expect(persistIndex).toBeGreaterThan(saveIndex);
  });

  it("重新进入 BYOK 第一步时从已保存模型配置 hydrate 主模型与 Embedding", () => {
    const source = readFileSync(apiKeyPageSourcePath, "utf8");

    expect(source).toContain('hydrateModelConfigForm(state.modelConfig, "local")');
    expect(source).toContain("fromProtocol(initialModelForm.protocol)");
    expect(source).toContain("const [apiKeyMasked, setApiKeyMasked] = useState(initialModelForm.apiKeyMasked)");
    expect(source).toContain("hasExistingApiKey: Boolean(apiKeyMasked)");
    expect(source).toContain("const [embeddingMode, setEmbeddingMode] = useState<EmbeddingMode>(initialEmbeddingMode)");
    expect(source).toContain("apiKeyMasked: embeddingConfig.apiKeyMasked");
    expect(source).toContain('secretTarget: "embedding"');
    expect(source).toContain('apiKeyMasked: apiKey.trim() ? "" : apiKeyMasked');
    expect(source).toContain('apiKeyMasked: embeddingConfig.apiKey.trim() ? "" : embeddingConfig.apiKeyMasked');
  });

  it("不再展示已保存 API Key 的脱敏提示行，改为用脱敏值作为输入框占位优先展示", () => {
    const source = readFileSync(apiKeyPageSourcePath, "utf8");
    const fieldsSource = readFileSync(fileURLToPath(new URL("../api-key-form-fields.tsx", import.meta.url)), "utf8");

    expect(source).not.toContain("showSavedSecret");
    expect(source).not.toContain('savedLabel={t("apiKey.savedKey")}');
    expect(source).toContain("maskedValue={apiKeyMasked}");
    expect(fieldsSource).toContain("const placeholder = !props.value.trim() && props.maskedValue ? props.maskedValue : props.placeholder;");
    expect(fieldsSource).toContain("placeholder={placeholder}");
  });

  it("协议类型切换同步默认 API 地址和默认模型 ID，并清空 API Key", () => {
    const source = readFileSync(apiKeyPageSourcePath, "utf8");
    const defaults = [
      ["openai", "https://api.openai.com/v1", "gpt-4o"],
      ["anthropic", "https://api.anthropic.com", "claude-sonnet-4"],
      ["gemini", "https://generativelanguage.googleapis.com", "gemini-2.5-pro"],
      ["deepseek", "https://api.deepseek.com/v1", "deepseek-chat"],
      ["zhipu", "https://open.bigmodel.cn/api/paas/v4", "glm-4"],
      ["qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-max"],
      ["kimi", "https://api.moonshot.ai/v1", "moonshot-v1-128k"],
      ["minimax", "https://api.minimax.chat/v1", "MiniMax-Text-01"],
      ["baidu", "https://qianfan.baidubce.com/v2", "ernie-x1.1"],
      ["doubao", "https://ark.cn-beijing.volces.com/api/v3", "doubao-pro-256k"]
    ];

    for (const [provider, endpoint, placeholder] of defaults) {
      expect(source).toContain(`value: "${provider}"`);
      expect(source).toContain(`endpoint: "${endpoint}"`);
      expect(source).toContain(`defaultModelId: "${placeholder}"`);
    }

    expect(source).toContain("useState(initialModelForm.modelId)");
    expect(source).toContain("setEndpoint(next.endpoint)");
    expect(source).toContain('setModel("")');
    expect(source).toContain('setApiKey("");');
    expect(source).toContain('setApiKeyMasked("");');
    expect(source).toContain('placeholder={`${t("apiKey.examplePrefix")} ${selectedProvider.defaultModelId}`}');
    expect(source).not.toContain("modelPlaceholder");
  });
});

describe("ApiKeyOptionalPage source", () => {
  it("第三步承载 ASR 与生图模型配置，完成后进入引导", () => {
    const source = readFileSync(optionalPageSourcePath, "utf8");

    expect(source).toContain('dispatch(appActions.navigate("/api-key-models"))');
    expect(source).toContain("resolveByokModelCompletion");
    expect(source).toContain("persistLoginModeSelection({");
    expect(source).toContain('track({ name: "byok_completed"');
    expect(source).toContain('<Mic size={18} className="text-action-sky" />');
    expect(source).toContain("testAsrConnection");
    expect(source).toContain("testImageGenConnection");
    expect(source).toContain("<OptionalModelMissingWarningModal");
    expect(source).toContain('t("apiKey.optionalPage.skip")');
    expect(source).toContain("asr: isAsrUsable ? createAsrProviderConfig(");
    expect(source).toContain("imageGen: isImageGenUsable");
  });
});
