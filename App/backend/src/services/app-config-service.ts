/** App config service module. */
import { AvatarOptionSchema, TokenUsageDtoSchema } from "@memmy/local-api-contracts";
import type {
  AppSettingsDto,
  AvatarOption,
  EmbeddingConfigInput,
  ImageGenModelConfigInput,
  MemmyMemoryModelConfigInput,
  ModelConfigInput,
  ModelConfigTestInput,
  ModelConfigTestResult,
  ModelConfigView,
  OnboardingStateDto,
  PatchAppSettingsInput,
  PatchOnboardingInput,
  PatchPrivacyInput,
  PatchScanPreferencesInput,
  PrivacySettingsDto,
  ScanPreferences,
  SetAvatarInput,
  SetImprovementProgramInput,
  SetImprovementProgramResponse,
  SetSkinInput,
  TokenUsageDto
} from "@memmy/local-api-contracts";
import type { CloudClient } from "../adapters/outbound/cloud-client/index.js";
import type { AccountSessionRepository } from "../infrastructure/app-state-store/repositories/account-session-repo.js";
import type { BootstrapRepository } from "../infrastructure/app-state-store/repositories/bootstrap-repo.js";
import type { ModelConfigRepository } from "../infrastructure/app-state-store/repositories/model-config-repo.js";
import type { MemmyConfigWriter, RuntimeProjectionResult } from "../infrastructure/memmy-config/index.js";
import type { MemoryClient } from "../adapters/outbound/memory-client/index.js";
import { createHttpModelConfigTester, type ModelConfigTester } from "./model-config-tester.js";

export interface AppConfigService {
  updateSettings(input: PatchAppSettingsInput): Promise<AppSettingsDto>;
  updatePrivacy(input: PatchPrivacyInput): Promise<PrivacySettingsDto>;
  updateScanPreferences(input: PatchScanPreferencesInput): Promise<ScanPreferences>;
  updateOnboarding(input: PatchOnboardingInput): Promise<OnboardingStateDto>;
  setImprovementProgram(input: SetImprovementProgramInput): Promise<SetImprovementProgramResponse>;
  getTokenUsage(): Promise<TokenUsageDto>;
  getModelConfig(): Promise<ModelConfigView>;
  setModelConfig(input: ModelConfigInput): Promise<ModelConfigView>;
  testModelConfig(input: ModelConfigTestInput): Promise<ModelConfigTestResult>;
  listAvatars(): Promise<AvatarOption[]>;
  setAvatar(input: SetAvatarInput): Promise<{ avatarId: string }>;
  setSkin(input: SetSkinInput): Promise<{ skinId: string }>;
}

export interface CreateAppConfigServiceOptions {
  bootstrapRepository: Pick<
    BootstrapRepository,
    | "updateAppSettings"
    | "getAppSettings"
    | "getOnboardingState"
    | "updatePrivacy"
    | "updateScanPreferences"
    | "updateOnboarding"
    | "setAvatarSkin"
    | "getPrivacySettings"
  >;
  modelConfigRepository?: ModelConfigRepository;
  modelConfigTester?: ModelConfigTester;
  cloudClient?: Pick<CloudClient, "getTokenUsage" | "grantImprovementProgramTokens">;
  accountSessionRepository?: Pick<AccountSessionRepository, "get" | "getCloudUuid">;
  memmyConfigWriter?: MemmyConfigWriter;
  memoryClient?: Pick<MemoryClient, "reloadConfig">;
}

const BUILT_IN_AVATARS = AvatarOptionSchema.array().parse([
  {
    id: "memmy-default",
    displayName: "Memmy",
    assetKey: "avatar.memmy.default",
    kind: "image"
  },
  {
    id: "memmy-focus",
    displayName: "Memmy Focus",
    assetKey: "avatar.memmy.focus",
    kind: "image"
  },
  {
    id: "memmy-live",
    displayName: "Memmy Live",
    assetKey: "avatar.memmy.live",
    kind: "video"
  }
]);
const IMPROVEMENT_PROGRAM_TOKEN_EXTRA = 5_000_000;
// Idempotency key sent to the cloud so the improvement-program grant is applied at most once per user,
// even if local data is deleted and the user re-accepts after reinstalling.
const IMPROVEMENT_PROGRAM_GRANT_KEY = "improvement_program";
/** Type definition for normalized model config input. */
type NormalizedModelConfigInput = ModelConfigInput & { memmyMemory: MemmyMemoryModelConfigInput };

/** Type definition for resolved model config test input. */
type ResolvedModelConfigTestInput = ModelConfigTestInput & { apiKey: string };

/** Creates create app config service. */
export function createAppConfigService(options: CreateAppConfigServiceOptions): AppConfigService {
  const modelConfigTester = options.modelConfigTester ?? createHttpModelConfigTester();

  return {
    async updateSettings(input) {
      const previousOnboarding = input.userMode === "byok" ? options.bootstrapRepository.getOnboardingState() : null;
      const settings = options.bootstrapRepository.updateAppSettings(input);
      preserveCompletedGuideWhenSwitchingToByok(previousOnboarding, options);
      if (input.userMode && options.memmyConfigWriter) {
        await writeRuntimeProjectionForUserMode(input.userMode, options);
      }
      return settings;
    },

    async updatePrivacy(input) {
      return options.bootstrapRepository.updatePrivacy(input);
    },

    async updateScanPreferences(input) {
      return options.bootstrapRepository.updateScanPreferences(input);
    },

    async updateOnboarding(input) {
      return options.bootstrapRepository.updateOnboarding(input);
    },

    async setImprovementProgram(input) {
      const onboarding = options.bootstrapRepository.updateOnboarding({
        improvementProgram: input.improvementProgram,
        currentStep: "product_tour_required"
      });

      if (input.improvementProgram !== "accepted") {
        return {
          onboarding,
          privacy: options.bootstrapRepository.getPrivacySettings(),
          tokenUsage: await fetchCloudTokenUsage(options)
        };
      }

      const privacy = options.bootstrapRepository.updatePrivacy({
        allowMemoryImprovementUpload: true
      });
      const cloudClient = getConfiguredCloudClient(options);
      const account = getAuthenticatedCloudAccount(options);
      const grantedTokenUsage = await cloudClient.grantImprovementProgramTokens({
        uuid: account.uuid,
        tokenExtra: IMPROVEMENT_PROGRAM_TOKEN_EXTRA,
        grantKey: IMPROVEMENT_PROGRAM_GRANT_KEY
      });
      const tokenUsage = TokenUsageDtoSchema.parse(grantedTokenUsage);

      return {
        onboarding,
        privacy,
        tokenUsage
      };
    },

    async getTokenUsage() {
      return fetchCloudTokenUsage(options);
    },

    async getModelConfig() {
      if (!options.modelConfigRepository) {
        throw new Error("Model config repository is not configured");
      }

      return options.modelConfigRepository.get();
    },

    async setModelConfig(input) {
      if (!options.modelConfigRepository) {
        throw new Error("Model config repository is not configured");
      }

      const normalizedInput = normalizeMemmyMemoryModelConfig(input);
      const config = options.modelConfigRepository.upsert(normalizedInput);
      const activateByok = options.bootstrapRepository.getAppSettings().userMode === "byok";
      const projection = await options.memmyConfigWriter?.writeByokModelProjection(normalizedInput, {
        activate: activateByok
      });
      if (activateByok) {
        await reloadMemoryConfigIfNeeded(projection, options, "byok_model_saved");
      }
      return config;
    },

    async testModelConfig(input) {
      return modelConfigTester.test(resolveModelConfigTestInput(input, options.modelConfigRepository));
    },

    async listAvatars() {
      return BUILT_IN_AVATARS;
    },

    async setAvatar(input) {
      ensureAvatarExists(input.avatarId);
      const settings = options.bootstrapRepository.setAvatarSkin({
        avatarId: input.avatarId
      });
      return { avatarId: settings.avatarId };
    },

    async setSkin(input) {
      const settings = options.bootstrapRepository.setAvatarSkin({
        skinId: input.skinId
      });
      return { skinId: settings.skinId };
    }
  };
}

/** Fetches platform Token usage from Cloud only. */
async function fetchCloudTokenUsage(options: CreateAppConfigServiceOptions): Promise<TokenUsageDto> {
  const cloudClient = getConfiguredCloudClient(options);
  const account = getAuthenticatedCloudAccount(options);
  const usage = await cloudClient.getTokenUsage({
    userId: account.userId,
    uuid: account.uuid
  });
  return TokenUsageDtoSchema.parse(usage);
}

/** Handles preserve completed guide when switching to byok. */
function preserveCompletedGuideWhenSwitchingToByok(
  previousOnboarding: OnboardingStateDto | null,
  options: CreateAppConfigServiceOptions
): void {
  if (!previousOnboarding?.completed) {
    return;
  }

  const byokOnboarding = options.bootstrapRepository.getOnboardingState();
  if (byokOnboarding.completed) {
    return;
  }

  options.bootstrapRepository.updateOnboarding({
    completed: true,
    currentStep: "completed",
    completedAt: previousOnboarding.completedAt ?? new Date().toISOString(),
    hasAcceptedTerms: previousOnboarding.hasAcceptedTerms,
    acceptedTermsVersion: previousOnboarding.acceptedTermsVersion,
    scanPermission: previousOnboarding.scanPermission,
    improvementProgram: previousOnboarding.improvementProgram
  });
}

/** Normalizes normalize memmy memory model config. */
function normalizeMemmyMemoryModelConfig(input: ModelConfigInput): NormalizedModelConfigInput {
  return {
    ...input,
    memmyMemory: input.memmyMemory ?? {
      summary: {
        provider: input.provider,
        baseUrl: input.baseUrl,
        modelId: input.modelId,
        apiKey: input.apiKey
      },
      evolution: {
        provider: input.provider,
        baseUrl: input.baseUrl,
        modelId: input.modelId,
        apiKey: input.apiKey
      }
    }
  };
}

/** Handles resolve model config test input. */
function resolveModelConfigTestInput(
  input: ModelConfigTestInput,
  repository: ModelConfigRepository | undefined
): ResolvedModelConfigTestInput {
  const directApiKey = input.apiKey?.trim();
  if (directApiKey) {
    return { ...input, apiKey: directApiKey };
  }

  if (!input.secretTarget) {
    throw Object.assign(new Error("Model config test requires an API Key"), { code: "invalid_argument" as const });
  }

  if (!repository?.getTestApiKey) {
    throw Object.assign(new Error("Model config repository is not configured"), { code: "invalid_argument" as const });
  }

  const storedApiKey = repository.getTestApiKey(input.secretTarget);
  if (!storedApiKey) {
    throw Object.assign(new Error("Model config API Key is not configured"), { code: "invalid_argument" as const });
  }

  return { ...input, apiKey: storedApiKey };
}

/** Writes write runtime projection for user mode. */
async function writeRuntimeProjectionForUserMode(
  userMode: AppSettingsDto["userMode"],
  options: CreateAppConfigServiceOptions
): Promise<void> {
  if (!options.memmyConfigWriter) return;

  if (userMode === "account") {
    const account = getAuthenticatedCloudAccount(options);
    const accountProjection = await options.memmyConfigWriter.writeAccountModelProjection({
      cloudUuid: account.uuid,
      userId: account.userId
    });
    await reloadMemoryConfigIfNeeded(accountProjection, options, "account_profile_projected");
    return;
  }

  if (userMode === "byok") {
    if (!options.modelConfigRepository) {
      throw Object.assign(new Error("Model config repository is not configured"), { code: "invalid_argument" as const });
    }
    const modelConfig = options.modelConfigRepository.get();
    if (!modelConfig.hasApiKey) {
      return;
    }
    const byokProjection = await options.memmyConfigWriter.writeByokModelProjection(modelConfigViewToInput(modelConfig), {
      activate: true
    });
    await reloadMemoryConfigIfNeeded(byokProjection, options, "byok_profile_projected");
  }
}

/** Handles model config view to input. */
function modelConfigViewToInput(view: ModelConfigView): NormalizedModelConfigInput {
  return {
    provider: view.provider,
    baseUrl: view.baseUrl,
    modelId: view.modelId,
    embedding: embeddingViewToInput(view.embedding),
    imageGen: imageGenViewToInput(view.imageGen),
    memmyMemory: {
      summary: {
        provider: view.memmyMemory.summary.provider,
        baseUrl: view.memmyMemory.summary.baseUrl,
        modelId: view.memmyMemory.summary.modelId
      },
      evolution: {
        provider: view.memmyMemory.evolution.provider,
        baseUrl: view.memmyMemory.evolution.baseUrl,
        modelId: view.memmyMemory.evolution.modelId
      }
    }
  };
}

function imageGenViewToInput(view: ModelConfigView["imageGen"]): ImageGenModelConfigInput | undefined {
  if (!view) return undefined;
  return {
    provider: view.provider,
    baseUrl: view.baseUrl,
    modelId: view.modelId,
    apiKey: view.apiKey || undefined
  };
}

/** Handles embedding view to input. */
function embeddingViewToInput(view: ModelConfigView["embedding"]): EmbeddingConfigInput | undefined {
  if (!view) return undefined;
  if (view.mode === "local") return { mode: "local" };
  return {
    mode: "custom",
    baseUrl: view.baseUrl,
    modelId: view.modelId
  };
}

async function reloadMemoryConfigIfNeeded(
  projection: RuntimeProjectionResult | undefined,
  options: CreateAppConfigServiceOptions,
  reason: string
): Promise<void> {
  if (!projection?.changed || !projection.activeProfileAffected || !options.memoryClient) {
    return;
  }
  await options.memoryClient.reloadConfig({ reason });
}

/** Reads get authenticated cloud account. */
function getAuthenticatedCloudAccount(options: CreateAppConfigServiceOptions): { userId: string; uuid: string } {
  if (!options.accountSessionRepository) {
    throw Object.assign(new Error("Cloud account dependencies are not configured"), { code: "unauthorized" as const });
  }

  const session = options.accountSessionRepository.get();
  const uuid = options.accountSessionRepository.getCloudUuid();
  if (!session.authenticated || !uuid) {
    throw Object.assign(new Error("Account session is not authenticated"), { code: "unauthorized" as const });
  }

  return {
    userId: session.profile.userId,
    uuid
  };
}

/** Reads get configured cloud client. */
function getConfiguredCloudClient(options: CreateAppConfigServiceOptions): Pick<CloudClient, "getTokenUsage" | "grantImprovementProgramTokens"> {
  if (!options.cloudClient) {
    throw Object.assign(new Error("Cloud account dependencies are not configured"), { code: "unauthorized" as const });
  }

  return options.cloudClient;
}

/** Validates ensure avatar exists. */
function ensureAvatarExists(avatarId: string): void {
  if (!BUILT_IN_AVATARS.some((avatar) => avatar.id === avatarId)) {
    throw Object.assign(new Error("Avatar not found"), { code: "not_found" as const });
  }
}
