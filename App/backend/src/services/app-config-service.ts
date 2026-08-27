/** App config service module. */
import {
  AvatarOptionSchema,
  TokenUsageDtoSchema,
  canonicalCatalogProviderId
} from "@memmy/local-api-contracts";
import type {
  AppSettingsDto,
  AvatarOption,
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
import type { MemmyConfigWriter } from "../infrastructure/memmy-config/index.js";
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
/** Type definition for normalized model config input. */
/** Type definition for resolved model config test input. */
type ResolvedModelConfigTestInput = ModelConfigTestInput & { apiKey: string };

/** Creates create app config service. */
export function createAppConfigService(options: CreateAppConfigServiceOptions): AppConfigService {
  const modelConfigTester = options.modelConfigTester ?? createHttpModelConfigTester();

  return {
    async updateSettings(input) {
      const previousOnboarding = input.userMode === "byok" ? options.bootstrapRepository.getOnboardingState() : null;
      if (input.userMode) {
        await options.memmyConfigWriter?.writeUserMode?.(input.userMode);
      }
      const settings = options.bootstrapRepository.updateAppSettings(input);
      preserveCompletedGuideWhenSwitchingToByok(previousOnboarding, options);
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
        uuid: account.uuid
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
      if (!options.memmyConfigWriter?.readModelConfig) {
        throw new Error("Memmy config writer is not configured");
      }
      return options.memmyConfigWriter.readModelConfig();
    },

    async setModelConfig(input) {
      if (!options.memmyConfigWriter?.writeModelConfig) {
        throw new Error("Memmy config writer is not configured");
      }
      const config = await options.memmyConfigWriter.writeModelConfig(input);
      await options.memoryClient?.reloadConfig({ reason: "model_config_saved" });
      return config;
    },

    async testModelConfig(input) {
      return modelConfigTester.test(await resolveModelConfigTestInput(input, options.memmyConfigWriter));
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

/** Handles resolve model config test input. */
async function resolveModelConfigTestInput(
  input: ModelConfigTestInput,
  configWriter: MemmyConfigWriter | undefined
): Promise<ResolvedModelConfigTestInput> {
  const directApiKey = input.apiKey?.trim();
  if (directApiKey) {
    return { ...input, apiKey: directApiKey };
  }

  const provider = canonicalCatalogProviderId(input.provider);
  if (!provider || !input.endpointId) {
    throw Object.assign(new Error("Model config test requires a Provider endpoint"), { code: "invalid_argument" as const });
  }

  const storedApiKey = await configWriter?.readEndpointApiKey?.(provider, input.endpointId);
  if (!storedApiKey) {
    throw Object.assign(new Error("Model config API Key is not configured"), { code: "invalid_argument" as const });
  }

  return { ...input, apiKey: storedApiKey };
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
