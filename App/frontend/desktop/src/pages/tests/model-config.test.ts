/** Model config tests. */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ENDPOINTS,
  IMAGE_DEFAULT_ENDPOINTS,
  IMAGE_DEFAULT_MODEL_IDS,
  IMAGE_PROTOCOL_OPTIONS,
  canUseModelConfig,
  createAsrModelFormValues,
  createAsrProviderConfig,
  createImageGenModelFormValues,
  createImageGenProviderConfig,
  createModelConfig,
  createMemmyMemoryProviderConfig,
  createModelFormValues,
  createModelProtocolPatch,
  createTestModelConnectionMessages,
  fromProtocol,
  hydrateModelConfigForm,
  hasAsrApiKey,
  testModelConnection,
  toProtocol
} from "../model-config.js";
import { canSaveModelConfig, createModelConfigValidationKey, type ModelConfigValidationState } from "../model-config-validation.js";
import { zhCNMessages } from "../../i18n/messages.js";

describe("model config helpers", () => {
  it("协议切换时同步默认 API 地址，并清空模型 ID 和 API Key", () => {
    expect(createModelProtocolPatch("moonshot")).toEqual({
      protocol: "moonshot",
      endpoint: DEFAULT_ENDPOINTS.moonshot,
      modelId: "",
      apiKey: "",
      apiKeyMasked: "",
      configured: false
    });
  });

  it("沿用主模型时使用主模型表单值，独立配置时使用当前模型表单值", () => {
    const primary = {
      protocol: "openai" as const,
      modelId: "gpt-4o",
      endpoint: "https://api.openai.com/v1",
      apiKey: "sk-primary"
    };
    const reused = createModelConfig("openai");
    const custom = {
      ...createModelConfig("moonshot"),
      reuse: false,
      modelId: "moonshot-v1-128k",
      apiKey: "sk-model"
    };

    expect(createModelFormValues(reused, primary)).toEqual({
      provider: "openai",
      endpoint: primary.endpoint,
      model: primary.modelId,
      apiKey: primary.apiKey,
      apiKeyMasked: undefined,
      hasExistingApiKey: false
    });
    expect(createModelFormValues(custom, primary)).toEqual({
      provider: "kimi",
      endpoint: DEFAULT_ENDPOINTS.moonshot,
      model: "moonshot-v1-128k",
      apiKey: "sk-model",
      apiKeyMasked: "",
      hasExistingApiKey: false
    });
  });

  it("已有脱敏 key 的未修改配置可保存但不默认展示连接成功", () => {
    const values = {
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-4o",
      apiKey: "",
      apiKeyMasked: "sk-t••••cret",
      hasExistingApiKey: true
    };
    const validation: ModelConfigValidationState = {
      status: "idle",
      message: null,
      testedKey: createModelConfigValidationKey(values)
    };

    expect(canSaveModelConfig(values, validation)).toBe(true);
    expect(canSaveModelConfig({ ...values, model: "gpt-4.1" }, validation)).toBe(false);
    expect(canSaveModelConfig({ ...values, apiKey: "sk-new-secret" }, validation)).toBe(false);
  });

  it("ASR 未填写 key 时视为未设置，已填写时必须测试成功", () => {
    const emptyAsr = createAsrModelFormValues("qwen3-asr-flash", "https://dashscope.aliyuncs.com/compatible-mode/v1", "", "");
    const asrValues = createAsrModelFormValues("qwen3-asr-flash", "https://dashscope.aliyuncs.com/compatible-mode/v1", "sk-asr", "");
    const success: ModelConfigValidationState = {
      status: "success",
      message: "连接成功",
      testedKey: createModelConfigValidationKey(asrValues)
    };

    expect(emptyAsr).toMatchObject({
      provider: "qwen",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen3-asr-flash",
      apiKey: "",
      hasExistingApiKey: false
    });
    expect(hasAsrApiKey(emptyAsr)).toBe(false);
    expect(hasAsrApiKey(asrValues)).toBe(true);
    expect(canSaveModelConfig(asrValues, { status: "idle", message: null, testedKey: null })).toBe(false);
    expect(canSaveModelConfig(asrValues, success)).toBe(true);
  });

  it("未配置 ASR 时保存 payload 回落到固定模型和默认 endpoint", () => {
    expect(createAsrProviderConfig("", "", "", "")).toEqual({
      provider: "aliyun",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen3-asr-flash",
      apiKey: "",
      apiKeyMasked: "",
      configured: false
    });
  });

  it("生图协议下拉为主大模型去掉 anthropic/deepseek/kimi 后的 7 项", () => {
    const values = IMAGE_PROTOCOL_OPTIONS.map((option) => option.value);
    expect(values).toEqual(["openai", "gemini", "zhipu", "qwen", "minimax", "baidu", "doubao"]);
    expect(values).not.toContain("anthropic");
    expect(values).not.toContain("deepseek");
    expect(values).not.toContain("moonshot");
  });

  it("生图配置回落到协议默认 endpoint 和默认模型", () => {
    expect(createImageGenProviderConfig("doubao", "", "", "", "")).toEqual({
      provider: "doubao",
      endpoint: IMAGE_DEFAULT_ENDPOINTS.doubao,
      model: IMAGE_DEFAULT_MODEL_IDS.doubao,
      apiKey: "",
      apiKeyMasked: "",
      configured: false
    });

    const qwenDefaults = createImageGenProviderConfig(
      "qwen",
      "",
      "",
      "",
      ""
    );
    expect(qwenDefaults.provider).toBe("qwen");
    expect(qwenDefaults.endpoint).toBe("https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1");
    expect(qwenDefaults.model).toBe("qwen-image-2.0-pro");
    expect(qwenDefaults.configured).toBe(false);

    const configured = createImageGenProviderConfig(
      "qwen",
      "",
      IMAGE_DEFAULT_ENDPOINTS.qwen,
      "sk-image",
      ""
    );
    expect(configured.provider).toBe("qwen");
    expect(configured.endpoint).toBe("https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1");
    expect(configured.model).toBe("qwen-image-2.0-pro");
    expect(configured.configured).toBe(true);
    expect(configured.apiKeyMasked).toBe("");
  });

  it("生图测试表单值携带所选协议", () => {
    const values = createImageGenModelFormValues("gemini", "imagen-4.0-generate-001", "https://g.example/v1beta", "sk-img", "");
    expect(values.provider).toBe("gemini");
    expect(values.model).toBe("imagen-4.0-generate-001");
    expect(values.hasExistingApiKey).toBe(false);
  });

  it("独立模型必须测试成功后才允许继续", () => {
    const primary = {
      protocol: "openai" as const,
      modelId: "gpt-4o",
      endpoint: "https://api.openai.com/v1",
      apiKey: "sk-primary"
    };
    const custom = {
      ...createModelConfig("deepseek"),
      reuse: false,
      modelId: "deepseek-chat",
      apiKey: "sk-model"
    };
    const values = createModelFormValues(custom, primary);
    const success: ModelConfigValidationState = {
      status: "success",
      message: "连接成功",
      testedKey: createModelConfigValidationKey(values)
    };

    expect(canUseModelConfig(createModelConfig("openai"), values)).toBe(true);
    expect(canUseModelConfig(custom, values)).toBe(false);
    expect(canUseModelConfig({ ...custom, validation: success }, values)).toBe(true);
    expect(canUseModelConfig({ ...custom, validation: success }, { ...values, model: "deepseek-reasoner" })).toBe(false);
  });

  it("构造展开后的 Memory 角色模型保存 payload", () => {
    const primary = {
      protocol: "openai" as const,
      modelId: "gpt-4o",
      endpoint: "https://api.openai.com/v1",
      apiKey: "sk-primary"
    };
    const memory = createModelConfig("openai");
    const skill = {
      ...createModelConfig("moonshot"),
      reuse: false,
      modelId: "moonshot-v1-128k",
      apiKey: "sk-skill"
    };

    expect(createMemmyMemoryProviderConfig(memory, skill, primary)).toEqual({
        summary: {
        provider: "openai",
        endpoint: "https://api.openai.com/v1",
        model: "gpt-4o",
        apiKey: "sk-primary",
        apiKeyMasked: "",
        configured: true
      },
      evolution: {
        provider: "kimi",
        endpoint: DEFAULT_ENDPOINTS.moonshot,
        model: "moonshot-v1-128k",
        apiKey: "sk-skill",
        apiKeyMasked: "",
        configured: true
      }
    });
  });

  it("从完整脱敏模型配置 hydrate 设置页表单状态", () => {
    const hydrated = hydrateModelConfigForm({
      provider: "openai",
      endpoint: "https://main.example.com/v1",
      model: "main-model",
      apiKey: "",
      apiKeyMasked: "sk-m••••main",
      configured: true,
      embedding: {
        mode: "custom",
        endpoint: "https://embedding.example.com/v1",
        model: "embedding-model",
        apiKey: "",
        apiKeyMasked: "sk-e••••ding",
        configured: true
      },
      memmyMemory: {
        summary: {
          provider: "anthropic",
          endpoint: "https://memory.example.com/v1",
          model: "memory-model",
          apiKey: "",
          apiKeyMasked: "sk-m••••mory",
          configured: true
        },
        evolution: {
          provider: "openai",
          endpoint: "https://main.example.com/v1",
          model: "main-model",
          apiKey: "",
          apiKeyMasked: "sk-m••••main",
          configured: true
        }
      }
    }, "local");

    expect(hydrated).toMatchObject({
      protocol: "openai",
      modelId: "main-model",
      endpoint: "https://main.example.com/v1",
      apiKey: "",
      apiKeyMasked: "sk-m••••main",
      embeddingMode: "custom",
      embModelId: "embedding-model",
      embEndpoint: "https://embedding.example.com/v1",
      embApiKeyMasked: "sk-e••••ding",
      asrModelId: "",
      asrEndpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      memoryModel: {
        reuse: false,
        protocol: "anthropic",
        modelId: "memory-model",
        endpoint: "https://memory.example.com/v1",
        apiKeyMasked: "sk-m••••mory"
      },
      skillModel: {
        reuse: true,
        apiKeyMasked: "sk-m••••main"
      }
    });
    expect(hydrated.llmValidation.status).toBe("idle");
    expect(hydrated.embValidation.status).toBe("idle");
    expect(hydrated.memoryModel.validation.status).toBe("idle");
    expect(canSaveModelConfig({
      provider: "openai",
      endpoint: "https://main.example.com/v1",
      model: "main-model",
      apiKey: "",
      apiKeyMasked: "sk-m••••main",
      hasExistingApiKey: true
    }, hydrated.llmValidation)).toBe(true);
  });

  it("真实连接测试调用配置客户端并写回成功签名", async () => {
    const setValidation = vi.fn();
    const onSuccess = vi.fn();
    const configClient = {
      testModelConfig: vi.fn(async () => ({ ok: true, message: "ok", checkedAt: "2026-06-09T00:00:00.000Z" }))
    };
    const values = {
      provider: "kimi",
      endpoint: "https://api.moonshot.ai/v1",
      model: "moonshot-v1-128k",
      apiKey: "sk-model"
    };

    testModelConnection({
      configClient,
      values,
      setValidation,
      onSuccess,
      messages: createTestModelConnectionMessages((key) => zhCNMessages[key])
    });
    await Promise.resolve();

    expect(configClient.testModelConfig).toHaveBeenCalledWith({
      provider: values.provider,
      endpoint: values.endpoint,
      model: values.model,
      apiKey: values.apiKey,
      apiKeyMasked: "",
      configured: false
    }, "chat");
    expect(setValidation).toHaveBeenNthCalledWith(1, { status: "testing", message: "正在测试连接", testedKey: null });
    expect(setValidation).toHaveBeenNthCalledWith(2, {
      status: "success",
      message: "连接成功",
      testedKey: createModelConfigValidationKey(values)
    });
    expect(onSuccess).toHaveBeenCalledWith({
      provider: values.provider,
      endpoint: values.endpoint,
      model: values.model,
      apiKey: values.apiKey,
      apiKeyMasked: "",
      configured: false
    });
  });

  it("已有脱敏 key 的配置点击测试会请求后端复用已保存 secret", async () => {
    const setValidation = vi.fn();
    const configClient = {
      testModelConfig: vi.fn(async () => ({ ok: true, message: "ok", checkedAt: "2026-06-09T00:00:00.000Z" }))
    };
    const values = {
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-4o",
      apiKey: "",
      apiKeyMasked: "sk-t••••cret",
      hasExistingApiKey: true
    };

    testModelConnection({
      configClient,
      values,
      setValidation,
      messages: createTestModelConnectionMessages((key) => zhCNMessages[key]),
      secretTarget: "primary"
    } as Parameters<typeof testModelConnection>[0] & { secretTarget: "primary" });
    await Promise.resolve();

    expect(configClient.testModelConfig).toHaveBeenCalledWith({
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-4o",
      apiKey: "",
      apiKeyMasked: "sk-t••••cret",
      configured: true
    }, "chat", "primary");
    expect(setValidation).toHaveBeenNthCalledWith(1, { status: "testing", message: "正在测试连接", testedKey: null });
    expect(setValidation).toHaveBeenNthCalledWith(2, {
      status: "success",
      message: "连接成功",
      testedKey: createModelConfigValidationKey(values)
    });
  });

  it("连接测试失败时展示后端返回的具体失败原因", async () => {
    const setValidation = vi.fn();
    const configClient = {
      testModelConfig: vi.fn(async () => ({
        ok: false,
        message: "API 返回格式不符合模型接口，请检查 API 地址是否包含正确版本路径",
        checkedAt: "2026-06-09T00:00:00.000Z"
      }))
    };
    const values = {
      provider: "openai",
      endpoint: "https://api-int.memtensor.cn",
      model: "gpt-4.1-mini",
      apiKey: "1",
      apiKeyMasked: "",
      hasExistingApiKey: false
    };

    testModelConnection({
      configClient,
      values,
      setValidation,
      messages: createTestModelConnectionMessages((key) => zhCNMessages[key])
    });
    await Promise.resolve();

    expect(setValidation).toHaveBeenNthCalledWith(2, {
      status: "error",
      message: "API 返回格式不符合模型接口，请检查 API 地址是否包含正确版本路径",
      testedKey: null
    });
  });

  it("真实连接测试支持 ASR capability", async () => {
    const setValidation = vi.fn();
    const configClient = {
      testModelConfig: vi.fn(async () => ({ ok: true, message: "ok", checkedAt: "2026-06-09T00:00:00.000Z" }))
    };
    const values = createAsrModelFormValues("qwen3-asr-flash", "https://dashscope.aliyuncs.com/compatible-mode/v1", "sk-asr", "");

    testModelConnection({
      configClient,
      values,
      setValidation,
      capability: "asr",
      messages: createTestModelConnectionMessages((key) => zhCNMessages[key])
    });
    await Promise.resolve();

    expect(configClient.testModelConfig).toHaveBeenCalledWith({
      provider: "qwen",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen3-asr-flash",
      apiKey: "sk-asr",
      apiKeyMasked: "",
      configured: false
    }, "asr");
    expect(setValidation).toHaveBeenNthCalledWith(2, {
      status: "success",
      message: "连接成功",
      testedKey: createModelConfigValidationKey(values)
    });
  });

  it("兼容历史 provider id 和当前配置客户端 provider id", () => {
    expect(toProtocol("kimi")).toBe("moonshot");
    expect(toProtocol("google")).toBe("gemini");
    expect(fromProtocol("moonshot")).toBe("kimi");
  });
});
