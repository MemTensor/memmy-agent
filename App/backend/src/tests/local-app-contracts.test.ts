/** Local app contracts tests. */
import { describe, expect, it } from "vitest";
import {
  AccountInvitationViewSchema,
  AccountLoginResultViewSchema,
  AccountSessionViewSchema,
  ApiErrorBodySchema,
  AsrTranscriptionResponseSchema,
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
  MODEL_NAME_MAX_LENGTH,
  PatchAppSettingsInputSchema,
  PatchOnboardingInputSchema,
  PatchPrivacyInputSchema,
  PromotionFlagsSchema,
  SendCodeInputSchema,
  SetAvatarInputSchema,
  SetImprovementProgramInputSchema,
  SetImprovementProgramResponseSchema,
  SetSkinInputSchema,
  RequestConnectUrlResponseSchema,
  TextModelItemInputSchema,
  TextModelItemViewSchema,
  VerifyCodeInputSchema
} from "@memmy/local-api-contracts";

describe("local app contracts", () => {
  it("limits newly saved model names without constraining normal names", () => {
    const modelInput = {
      endpointId: "primary",
      source: "byok" as const,
      capabilities: ["agent" as const]
    };

    expect(TextModelItemInputSchema.parse({
      ...modelInput,
      model: "gpt-4.1-mini"
    }).model).toBe("gpt-4.1-mini");
    expect(TextModelItemInputSchema.safeParse({
      ...modelInput,
      model: "m".repeat(MODEL_NAME_MAX_LENGTH)
    }).success).toBe(true);
    expect(TextModelItemInputSchema.safeParse({
      ...modelInput,
      model: "m".repeat(MODEL_NAME_MAX_LENGTH + 1)
    }).success).toBe(false);
    expect(TextModelItemViewSchema.safeParse({
      ...modelInput,
      presetId: "legacy-long-model",
      provider: "openai",
      protocol: "openai-chat-completions",
      model: "m".repeat(MODEL_NAME_MAX_LENGTH + 1),
      available: true
    }).success).toBe(true);
  });

  it("accepts canonical BYOK and account ASR response identities", () => {
    expect(AsrTranscriptionResponseSchema.parse({
      text: "你好",
      modelId: "custom-asr-model",
      provider: "dashscope",
      source: "byok",
      transcribedAt: "2026-06-15T10:00:00.000Z"
    }).provider).toBe("dashscope");

    expect(AsrTranscriptionResponseSchema.parse({
      text: "hello",
      modelId: "account-asr",
      provider: "memmy_account",
      source: "account",
      transcribedAt: "2026-06-15T10:00:00.000Z"
    }).modelId).toBe("account-asr");
  });

  it("parses BYOK token usage event and summary contracts", () => {
    const event = ByokTokenUsageEventSchema.parse({
      id: "event-1",
      kind: "agent_chat",
      source: "agent",
      operationId: "turn-1",
      presetId: "byok-agent",
      provider: "openai",
      model: "gpt-4.1-mini",
      capability: "agent",
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
      }],
      byModel: [{
        presetId: "byok-agent",
        provider: "openai",
        model: "gpt-4.1-mini",
        capability: "agent",
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
    expect(summary.byModel[0]).toMatchObject({
      presetId: "byok-agent",
      provider: "openai",
      model: "gpt-4.1-mini",
      capability: "agent"
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

  it("parses canonical model catalog input and exposes saved endpoint keys", () => {
    const input = ModelConfigInputSchema.parse({
      configRevision: "revision-1",
      providers: [{
        provider: "openai",
        apiKey: "sk-test-secret",
        endpoints: [{
          endpointId: "primary",
          apiBase: "https://api.example.com/v1",
          protocol: "openai-chat-completions",
          apiKey: "sk-endpoint-secret"
        }],
        models: [{
          presetId: "work-gpt",
          endpointId: "primary",
          model: "gpt-4.1-mini",
          source: "byok",
          capabilities: ["agent", "memory_summary", "memory_evolution"]
        }]
      }],
      modelAssignments: {
        byok: {
          agent: { candidates: ["work-gpt"], default: "work-gpt" },
          memorySummary: "work-gpt",
          memoryEvolution: "work-gpt",
          embedding: null,
          asr: null,
          imageGeneration: null
        },
        account: {
          agent: { candidates: [], default: null },
          memorySummary: null,
          memoryEvolution: null,
          embedding: null,
          asr: null,
          imageGeneration: null
        }
      }
    });

    expect(input.providers[0]?.endpoints[0]?.apiKey).toBe("sk-endpoint-secret");
    expect(input.modelAssignments.byok.memorySummary).toBe("work-gpt");

    const view = ModelConfigViewSchema.parse({
      configRevision: "revision-2",
      providers: [{
        provider: "openai",
        configured: true,
        hasApiKey: true,
        apiKeyMasked: "sk-t••••cret",
        apiKey: "sk-test-secret",
        accountManaged: false,
        editable: true,
        endpoints: [{
          endpointId: "primary",
          apiBase: "https://api.example.com/v1",
          protocol: "openai-chat-completions",
          hasApiKey: true,
          apiKeyMasked: "sk-e••••cret",
          apiKey: "sk-endpoint-secret"
        }],
        models: [{
          presetId: "work-gpt",
          provider: "openai",
          endpointId: "primary",
          protocol: "openai-chat-completions",
          model: "gpt-4.1-mini",
          source: "byok",
          capabilities: ["agent", "memory_summary", "memory_evolution"],
          available: true
        }]
      }],
      modelAssignments: input.modelAssignments,
      effectiveCandidates: {
        byok: [{
          presetId: "work-gpt",
          provider: "openai",
          endpointId: "primary",
          protocol: "openai-chat-completions",
          model: "gpt-4.1-mini",
          source: "byok",
          capabilities: ["agent", "memory_summary", "memory_evolution"],
          available: true
        }],
        account: []
      },
      configured: true,
      updatedAt: "2026-06-02T10:00:00.000Z"
    });

    expect(view.providers[0]?.apiKey).toBe("sk-test-secret");
    expect(view.providers[0]?.endpoints[0]?.apiKey).toBe("sk-endpoint-secret");
    expect(view.modelAssignments.byok.agent.default).toBe("work-gpt");
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
      endpointId: "image",
      protocol: "openai-images",
      apiBase: "https://ark.cn-beijing.volces.com/api/v3",
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
      endpointId: "chat",
      protocol: "openai-chat-completions",
      apiBase: "https://api.openai.com/v1",
      modelId: "gpt-5.5",
      apiKey: "sk-test-secret"
    });
    const asrInput = ModelConfigTestInputSchema.parse({
      provider: "qwen",
      endpointId: "asr",
      protocol: "dashscope-input-audio-chat",
      apiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
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
        loginSource: "Memmy",
        invitationCode: "MEMMY-A1B2C3"
      })
    ).toMatchObject({
      channel: "phone",
      loginSource: "Memmy",
      invitationCode: "MEMMY-A1B2C3"
    });
    expect(() =>
      VerifyCodeInputSchema.parse({
        channel: "email",
        email: "hello@example.com",
        verificationCode: "123456",
        loginSource: "Memmy",
        invitationCode: "MEMMY-TOO-LONG"
      })
    ).toThrow();
    expect(() =>
      VerifyCodeInputSchema.parse({
        channel: "email",
        email: "hello@example.com",
        phoneNumber: "13800138000",
        verificationCode: "123456",
        loginSource: "Memmy"
      })
    ).toThrow();
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
    expect(
      AccountLoginResultViewSchema.parse({
        session: parsedSession,
        invitationResult: {
          status: "success",
          inviteeRewardTokens: 500_000
        }
      })
    ).toMatchObject({
      session: { authenticated: true },
      invitationResult: { status: "success", inviteeRewardTokens: 500_000 }
    });
    expect(
      AccountInvitationViewSchema.parse({
        enabled: true,
        invitationCode: "MEMMY-A1B2C3",
        usedInviteSlotsToday: 3,
        dailySuccessLimit: 5,
        remainingInvitesToday: 2,
        dailyLimitReached: false
      })
    ).toMatchObject({ invitationCode: "MEMMY-A1B2C3", remainingInvitesToday: 2 });
    expect(
      PromotionFlagsSchema.parse({
        loginBanner: true,
        improvementGift: true,
        improvementGiftRewardTokens: 1_000_000,
        applyMore: true,
        agentChatTokenTotal: 2_000_000,
        invitation: {
          enabled: true,
          inviterRewardTokens: 500_000,
          inviteeRewardTokens: 500_000,
          dailySuccessLimit: 5
        }
      }).invitation.enabled
    ).toBe(true);
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
