/** Memmy local API contract. */
import { z } from "zod";

export * from "./memory-runtime.js";
export * from "./endpoints.js";
export * from "./cloud-service.js";

export const UserModeSchema = z.enum(["unset", "byok", "account"]);
export type UserMode = z.infer<typeof UserModeSchema>;

export const LanguageSchema = z.enum(["system", "zh-CN", "en-US"]);
export type Language = z.infer<typeof LanguageSchema>;

export const ThemeSchema = z.enum(["system", "light", "dark"]);
export type Theme = z.infer<typeof ThemeSchema>;

export const DefaultLaunchModeSchema = z.enum(["full", "pet", "last"]);
export type DefaultLaunchMode = z.infer<typeof DefaultLaunchModeSchema>;

// Schema for last launch mode.
export const LastLaunchModeSchema = z.enum(["full", "pet"]);
export type LastLaunchMode = z.infer<typeof LastLaunchModeSchema>;

export const OnboardingStepSchema = z.enum([
  "byok_setup_required",
  "account_auth_required",
  "scan_permission_required",
  "initial_report_required",
  "improvement_program_required",
  "product_tour_required",
  "completed"
]);
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;

export const ScanPermissionSchema = z.enum([
    "unset",
    "none",
    "scan_only",
    "scan_and_write_skill"
]);
export type ScanPermission = z.infer<typeof ScanPermissionSchema>;

export const ImprovementProgramSchema = z.enum([
    "unset",
    "accepted",
    "declined",
    "not_applicable"
]);
export type ImprovementProgram = z.infer<typeof ImprovementProgramSchema>;

export const AppSettingsDtoSchema = z.object({
    // User mode.
    userMode: UserModeSchema,
    // Language.
    language: LanguageSchema,
    // Theme.
    theme: ThemeSchema,
    // Auto update enabled.
    autoUpdateEnabled: z.boolean(),
    // Default launch mode.
    defaultLaunchMode: DefaultLaunchModeSchema.default("last"),
    // Last launch mode.
    lastLaunchMode: LastLaunchModeSchema.default("full"),
    // Avatar id.
    avatarId: z.string().min(1).default("memmy-default"),
    // Skin id.
    skinId: z.string().min(1).default("default"),
    // Task done notification enabled.
    taskDoneNotificationEnabled: z.boolean().default(true),
    // Notification sound enabled.
    notificationSoundEnabled: z.boolean().default(true),
    // Menu bar icon enabled.
    menuBarIconEnabled: z.boolean().default(true)
});
export type AppSettingsDto = z.infer<typeof AppSettingsDtoSchema>;

export const OnboardingStateDtoSchema = z.object({
  // Completed.
  completed: z.boolean(),
  // Current step.
  currentStep: OnboardingStepSchema,
  // Has accepted terms.
  hasAcceptedTerms: z.boolean(),
  // Accepted terms version.
  acceptedTermsVersion: z.string().nullable(),
  // Scan permission.
  scanPermission: ScanPermissionSchema,
  // Improvement program.
  improvementProgram: ImprovementProgramSchema,
  // Completed at.
  completedAt: z.string().datetime().nullable()
});
export type OnboardingStateDto = z.infer<typeof OnboardingStateDtoSchema>;

export const PrivacySettingsDtoSchema = z.object({
    telemetryOptIn: z.boolean(),
    crashReportOptIn: z.boolean(),
    allowMemoryImprovementUpload: z.boolean(),
    localOnlyMode: z.boolean()
});
export type PrivacySettingsDto = z.infer<typeof PrivacySettingsDtoSchema>;

export const TokenUsageDtoSchema = z.object({
    planName: z.string(),
    totalTokens: z.number().int().nonnegative(),
    usedTokens: z.number().int().nonnegative(),
    remainingTokens: z.number().int().nonnegative(),
    expiresAt: z.string().datetime().nullable(),
    lastSyncedAt: z.string().datetime().nullable()
});
export type TokenUsageDto = z.infer<typeof TokenUsageDtoSchema>;

export const ByokTokenUsageSourceSchema = z.enum(["agent", "memory"]);
export type ByokTokenUsageSource = z.infer<typeof ByokTokenUsageSourceSchema>;

export const ByokTokenUsageKindSchema = z.enum(["agent_chat", "memory_summary", "memory_evolution", "embedding"]);
export type ByokTokenUsageKind = z.infer<typeof ByokTokenUsageKindSchema>;

export const ByokTokenUsageEventSchema = z.object({
    id: z.string().min(1),
    kind: ByokTokenUsageKindSchema,
    source: ByokTokenUsageSourceSchema,
    operationId: z.string().min(1),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    cacheCreationInputTokens: z.number().int().nonnegative(),
    metadata: z.record(z.string(), z.unknown()),
    rawUsage: z.record(z.string(), z.unknown()),
    createdAt: z.string().datetime()
});
export type ByokTokenUsageEvent = z.infer<typeof ByokTokenUsageEventSchema>;

export const ByokTokenUsageByKindSchema = z.object({
    kind: ByokTokenUsageKindSchema,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    cacheCreationInputTokens: z.number().int().nonnegative(),
    eventCount: z.number().int().nonnegative(),
    updatedAt: z.string().datetime().nullable()
});
export type ByokTokenUsageByKind = z.infer<typeof ByokTokenUsageByKindSchema>;

export const ByokTokenUsageSummarySchema = z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    cacheCreationInputTokens: z.number().int().nonnegative(),
    updatedAt: z.string().datetime().nullable(),
    byKind: z.array(ByokTokenUsageByKindSchema)
});
export type ByokTokenUsageSummary = z.infer<typeof ByokTokenUsageSummarySchema>;

export const AgentGatewayRuntimeConfigSchema = z.object({
    baseUrl: z.string().url(),
    bootstrapSecret: z.string().min(1).optional()
});
export type AgentGatewayRuntimeConfig = z.infer<typeof AgentGatewayRuntimeConfigSchema>;

export const RuntimeConfigSchema = z.object({
    baseUrl: z.string().url(),
    localToken: z.string().min(1),
    agentGateway: AgentGatewayRuntimeConfigSchema.optional()
});
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export const HealthStatusSchema = z.enum(["ok", "mock", "unavailable"]);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

/** Schema for agent source status. */
export const AgentSourceStatusSchema = z.enum(["not_connected", "skill_installed", "plugin_installed"]);
export type AgentSourceStatus = z.infer<typeof AgentSourceStatusSchema>;

/** Schema for scan phase. */
export const ScanPhaseSchema = z.enum(["scan", "add", "summarize", "done", "stopped"]);
export type ScanPhase = z.infer<typeof ScanPhaseSchema>;

/** Schema for agent source view. */
export const AgentSourceViewSchema = z.object({
    sourceId: z.string().min(1),
    displayName: z.string().min(1),
    dataPath: z.string().min(1),
    builtin: z.boolean(),
    available: z.boolean(),
    status: AgentSourceStatusSchema,
    messageCount: z.number().int().nonnegative(),
    lastScannedAt: z.string().datetime().nullable()
});
export type AgentSourceView = z.infer<typeof AgentSourceViewSchema>;

/** Schema for agent source memory plugin conflict. */
export const AgentSourceMemoryPluginConflictSchema = z.object({
    sourceId: z.string().min(1),
    displayName: z.string().min(1),
    configPath: z.string().min(1),
    installedPluginId: z.string().min(1)
});
export type AgentSourceMemoryPluginConflict = z.infer<typeof AgentSourceMemoryPluginConflictSchema>;

export const AgentSourceMemoryPluginConflictsResponseSchema = z.object({
    conflicts: z.array(AgentSourceMemoryPluginConflictSchema)
});
export type AgentSourceMemoryPluginConflictsResponse = z.infer<typeof AgentSourceMemoryPluginConflictsResponseSchema>;

/** Schema for add manual input. */
export const AddManualInputSchema = z.object({
    displayName: z.string().min(1),
    dataPath: z.string().min(1)
});
export type AddManualInput = z.infer<typeof AddManualInputSchema>;

/** Schema for agent source id params. */
export const AgentSourceIdParamsSchema = z.object({
    sourceId: z.string().min(1)
});
export type AgentSourceIdParams = z.infer<typeof AgentSourceIdParamsSchema>;

/** Schema for agent source scan mode. */
export const AgentSourceScanModeSchema = z.enum(["initial_subset", "incremental", "full"]);
export type AgentSourceScanMode = z.infer<typeof AgentSourceScanModeSchema>;

export const AgentSourceScanInputSchema = z.preprocess(
    (value) => value ?? {},
    z.object({
        sourceId: z.string().min(1).optional(),
        mode: AgentSourceScanModeSchema.optional()
    }).transform((input) => ({
        sourceId: input.sourceId ?? "all",
        ...(input.mode ? { mode: input.mode } : {})
    }))
);
export type AgentSourceScanInput = z.infer<typeof AgentSourceScanInputSchema>;

export const OnboardingInsightActionTypeSchema = z.enum([
    "continue_task",
    "cross_agent_synthesis",
    "decision_doc",
    "problem_diagnosis",
    "open_ended"
]);
export type OnboardingInsightActionType = z.infer<typeof OnboardingInsightActionTypeSchema>;

export const OnboardingInsightActionSchema = z.object({
    type: OnboardingInsightActionTypeSchema,
    buttonLabel: z.string().min(1),
    description: z.string().min(1),
    contextSummary: z.string().min(1),
    relatedAgents: z.array(z.string().min(1)).default([]),
    topicKeywords: z.array(z.string().min(1)).default([]),
    suggestedPrompt: z.string().min(1)
});
export type OnboardingInsightAction = z.infer<typeof OnboardingInsightActionSchema>;

export const OnboardingInsightReportInputSchema = z.object({
    locale: z.enum(["zh-CN", "en-US"]).optional(),
    stream: z.boolean().optional()
}).default({});
export type OnboardingInsightReportInput = z.infer<typeof OnboardingInsightReportInputSchema>;

export const OnboardingInsightDiagnosticsSchema = z.object({
    discoveredAgentCount: z.number().int().nonnegative(),
    sampledQueryCount: z.number().int().nonnegative(),
    usedLlm: z.boolean(),
    elapsedMs: z.number().int().nonnegative(),
    agents: z.array(z.object({
        sourceId: z.string().min(1),
        displayName: z.string().min(1),
        recentSessionCount: z.number().int().nonnegative(),
        queryCount: z.number().int().nonnegative(),
        latestActivityAt: z.string().datetime().nullable()
    })).default([])
});
export type OnboardingInsightDiagnostics = z.infer<typeof OnboardingInsightDiagnosticsSchema>;

export const OnboardingInsightReportResponseSchema = z.object({
    status: z.enum(["ready", "fallback", "skipped"]),
    reportMarkdown: z.string(),
    primaryAction: OnboardingInsightActionSchema.optional(),
    secondaryActions: z.array(OnboardingInsightActionSchema).default([]),
    diagnostics: OnboardingInsightDiagnosticsSchema
});
export type OnboardingInsightReportResponse = z.infer<typeof OnboardingInsightReportResponseSchema>;

export const OnboardingInsightReportStreamEventSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("sampled"),
        diagnostics: OnboardingInsightDiagnosticsSchema
    }),
    z.object({
        type: z.literal("chunk"),
        delta: z.string()
    }),
    z.object({
        type: z.literal("done"),
        response: OnboardingInsightReportResponseSchema
    })
]);
export type OnboardingInsightReportStreamEvent = z.infer<typeof OnboardingInsightReportStreamEventSchema>;

/** Schema for agent source scan job response. */
export const AgentSourceScanJobResponseSchema = z.object({
    jobId: z.string().min(1)
});
export type AgentSourceScanJobResponse = z.infer<typeof AgentSourceScanJobResponseSchema>;

export const AgentSourceScanProgressPayloadSchema = z.object({
    jobId: z.string().min(1),
    sourceId: z.string().min(1),
    phase: ScanPhaseSchema,
    current: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    message: z.string().optional()
});
export type AgentSourceScanProgressPayload = z.infer<typeof AgentSourceScanProgressPayloadSchema>;

export const AgentSourceScanStatusResponseSchema = z.object({
    active: z.boolean(),
    progress: AgentSourceScanProgressPayloadSchema.nullable()
});
export type AgentSourceScanStatusResponse = z.infer<typeof AgentSourceScanStatusResponseSchema>;

/** Schema for scan preferences. */
export const ScanPreferencesSchema = z.object({
    autoScanKnownAgents: z.boolean(),
    watchFileChanges: z.boolean(),
    autoInjectSkill: z.boolean()
});
export type ScanPreferences = z.infer<typeof ScanPreferencesSchema>;

/** Definition for patch scan preferences input. */
export const PatchScanPreferencesInputSchema = ScanPreferencesSchema.partial();
export type PatchScanPreferencesInput = z.infer<typeof PatchScanPreferencesInputSchema>;

/** Schema for agent source auto inject result. */
export const AgentSourceAutoInjectResultSchema = z.object({
    ok: z.literal(true),
    skipped: z.boolean(),
    reason: z.string().optional(),
    installed: z.array(z.string().min(1)).default([]),
    failed: z.array(z.object({
        sourceId: z.string().min(1),
        reason: z.string().min(1)
    })).default([])
});
export type AgentSourceAutoInjectResult = z.infer<typeof AgentSourceAutoInjectResultSchema>;

/** Schema for ok response. */
export const OkResponseSchema = z.object({
    ok: z.literal(true)
});
export type OkResponse = z.infer<typeof OkResponseSchema>;

/** Schema for scan result. */
export const ScanResultSchema = z.object({
    sourceId: z.string().min(1),
    discoveredConversations: z.number().int().nonnegative(),
    emittedMessages: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    errors: z.array(
        z.object({
            conversationId: z.string().min(1),
            reason: z.string().min(1)
        })
    )
});
export type ScanResult = z.infer<typeof ScanResultSchema>;

/** Schema for legal agreement locale urls. */
export const LegalAgreementLocaleUrlsSchema = z.object({
    "zh-CN": z.string().url(),
    "en-US": z.string().url()
});
export type LegalAgreementLocaleUrls = z.infer<typeof LegalAgreementLocaleUrlsSchema>;

/** Schema for legal agreement urls. */
export const LegalAgreementUrlsSchema = z.object({
    terms: LegalAgreementLocaleUrlsSchema,
    data: LegalAgreementLocaleUrlsSchema
});
export type LegalAgreementUrls = z.infer<typeof LegalAgreementUrlsSchema>;

/** Schema for promotion flags. */
export const PromotionFlagsSchema = z.object({
    loginBanner: z.boolean(),
    improvementGift: z.boolean(),
    applyMore: z.boolean()
});
export type PromotionFlags = z.infer<typeof PromotionFlagsSchema>;

export const AppBootstrapResponseSchema = z.object({
    app: AppSettingsDtoSchema,
    onboarding: OnboardingStateDtoSchema,
    privacy: PrivacySettingsDtoSchema,
    scanPreferences: ScanPreferencesSchema.default({
        autoScanKnownAgents: true,
        watchFileChanges: true,
        autoInjectSkill: false
    }),
    tokenUsage: TokenUsageDtoSchema,
    health: z.object({
        localApi: z.literal("ok"),
        memory: HealthStatusSchema,
        cloud: HealthStatusSchema
    }),
    // Legal.
    legal: LegalAgreementUrlsSchema.optional(),
    // Src module.
    // Promotions.
    promotions: PromotionFlagsSchema.optional()
});
export type AppBootstrapResponse = z.infer<typeof AppBootstrapResponseSchema>;

/** Definition for patch app settings input. */
export const PatchAppSettingsInputSchema = z
    .object({
        userMode: UserModeSchema,
        language: LanguageSchema,
        theme: ThemeSchema,
        autoUpdateEnabled: z.boolean(),
        defaultLaunchMode: DefaultLaunchModeSchema,
        taskDoneNotificationEnabled: z.boolean(),
        notificationSoundEnabled: z.boolean(),
        menuBarIconEnabled: z.boolean()
    })
    .partial();
export type PatchAppSettingsInput = z.infer<typeof PatchAppSettingsInputSchema>;

/** Definition for patch privacy input. */
export const PatchPrivacyInputSchema = PrivacySettingsDtoSchema.partial();
export type PatchPrivacyInput = z.infer<typeof PatchPrivacyInputSchema>;

/** Definition for patch onboarding input. */
export const PatchOnboardingInputSchema = OnboardingStateDtoSchema.partial();
export type PatchOnboardingInput = z.infer<typeof PatchOnboardingInputSchema>;

/** Schema for set improvement program input. */
export const SetImprovementProgramInputSchema = z.object({
    improvementProgram: ImprovementProgramSchema
});
export type SetImprovementProgramInput = z.infer<typeof SetImprovementProgramInputSchema>;

/** Schema for set improvement program response. */
export const SetImprovementProgramResponseSchema = z.object({
    onboarding: OnboardingStateDtoSchema,
    privacy: PrivacySettingsDtoSchema,
    tokenUsage: TokenUsageDtoSchema
});
export type SetImprovementProgramResponse = z.infer<typeof SetImprovementProgramResponseSchema>;

export const ModelProviderSchema = z.enum([
    "openai_compatible",
    "anthropic",
    "google",
    "deepseek",
    "zhipu",
    "qwen",
    "kimi",
    "minimax",
    "baidu",
    "doubao"
]);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

export const EmbeddingModeSchema = z.enum(["local", "custom"]);
export type EmbeddingMode = z.infer<typeof EmbeddingModeSchema>;

export const ModelConfigTestCapabilitySchema = z.enum(["chat", "embedding", "asr", "image"]);
export type ModelConfigTestCapability = z.infer<typeof ModelConfigTestCapabilitySchema>;

/** Schema for model config test secret target. */
export const ModelConfigTestSecretTargetSchema = z.enum(["primary", "memory", "skill", "embedding", "asr", "image"]);
export type ModelConfigTestSecretTarget = z.infer<typeof ModelConfigTestSecretTargetSchema>;

export const ASR_PROVIDER = "aliyun" as const;
export const QWEN_ASR_MODEL_ID = "qwen3-asr-flash" as const;
export const ASR_DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1" as const;

export const AsrProviderSchema = z.literal(ASR_PROVIDER);
export type AsrProvider = z.infer<typeof AsrProviderSchema>;

export const AsrModelIdSchema = z.literal(QWEN_ASR_MODEL_ID);
export type AsrModelId = z.infer<typeof AsrModelIdSchema>;

/** Schema for asr model config input. */
export const AsrModelConfigInputSchema = z.object({
    provider: AsrProviderSchema,
    baseUrl: z.string().url(),
    modelId: AsrModelIdSchema,
    apiKey: z.string().min(1).optional()
});
export type AsrModelConfigInput = z.infer<typeof AsrModelConfigInputSchema>;

/** Definition for image gen providers. */
export const IMAGE_GEN_PROVIDERS = [
    "openai_compatible",
    "google",
    "zhipu",
    "qwen",
    "minimax",
    "baidu",
    "doubao"
] as const;

export const ImageGenProviderSchema = z.enum(IMAGE_GEN_PROVIDERS);
export type ImageGenProvider = z.infer<typeof ImageGenProviderSchema>;

/** Schema for image gen model config input. */
export const ImageGenModelConfigInputSchema = z.object({
    provider: ImageGenProviderSchema,
    baseUrl: z.string().url(),
    modelId: z.string().min(1),
    apiKey: z.string().min(1).optional()
});
export type ImageGenModelConfigInput = z.infer<typeof ImageGenModelConfigInputSchema>;


/** Schema for local embedding config input. */
export const LocalEmbeddingConfigInputSchema = z.object({
    mode: z.literal("local")
});

export const CustomEmbeddingConfigInputSchema = z.object({
    mode: z.literal("custom"),
    baseUrl: z.string().url(),
    modelId: z.string().min(1),
    apiKey: z.string().min(1).optional()
});

export const EmbeddingConfigInputSchema = z.discriminatedUnion("mode", [
    LocalEmbeddingConfigInputSchema,
    CustomEmbeddingConfigInputSchema
]);
export type EmbeddingConfigInput = z.infer<typeof EmbeddingConfigInputSchema>;

/** Schema for role model config input. */
export const RoleModelConfigInputSchema = z.object({
    provider: ModelProviderSchema,
    baseUrl: z.string().url(),
    modelId: z.string().min(1),
    apiKey: z.string().min(1).optional()
});
export type RoleModelConfigInput = z.infer<typeof RoleModelConfigInputSchema>;

/** Schema for memmy memory model config input. */
export const MemmyMemoryModelConfigInputSchema = z.object({
    summary: RoleModelConfigInputSchema,
    evolution: RoleModelConfigInputSchema
});
export type MemmyMemoryModelConfigInput = z.infer<typeof MemmyMemoryModelConfigInputSchema>;

/** Schema for model config input. */
export const ModelConfigInputSchema = z.object({
    provider: ModelProviderSchema,
    baseUrl: z.string().url(),
    modelId: z.string().min(1),
    apiKey: z.string().min(1).optional(),
    embedding: EmbeddingConfigInputSchema.optional(),
    memmyMemory: MemmyMemoryModelConfigInputSchema.optional(),
    asr: AsrModelConfigInputSchema.optional(),
    imageGen: ImageGenModelConfigInputSchema.optional()
});
export type ModelConfigInput = z.infer<typeof ModelConfigInputSchema>;

/** Definition for model config test input. */
export const ModelConfigTestInputSchema = ModelConfigInputSchema.pick({
    provider: true,
    baseUrl: true,
    modelId: true,
    apiKey: true
}).extend({
    capability: ModelConfigTestCapabilitySchema.optional(),
    secretTarget: ModelConfigTestSecretTargetSchema.optional()
});
export type ModelConfigTestInput = z.infer<typeof ModelConfigTestInputSchema>;

/** Schema for model config test result. */
export const ModelConfigTestResultSchema = z.object({
    ok: z.boolean(),
    message: z.string().min(1),
    checkedAt: z.string().datetime()
});
export type ModelConfigTestResult = z.infer<typeof ModelConfigTestResultSchema>;

/** Schema for local embedding config view. */
export const LocalEmbeddingConfigViewSchema = z.object({
    mode: z.literal("local"),
    baseUrl: z.null(),
    modelId: z.null(),
    hasApiKey: z.literal(false),
    apiKeyMasked: z.literal(""),
    apiKey: z.string().default("")
});

export const CustomEmbeddingConfigViewSchema = z.object({
    mode: z.literal("custom"),
    baseUrl: z.string().url(),
    modelId: z.string().min(1),
    hasApiKey: z.boolean(),
    apiKeyMasked: z.string(),
    apiKey: z.string().default("")
});

export const EmbeddingConfigViewSchema = z.discriminatedUnion("mode", [
    LocalEmbeddingConfigViewSchema,
    CustomEmbeddingConfigViewSchema
]);
export type EmbeddingConfigView = z.infer<typeof EmbeddingConfigViewSchema>;

/** Schema for role model config view. */
export const RoleModelConfigViewSchema = z.object({
    provider: ModelProviderSchema,
    baseUrl: z.string().url(),
    modelId: z.string(),
    hasApiKey: z.boolean(),
    apiKeyMasked: z.string(),
    apiKey: z.string().default("")
});
export type RoleModelConfigView = z.infer<typeof RoleModelConfigViewSchema>;

/** Schema for memmy memory model config view. */
export const MemmyMemoryModelConfigViewSchema = z.object({
    summary: RoleModelConfigViewSchema,
    evolution: RoleModelConfigViewSchema
});
export type MemmyMemoryModelConfigView = z.infer<typeof MemmyMemoryModelConfigViewSchema>;

/** Schema for asr model config view. */
export const AsrModelConfigViewSchema = z.object({
    provider: AsrProviderSchema,
    baseUrl: z.string().url(),
    modelId: AsrModelIdSchema,
    hasApiKey: z.boolean(),
    apiKeyMasked: z.string(),
    apiKey: z.string().default("")
});
export type AsrModelConfigView = z.infer<typeof AsrModelConfigViewSchema>;

/** Schema for image gen model config view. */
export const ImageGenModelConfigViewSchema = z.object({
    provider: ImageGenProviderSchema,
    baseUrl: z.string().url(),
    modelId: z.string().min(1),
    hasApiKey: z.boolean(),
    apiKeyMasked: z.string(),
    apiKey: z.string().default("")
});
export type ImageGenModelConfigView = z.infer<typeof ImageGenModelConfigViewSchema>;

/** Schema for model config view. */
export const ModelConfigViewSchema = z.object({
    provider: ModelProviderSchema,
    baseUrl: z.string().url(),
    modelId: z.string(),
    hasApiKey: z.boolean(),
    apiKeyMasked: z.string(),
    apiKey: z.string().default(""),
    embedding: EmbeddingConfigViewSchema.nullable(),
    memmyMemory: MemmyMemoryModelConfigViewSchema,
    asr: AsrModelConfigViewSchema.nullable(),
    imageGen: ImageGenModelConfigViewSchema.nullable(),
    updatedAt: z.string().datetime()
});
export type ModelConfigView = z.infer<typeof ModelConfigViewSchema>;

/** Schema for asr transcription input. */
export const AsrTranscriptionInputSchema = z.object({
    audioBase64: z.string().min(1),
    mimeType: z.string().min(1),
    durationMs: z.number().int().nonnegative().optional()
});
export type AsrTranscriptionInput = z.infer<typeof AsrTranscriptionInputSchema>;

/** Schema for asr transcription response. */
export const AsrTranscriptionResponseSchema = z.object({
    text: z.string(),
    modelId: AsrModelIdSchema,
    provider: AsrProviderSchema,
    source: z.enum(["account", "byok"]),
    transcribedAt: z.string().datetime()
});
export type AsrTranscriptionResponse = z.infer<typeof AsrTranscriptionResponseSchema>;

export const AccountChannelSchema = z.enum(["email", "phone"]);
export type AccountChannel = z.infer<typeof AccountChannelSchema>;

export const AccountLocaleSchema = z.enum(["zh", "en"]);
export type AccountLocale = z.infer<typeof AccountLocaleSchema>;

/** Definition for send code input. */
export const SendCodeInputSchema = z
    .object({
        channel: AccountChannelSchema,
        email: z.string().email().optional(),
        phoneNumber: z.string().min(3).optional(),
        locale: AccountLocaleSchema
    })
    .refine((input) => (input.channel === "email" ? Boolean(input.email) : Boolean(input.phoneNumber)), {
        message: "channel requires matching email or phoneNumber"
    });
export type SendCodeInput = z.infer<typeof SendCodeInputSchema>;

/** Schema for send code response. */
export const SendCodeResponseSchema = z.object({
    ok: z.literal(true),
    resendAfterSec: z.number().int().nonnegative()
});
export type SendCodeResponse = z.infer<typeof SendCodeResponseSchema>;

/** Definition for verify code input. */
export const VerifyCodeInputSchema = z
    .object({
        channel: AccountChannelSchema,
        email: z.string().email().optional(),
        phoneNumber: z.string().min(3).optional(),
        verificationCode: z.string().min(1),
        loginSource: z.literal("Memmy")
    })
    .refine((input) => (input.channel === "email" ? Boolean(input.email) : Boolean(input.phoneNumber)), {
        message: "channel requires matching email or phoneNumber"
    });
export type VerifyCodeInput = z.infer<typeof VerifyCodeInputSchema>;

/** Schema for update account profile input. */
export const UpdateAccountProfileInputSchema = z.object({
    nickname: z.string().min(1)
});
export type UpdateAccountProfileInput = z.infer<typeof UpdateAccountProfileInputSchema>;

/** Schema for account profile view. */
export const AccountProfileViewSchema = z.object({
    userId: z.string().min(1),
    email: z.string().email().nullable(),
    phoneNumber: z.string().min(3).nullable(),
    nickname: z.string().min(1),
    avatarUrl: z.string().nullable(),
    planType: z.string().nullable(),
    hasFinishedGuide: z.boolean().nullable(),
    region: z.string().nullable(),
    registeredAt: z.string().datetime().nullable()
});
export type AccountProfileView = z.infer<typeof AccountProfileViewSchema>;

/** Schema for account session view. */
export const AccountSessionViewSchema = z.discriminatedUnion("authenticated", [
    z.object({
        authenticated: z.literal(false)
    }),
    z.object({
        authenticated: z.literal(true),
        isNewUser: z.boolean(),
        profile: AccountProfileViewSchema
    })
]);
export type AccountSessionView = z.infer<typeof AccountSessionViewSchema>;

/** Schema for avatar option. */
export const AvatarOptionSchema = z.object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    assetKey: z.string().min(1),
    kind: z.enum(["image", "video"])
});
export type AvatarOption = z.infer<typeof AvatarOptionSchema>;

/** Schema for set avatar input. */
export const SetAvatarInputSchema = z.object({
    avatarId: z.string().min(1)
});
export type SetAvatarInput = z.infer<typeof SetAvatarInputSchema>;

/** Schema for set skin input. */
export const SetSkinInputSchema = z.object({
    skinId: z.string().min(1)
});
export type SetSkinInput = z.infer<typeof SetSkinInputSchema>;

/** Schema for export local data input. */
export const ExportLocalDataInputSchema = z.object({
    targetPath: z.string().min(1).optional()
});
export type ExportLocalDataInput = z.infer<typeof ExportLocalDataInputSchema>;

/** Schema for local data export response. */
export const LocalDataExportResponseSchema = z.object({
    exportPath: z.string().min(1),
    bytes: z.number().int().nonnegative()
});
export type LocalDataExportResponse = z.infer<typeof LocalDataExportResponseSchema>;

/** Schema for local data reveal response. */
export const LocalDataRevealResponseSchema = z.object({
    ok: z.literal(true),
    dataPath: z.string().min(1)
});
export type LocalDataRevealResponse = z.infer<typeof LocalDataRevealResponseSchema>;

/** Schema for clear local data input. */
export const ClearLocalDataInputSchema = z.object({
    confirm: z.literal(true)
});
export type ClearLocalDataInput = z.infer<typeof ClearLocalDataInputSchema>;

/** Schema for local data clear response. */
export const LocalDataClearResponseSchema = z.object({
    ok: z.literal(true),
    clearedAt: z.string().datetime()
});
export type LocalDataClearResponse = z.infer<typeof LocalDataClearResponseSchema>;

/** Schema for integration category. */
export const IntegrationCategorySchema = z.enum(["Chat", "Productivity", "Tools & Automation", "Social", "Platform"]);
export type IntegrationCategory = z.infer<typeof IntegrationCategorySchema>;

/** Schema for integration status. */
export const IntegrationStatusSchema = z.enum(["not_configured", "requesting_url", "awaiting_browser_auth", "connected", "error"]);
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;

/** Schema for integration auth kind. */
export const IntegrationAuthKindSchema = z.enum(["oauth", "apiKey", "qrCode", "none"]);
export type IntegrationAuthKind = z.infer<typeof IntegrationAuthKindSchema>;

/** Schema for integration icon kind. */
export const IntegrationIconKindSchema = z.enum(["svg", "letter"]);
export type IntegrationIconKind = z.infer<typeof IntegrationIconKindSchema>;

/** Schema for integration list item. */
export const IntegrationListItemSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    iconText: z.string().min(1),
    category: IntegrationCategorySchema,
    isChannel: z.boolean(),
    authKind: IntegrationAuthKindSchema,
    brand: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    iconKind: IntegrationIconKindSchema,
    status: IntegrationStatusSchema,
    lastError: z.string().min(1).optional()
});
export type IntegrationListItem = z.infer<typeof IntegrationListItemSchema>;

/** Definition for integration detail. */
export const IntegrationDetailSchema = IntegrationListItemSchema.extend({
    summary: z.string().min(1),
    description: z.string().min(1),
    permissions: z.array(z.string().min(1)),
    authKind: IntegrationAuthKindSchema,
    docsUrl: z.string().url().optional(),
    requiresQrCode: z.boolean().default(false),
    lastError: z.string().min(1).optional()
});
export type IntegrationDetail = z.infer<typeof IntegrationDetailSchema>;

/** Schema for connect integration input. */
export const ConnectIntegrationInputSchema = z.object({
    id: z.string().min(1),
    apiKey: z.string().min(1).optional(),
    oauthCallback: z.string().min(1).optional()
});
export type ConnectIntegrationInput = z.infer<typeof ConnectIntegrationInputSchema>;

/** Schema for request connect url response. */
export const RequestConnectUrlResponseSchema = z.object({
    url: z.union([z.string().url(), z.literal("")]),
    pollToken: z.string().min(1).optional()
});
export type RequestConnectUrlResponse = z.infer<typeof RequestConnectUrlResponseSchema>;

/** Schema for integration capabilities response. */
export const IntegrationCapabilitiesResponseSchema = z.object({
  toolkits: z.array(z.string().min(1))
});
export type IntegrationCapabilitiesResponse = z.infer<typeof IntegrationCapabilitiesResponseSchema>;

/** Schema for integration connection. */
export const IntegrationConnectionSchema = z.object({
    id: z.string().min(1),
    toolkit: z.string().min(1),
    status: z.string().min(1),
    createdAt: z.string().datetime().optional(),
    accountEmail: z.string().min(1).optional(),
    workspace: z.string().min(1).optional(),
    username: z.string().min(1).optional()
});
export type IntegrationConnection = z.infer<typeof IntegrationConnectionSchema>;

/** Schema for authorize integration response. */
export const AuthorizeIntegrationResponseSchema = z.object({
    connectUrl: z.string().url(),
    connectionId: z.string().min(1)
});
export type AuthorizeIntegrationResponse = z.infer<typeof AuthorizeIntegrationResponseSchema>;

/** Schema for integration connections response. */
export const IntegrationConnectionsResponseSchema = z.object({
    connections: z.array(IntegrationConnectionSchema)
});
export type IntegrationConnectionsResponse = z.infer<typeof IntegrationConnectionsResponseSchema>;

/** Schema for execute integration tool input. */
export const ExecuteIntegrationToolInputSchema = z.object({
    toolSlug: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional()
});
export type ExecuteIntegrationToolInput = z.infer<typeof ExecuteIntegrationToolInputSchema>;

/** Definition for integration tool result. */
export const IntegrationToolResultSchema = z
    .object({
        data: z.unknown(),
        successful: z.boolean().optional(),
        error: z.unknown().optional()
    })
    .passthrough();
export type IntegrationToolResult = z.infer<typeof IntegrationToolResultSchema>;

/** Schema for channel provider. */
export const ChannelProviderSchema = z.enum(["telegram", "discord", "imessage", "wechat", "feishu", "dingtalk"]);
export type ChannelProvider = z.infer<typeof ChannelProviderSchema>;

/** Schema for channel runtime. */
export const ChannelRuntimeSchema = z.enum(["telegram", "discord", "imessage", "weixin", "feishu", "dingtalk"]);
export type ChannelRuntime = z.infer<typeof ChannelRuntimeSchema>;

/** Schema for channel auth kind. */
export const ChannelAuthKindSchema = z.enum(["qrCode", "form", "disabled", "local"]);
export type ChannelAuthKind = z.infer<typeof ChannelAuthKindSchema>;

/** Schema for channel status. */
export const ChannelStatusSchema = z.enum([
  "disabled",
  "pendingQr",
  "starting",
  "connected",
  "restarting",
  "expired",
  "error",
  "unsupported"
]);
export type ChannelStatus = z.infer<typeof ChannelStatusSchema>;

/** Schema for channel capability. */
export const ChannelCapabilitySchema = z.enum(["receiveText", "sendText", "receiveMedia", "sendMedia", "streaming"]);
export type ChannelCapability = z.infer<typeof ChannelCapabilitySchema>;

/** Schema for channel field. */
export const ChannelFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["text", "secret"]),
  required: z.boolean()
});
export type ChannelField = z.infer<typeof ChannelFieldSchema>;

/** Schema for channel definition. */
export const ChannelDefinitionSchema = z.object({
  id: ChannelProviderSchema,
  runtimeChannel: ChannelRuntimeSchema,
  name: z.string().min(1),
  authKind: ChannelAuthKindSchema,
  enabled: z.boolean(),
  capabilities: z.array(ChannelCapabilitySchema),
  fields: z.array(ChannelFieldSchema).default([])
});
export type ChannelDefinition = z.infer<typeof ChannelDefinitionSchema>;

/** Schema for channel connection. */
export const ChannelConnectionSchema = z.object({
  id: z.string().min(1),
  provider: ChannelProviderSchema,
  runtimeChannel: ChannelRuntimeSchema,
  status: ChannelStatusSchema,
  running: z.boolean(),
  displayName: z.string().min(1),
  // Last error.
  lastError: z.string().nullish(),
  updatedAt: z.string().datetime().optional()
});
export type ChannelConnection = z.infer<typeof ChannelConnectionSchema>;

export const ChannelDefinitionsResponseSchema = z.object({
  channels: z.array(ChannelDefinitionSchema)
});
export type ChannelDefinitionsResponse = z.infer<typeof ChannelDefinitionsResponseSchema>;

export const ChannelConnectionsResponseSchema = z.object({
  connections: z.array(ChannelConnectionSchema)
});
export type ChannelConnectionsResponse = z.infer<typeof ChannelConnectionsResponseSchema>;

/** Schema for connect channel input. */
export const ConnectChannelInputSchema = z.object({
  appId: z.string().min(1).optional(),
  appSecret: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
  token: z.string().min(1).optional()
});
export type ConnectChannelInput = z.infer<typeof ConnectChannelInputSchema>;

/** Schema for connect channel response. */
export const ConnectChannelResponseSchema = z.object({
  status: ChannelStatusSchema,
  connectionId: z.string().min(1),
  qrCodeDataUrl: z.string().min(1).optional(),
  pollToken: z.string().min(1).optional()
});
export type ConnectChannelResponse = z.infer<typeof ConnectChannelResponseSchema>;

export const PollChannelConnectResponseSchema = ConnectChannelResponseSchema;
export type PollChannelConnectResponse = z.infer<typeof PollChannelConnectResponseSchema>;

export const ConnectedSseEventSchema = z.object({
    id: z.string(),
    type: z.literal("app.connected"),
    timestamp: z.string().datetime(),
    payload: z.object({
        connectedAt: z.string().datetime()
    })
});

export const HeartbeatSseEventSchema = z.object({
    id: z.string(),
    type: z.literal("app.heartbeat"),
    timestamp: z.string().datetime(),
    payload: z.object({
        sentAt: z.string().datetime()
    })
});

/** Schema for scan progress sse event. */
export const ScanProgressSseEventSchema = z.object({
    id: z.string(),
    type: z.literal("agent_source.scan_progress"),
    timestamp: z.string().datetime(),
    payload: AgentSourceScanProgressPayloadSchema
});

/** Schema for scan completed sse event. */
export const ScanCompletedSseEventSchema = z.object({
    id: z.string(),
    type: z.literal("agent_source.scan_completed"),
    timestamp: z.string().datetime(),
    payload: z.object({
        jobId: z.string().min(1),
        results: z.array(ScanResultSchema)
    })
});

export const SseEventSchema = z.discriminatedUnion("type", [
    ConnectedSseEventSchema,
    HeartbeatSseEventSchema,
    ScanProgressSseEventSchema,
    ScanCompletedSseEventSchema
]);
export type SseEvent = z.infer<typeof SseEventSchema>;

// Schema for request token quota input.
export const RequestTokenQuotaInputSchema = z.object({
    reason: z.string().trim().min(20).max(1000)
});
export type RequestTokenQuotaInput = z.infer<typeof RequestTokenQuotaInputSchema>;

export const TokenQuotaApplyResultSchema = z.object({
    requestId: z.string().min(1),
    status: z.enum(["pending", "approved", "rejected"])
});
export type TokenQuotaApplyResult = z.infer<typeof TokenQuotaApplyResultSchema>;
