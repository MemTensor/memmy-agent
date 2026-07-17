/** Local app contracts tests. */
import { describe, expect, it } from "vitest";
import {
  AccountSessionViewSchema,
  ApiErrorBodySchema,
  AuthorizeIntegrationResponseSchema,
  AvatarOptionSchema,
  ByokTokenUsageEventSchema,
  ByokTokenUsageSummarySchema,
  ClearLocalDataInputSchema,
  ExportLocalDataInputSchema,
  ConnectIntegrationInputSchema,
  IntegrationCapabilitiesResponseSchema,
  IntegrationConnectionsResponseSchema,
  IntegrationDetailSchema,
  IntegrationListItemSchema,
  IntegrationStatusSchema,
  LocalDataClearResponseSchema,
  LocalDataExportResponseSchema,
  LocalDataRevealResponseSchema,
  ImageGenModelConfigInputSchema,
  ImageGenModelConfigViewSchema,
  ModelConfigInputSchema,
  ModelConfigTestInputSchema,
  ModelConfigTestResultSchema,
  ModelConfigViewSchema,
  PatchAppSettingsInputSchema,
  PatchOnboardingInputSchema,
  PatchPrivacyInputSchema,
  SendCodeInputSchema,
  SetAvatarInputSchema,
  SetImprovementProgramInputSchema,
  SetImprovementProgramResponseSchema,
  SetSkinInputSchema,
  RequestConnectUrlResponseSchema,
  VerifyCodeInputSchema
} from "@memmy/local-api-contracts";

describe("local app contracts", () => {
  it("parses BYOK token usage event and summary contracts", () => {
    const event = ByokTokenUsageEventSchema.parse({
      id: "event-1",
      kind: "agent_chat",
      source: "agent",
      operationId: "turn-1",
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      cachedInputTokens: 5,
      cacheCreationInputTokens: 2,
      metadata: {
        sessionKey: "cli:direct",
        provider: "openai",
        modelId: "gpt-4.1-mini"
      },
      rawUsage: {
        prompt_tokens: 10,
        completion_tokens: 20
      },
      createdAt: "2026-06-11T10:00:00.000Z"
    });

    expect(event.totalTokens).toBe(30);
    expect(() => ByokTokenUsageEventSchema.parse({ ...event, inputTokens: -1 })).toThrow();

    const summary = ByokTokenUsageSummarySchema.parse({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      cachedInputTokens: 5,
      cacheCreationInputTokens: 2,
      updatedAt: "2026-06-11T10:00:00.000Z",
      byKind: [{
        kind: "agent_chat",
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        cachedInputTokens: 5,
        cacheCreationInputTokens: 2,
        eventCount: 1,
        updatedAt: "2026-06-11T10:00:00.000Z"
      }]
    });

    expect(summary.byKind[0]).toMatchObject({
      kind: "agent_chat",
      totalTokens: 30
    });
  });

  it("parses app config patch schemas and rejects invalid enum values", () => {
    expect(
      PatchAppSettingsInputSchema.parse({
        language: "zh-CN",
        defaultLaunchMode: "pet",
        menuBarIconEnabled: false
      })
    ).toEqual({
      language: "zh-CN",
      defaultLaunchMode: "pet",
      menuBarIconEnabled: false
    });

    expect(PatchPrivacyInputSchema.parse({ localOnlyMode: true })).toEqual({ localOnlyMode: true });
    expect(PatchOnboardingInputSchema.parse({ currentStep: "completed", completed: true })).toEqual({
      currentStep: "completed",
      completed: true
    });
    expect(PatchOnboardingInputSchema.parse({ currentStep: "product_tour_required" })).toEqual({
      currentStep: "product_tour_required"
    });
    expect(SetImprovementProgramInputSchema.parse({ improvementProgram: "declined" })).toEqual({
      improvementProgram: "declined"
    });
    expect(
      SetImprovementProgramResponseSchema.parse({
        onboarding: {
          completed: false,
          currentStep: "product_tour_required",
          hasAcceptedTerms: false,
          acceptedTermsVersion: null,
          scanPermission: "scan_only",
          improvementProgram: "accepted",
          completedAt: null
        },
        privacy: {
          telemetryOptIn: false,
          crashReportOptIn: false,
          allowMemoryImprovementUpload: true,
          localOnlyMode: false
        },
        tokenUsage: {
          planName: "体验 Token",
          totalTokens: 35000000,
          usedTokens: 1000000,
          remainingTokens: 34000000,
          expiresAt: null,
          lastSyncedAt: "2026-06-05T10:00:00.000Z"
        }
      })
    ).toMatchObject({
      onboarding: { currentStep: "product_tour_required", improvementProgram: "accepted" },
      privacy: { allowMemoryImprovementUpload: true },
      tokenUsage: { remainingTokens: 34000000 }
    });
    expect(() => PatchAppSettingsInputSchema.parse({ defaultLaunchMode: "windowed" })).toThrow();
  });

  it("parses model config input and exposes saved keys in model config view", () => {
    const input = ModelConfigInputSchema.parse({
      provider: "openai_compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "gpt-4.1-mini",
      apiKey: "sk-test-secret",
      embedding: {
        mode: "custom",
        baseUrl: "https://embedding.example.com/v1",
        modelId: "text-embedding-3-large",
        apiKey: "emb-test-secret"
      },
      memmyMemory: {
        summary: {
          provider: "anthropic",
          baseUrl: "https://memory.example.com/v1",
          modelId: "claude-3-5-haiku",
          apiKey: "sk-memory-secret"
        },
        evolution: {
          provider: "qwen",
          baseUrl: "https://skill.example.com/v1",
          modelId: "qwen-plus",
          apiKey: "sk-skill-secret"
        }
      },
      asr: {
        provider: "aliyun",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        modelId: "qwen3-asr-flash",
        apiKey: "sk-asr-secret"
      }
    });

    expect(input.embedding?.mode).toBe("custom");
    expect(input.memmyMemory?.evolution.provider).toBe("qwen");
    expect(input.asr?.modelId).toBe("qwen3-asr-flash");

    const view = ModelConfigViewSchema.parse({
      provider: "openai_compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "gpt-4.1-mini",
      hasApiKey: true,
      apiKeyMasked: "sk-t••••cret",
      apiKey: "sk-test-secret",
      embedding: {
        mode: "custom",
        baseUrl: "https://embedding.example.com/v1",
        modelId: "text-embedding-3-large",
        hasApiKey: true,
        apiKeyMasked: "emb-••••cret",
        apiKey: "emb-test-secret"
      },
      memmyMemory: {
        summary: {
          provider: "anthropic",
          baseUrl: "https://memory.example.com/v1",
          modelId: "claude-3-5-haiku",
          hasApiKey: true,
          apiKeyMasked: "sk-m••••cret",
          apiKey: "sk-memory-secret"
        },
        evolution: {
          provider: "qwen",
          baseUrl: "https://skill.example.com/v1",
          modelId: "qwen-plus",
          hasApiKey: true,
          apiKeyMasked: "sk-s••••cret",
          apiKey: "sk-skill-secret"
        }
      },
      asr: {
        provider: "aliyun",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        modelId: "qwen3-asr-flash",
        hasApiKey: true,
        apiKeyMasked: "sk-a••••cret",
        apiKey: "sk-asr-secret"
      },
      imageGen: {
        provider: "openai_compatible",
        baseUrl: "https://api.openai.com/v1",
        modelId: "gpt-image-1",
        hasApiKey: true,
        apiKeyMasked: "sk-i••••cret",
        apiKey: "sk-image-secret"
      },
      updatedAt: "2026-06-02T10:00:00.000Z"
    });

    expect(view.apiKey).toBe("sk-test-secret");
    expect(view.embedding?.apiKey).toBe("emb-test-secret");
    expect(view.memmyMemory.summary.apiKey).toBe("sk-memory-secret");
    expect(view.memmyMemory.evolution.apiKey).toBe("sk-skill-secret");
    expect(view.asr?.apiKey).toBe("sk-asr-secret");
    expect(view.imageGen?.apiKey).toBe("sk-image-secret");
  });

  it("parses image generation model config and rejects unsupported providers", () => {
    const input = ImageGenModelConfigInputSchema.parse({
      provider: "doubao",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      modelId: "doubao-seedream-4-0-250828",
      apiKey: "sk-image-secret"
    });
    expect(input.provider).toBe("doubao");

    const view = ImageGenModelConfigViewSchema.parse({
      provider: "qwen",
      baseUrl: "https://dashscope.aliyuncs.com",
      modelId: "qwen-image",
      hasApiKey: false,
      apiKeyMasked: "",
      apiKey: ""
    });
    expect(view.modelId).toBe("qwen-image");

    for (const provider of ["anthropic", "deepseek", "kimi"]) {
      expect(
        ImageGenModelConfigInputSchema.safeParse({
          provider,
          baseUrl: "https://example.com/v1",
          modelId: "x"
        }).success
      ).toBe(false);
    }

    const imageTest = ModelConfigTestInputSchema.parse({
      provider: "doubao",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      modelId: "doubao-seedream-4-0-250828",
      apiKey: "sk-image-secret",
      capability: "image",
      secretTarget: "image"
    });
    expect(imageTest.capability).toBe("image");
    expect(imageTest.secretTarget).toBe("image");
  });

  it("parses model config test input and returns non-secret validation result", () => {
    const input = ModelConfigTestInputSchema.parse({
      provider: "openai_compatible",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-5.5",
      apiKey: "sk-test-secret"
    });
    const asrInput = ModelConfigTestInputSchema.parse({
      provider: "qwen",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      modelId: "qwen3-asr-flash",
      apiKey: "sk-asr-secret",
      capability: "asr"
    });

    expect(input.modelId).toBe("gpt-5.5");
    expect(asrInput.capability).toBe("asr");

    const result = ModelConfigTestResultSchema.parse({
      ok: false,
      message: "API Key 无效或模型不可用",
      checkedAt: "2026-06-05T10:00:00.000Z"
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sk-test-secret");
  });

  it("parses account and avatar contracts", () => {
    expect(SendCodeInputSchema.parse({ channel: "email", email: "hello@example.com", locale: "zh" })).toEqual({
      channel: "email",
      email: "hello@example.com",
      locale: "zh"
    });
    expect(
      VerifyCodeInputSchema.parse({
        channel: "phone",
        phoneNumber: "13800138000",
        verificationCode: "123456",
        loginSource: "Memmy"
      })
    ).toMatchObject({ channel: "phone", loginSource: "Memmy" });
    const parsedSession = AccountSessionViewSchema.parse({
      authenticated: true,
      isNewUser: true,
      profile: {
        userId: "user-1",
        email: "hello@example.com",
        phoneNumber: null,
        nickname: "hello",
        avatarUrl: null,
        planType: "free",
        hasFinishedGuide: false,
        region: null,
        registeredAt: "2026-06-02T10:00:00.000Z"
      }
    });
    expect(parsedSession).toMatchObject({
      authenticated: true,
      isNewUser: true,
      profile: {
        registeredAt: "2026-06-02T10:00:00.000Z"
      }
    });
    expect(AccountSessionViewSchema.parse({ authenticated: false })).toEqual({ authenticated: false });
    expect(AvatarOptionSchema.parse({ id: "memmy", displayName: "Memmy", assetKey: "avatar.memmy", kind: "image" })).toEqual({
      id: "memmy",
      displayName: "Memmy",
      assetKey: "avatar.memmy",
      kind: "image"
    });
    expect(SetAvatarInputSchema.parse({ avatarId: "memmy" })).toEqual({ avatarId: "memmy" });
    expect(SetSkinInputSchema.parse({ skinId: "default" })).toEqual({ skinId: "default" });
  });

  it("parses local data management contracts", () => {
    expect(ExportLocalDataInputSchema.parse({ targetPath: "/tmp/memmy-export" })).toEqual({
      targetPath: "/tmp/memmy-export"
    });
    expect(LocalDataExportResponseSchema.parse({ exportPath: "/tmp/memmy-export", bytes: 128 })).toEqual({
      exportPath: "/tmp/memmy-export",
      bytes: 128
    });
    expect(LocalDataRevealResponseSchema.parse({ ok: true, dataPath: "/tmp/memmy" })).toEqual({
      ok: true,
      dataPath: "/tmp/memmy"
    });
    expect(ClearLocalDataInputSchema.parse({ confirm: true })).toEqual({ confirm: true });
    expect(() => ClearLocalDataInputSchema.parse({ confirm: false })).toThrow();
    expect(LocalDataClearResponseSchema.parse({ ok: true, clearedAt: "2026-06-02T10:00:00.000Z" })).toMatchObject({
      ok: true
    });
  });

  it("parses tool integration contracts", () => {
    const listItem = IntegrationListItemSchema.parse({
      id: "wechat",
      name: "微信",
      iconText: "微",
      category: "Chat",
      isChannel: true,
      authKind: "qrCode",
      brand: "#07C160",
      iconKind: "svg",
      status: "not_configured"
    });

    expect(listItem).toMatchObject({
      id: "wechat",
      iconText: "微",
      isChannel: true,
      authKind: "qrCode",
      brand: "#07C160",
      iconKind: "svg",
      status: "not_configured"
    });

    expect(IntegrationStatusSchema.parse("requesting_url")).toBe("requesting_url");
    expect(IntegrationStatusSchema.parse("awaiting_browser_auth")).toBe("awaiting_browser_auth");
    expect(() => IntegrationStatusSchema.parse("connecting")).toThrow();

    const detail = IntegrationDetailSchema.parse({
      ...listItem,
      summary: "Connect WeChat as a default message channel.",
      description: "Use QR code authorization to connect WeChat.\n\nBackend channel APIs are pending.",
      permissions: ["Read incoming messages", "Send replies"],
      authKind: "qrCode",
      requiresQrCode: true
    });

    expect(detail.requiresQrCode).toBe(true);
    expect(detail.permissions).toContain("Send replies");
    expect(ConnectIntegrationInputSchema.parse({ id: "wechat" })).toEqual({ id: "wechat" });
    expect(ConnectIntegrationInputSchema.parse({ id: "github", apiKey: "ghp_test" })).toEqual({
      id: "github",
      apiKey: "ghp_test"
    });
    expect(
      RequestConnectUrlResponseSchema.parse({
        url: "https://example.com/oauth/github?state=conn-github",
        pollToken: "conn-github"
      })
    ).toEqual({
      url: "https://example.com/oauth/github?state=conn-github",
      pollToken: "conn-github"
    });

    expect(
      AuthorizeIntegrationResponseSchema.parse({
        connectUrl: "https://backend.composio.dev/api/v3/s/github-test",
        connectionId: "conn-github"
      })
    ).toEqual({
      connectUrl: "https://backend.composio.dev/api/v3/s/github-test",
      connectionId: "conn-github"
    });

    expect(
      IntegrationConnectionsResponseSchema.parse({
        connections: [{ id: "conn-github", toolkit: "github", status: "ACTIVE", accountEmail: "dev@example.com" }]
      })
    ).toEqual({
      connections: [{ id: "conn-github", toolkit: "github", status: "ACTIVE", accountEmail: "dev@example.com" }]
    });

    expect(
      IntegrationCapabilitiesResponseSchema.parse({
        toolkits: ["github"]
      })
    ).toEqual({
      toolkits: ["github"]
    });
  });

  it("accepts Composio integration error codes in the shared error envelope", () => {
    expect(
      ApiErrorBodySchema.parse({
        error: {
          code: "composio_not_configured",
          message: "尚未配置 Composio 鉴权服务",
          requestId: "req-composio"
        }
      })
    ).toEqual({
      error: {
        code: "composio_not_configured",
        message: "尚未配置 Composio 鉴权服务",
        requestId: "req-composio"
      }
    });

    expect(
      ApiErrorBodySchema.parse({
        error: {
          code: "toolkit_unsupported",
          message: "该工具暂不支持 Composio 授权",
          requestId: "req-toolkit"
        }
      })
    ).toEqual({
      error: {
        code: "toolkit_unsupported",
        message: "该工具暂不支持 Composio 授权",
        requestId: "req-toolkit"
      }
    });
  });
});
