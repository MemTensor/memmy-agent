/** Runtime config sync service module. */
import {
  ModelConfigInputSchema,
  type ImageGenProvider,
  type MemmyMemoryModelConfigInput,
  type ModelConfigInput,
  type ModelProvider,
  type UserMode
} from "@memmy/local-api-contracts";
import { LOCAL_BYOK_ACCOUNT_UUID } from "../infrastructure/app-state-store/account-context.js";
import {
  createAppStateStore,
  type AppStateStore
} from "../infrastructure/app-state-store/index.js";
import {
  readRuntimeMemmyConfigState,
  writeAccountModelProjectionToMemmyConfig,
  writeByokModelProjectionToMemmyConfig,
  type RuntimeMemmyConfigState
} from "../infrastructure/memmy-config/index.js";

export interface SyncRuntimeConfigWithAppStateOptions {
  appStateStore: AppStateStore;
  memmyConfigPath: string;
}

export interface SyncRuntimeConfigForStartupOptions {
  databasePath: string;
  memmyConfigPath: string;
}

export interface RuntimeConfigSyncResult {
  source: "runtime_config" | "app_state_fallback" | "none";
  mode: UserMode;
  provider?: string;
  model?: string;
  hydratedAppState: boolean;
  wroteConfig: boolean;
  reason: string;
}

interface ModelConfigProjectionRow {
  provider: string;
  base_url: string;
  model_id: string;
  api_key_ref: string | null;
  embedding_mode: string;
  embedding_base_url: string | null;
  embedding_model_id: string | null;
  embedding_api_key_ref: string | null;
  memory_provider: string | null;
  memory_base_url: string | null;
  memory_model_id: string | null;
  memory_api_key_ref: string | null;
  skill_provider: string | null;
  skill_base_url: string | null;
  skill_model_id: string | null;
  skill_api_key_ref: string | null;
  image_provider: string | null;
  image_base_url: string | null;
  image_model_id: string | null;
  image_api_key_ref: string | null;
}

type RuntimeConfigSyncErrorState = {
  status: "invalid_yaml" | "conflict" | "no_model_config";
  configPath: string;
  reason: string;
};

/** Handles sync runtime config with app state. */
export async function syncRuntimeConfigWithAppState(
  options: SyncRuntimeConfigWithAppStateOptions
): Promise<RuntimeConfigSyncResult> {
  const state = await readRuntimeMemmyConfigState(options.memmyConfigPath);
  switch (state.status) {
    case "valid_byok":
      return hydrateByokRuntimeConfig(options.appStateStore, state);
    case "valid_account":
      return hydrateAccountRuntimeConfig(options.appStateStore, state);
    case "missing":
    case "empty":
      return syncMissingRuntimeConfigFromAppState(options.appStateStore, options.memmyConfigPath, state.status);
    case "no_model_config":
      return {
        source: "none",
        mode: options.appStateStore.repositories.bootstrap.getAppSettings().userMode,
        hydratedAppState: false,
        wroteConfig: false,
        reason: state.reason
      };
    case "invalid_yaml":
    case "conflict":
      throw createRuntimeConfigSyncError(state);
  }
}

/** Handles sync runtime config for startup. */
export async function syncRuntimeConfigForStartup(
  options: SyncRuntimeConfigForStartupOptions
): Promise<RuntimeConfigSyncResult> {
  const appStateStore = createAppStateStore({ databasePath: options.databasePath });
  try {
    return await syncRuntimeConfigWithAppState({
      appStateStore,
      memmyConfigPath: options.memmyConfigPath
    });
  } finally {
    appStateStore.close();
  }
}

function hydrateByokRuntimeConfig(
  appStateStore: AppStateStore,
  state: Extract<RuntimeMemmyConfigState, { status: "valid_byok" }>
): RuntimeConfigSyncResult {
  appStateStore.repositories.modelConfig.upsert(state.modelConfig);
  appStateStore.repositories.bootstrap.updateAppSettings({ userMode: "byok" });
  return {
    source: "runtime_config",
    mode: "byok",
    provider: state.modelConfig.provider,
    model: state.modelConfig.modelId,
    hydratedAppState: true,
    wroteConfig: false,
    reason: "hydrated_byok_from_runtime_config"
  };
}

function hydrateAccountRuntimeConfig(
  appStateStore: AppStateStore,
  state: Extract<RuntimeMemmyConfigState, { status: "valid_account" }>
): RuntimeConfigSyncResult {
  appStateStore.repositories.accountSession.activateByCloudUuid(state.cloudUuid);
  appStateStore.repositories.bootstrap.updateAppSettings({ userMode: "account" });
  return {
    source: "runtime_config",
    mode: "account",
    provider: "memmy_account",
    model: "agent_chat",
    hydratedAppState: true,
    wroteConfig: false,
    reason: "hydrated_account_from_runtime_config"
  };
}

async function syncMissingRuntimeConfigFromAppState(
  appStateStore: AppStateStore,
  memmyConfigPath: string,
  stateStatus: "missing" | "empty"
): Promise<RuntimeConfigSyncResult> {
  const appSettings = appStateStore.repositories.bootstrap.getAppSettings();
  if (appSettings.userMode === "account") {
    return syncAccountRuntimeConfigFromAppState(appStateStore, memmyConfigPath, stateStatus);
  }

  if (appSettings.userMode === "byok") {
    return syncByokRuntimeConfigFromAppState(appStateStore, memmyConfigPath, stateStatus);
  }

  return {
    source: "none",
    mode: "unset",
    hydratedAppState: false,
    wroteConfig: false,
    reason: `${stateStatus}_runtime_config_and_unset_app_state`
  };
}

async function syncAccountRuntimeConfigFromAppState(
  appStateStore: AppStateStore,
  memmyConfigPath: string,
  stateStatus: "missing" | "empty"
): Promise<RuntimeConfigSyncResult> {
  const session = appStateStore.repositories.accountSession.get();
  const cloudUuid = appStateStore.repositories.accountSession.getCloudUuid();
  if (!session.authenticated || !cloudUuid) {
    return {
      source: "none",
      mode: "account",
      hydratedAppState: false,
      wroteConfig: false,
      reason: `${stateStatus}_runtime_config_without_authenticated_account`
    };
  }

  await writeAccountModelProjectionToMemmyConfig({
    cloudUuid,
    userId: session.profile.userId
  }, memmyConfigPath);
  return {
    source: "app_state_fallback",
    mode: "account",
    provider: "memmy_account",
    model: "agent_chat",
    hydratedAppState: false,
    wroteConfig: true,
    reason: `${stateStatus}_runtime_config_initialized_from_account_app_state`
  };
}

async function syncByokRuntimeConfigFromAppState(
  appStateStore: AppStateStore,
  memmyConfigPath: string,
  stateStatus: "missing" | "empty"
): Promise<RuntimeConfigSyncResult> {
  const modelConfig = readByokRuntimeProjectionInput(appStateStore);
  if (!modelConfig) {
    return {
      source: "none",
      mode: "byok",
      hydratedAppState: false,
      wroteConfig: false,
      reason: `${stateStatus}_runtime_config_without_valid_byok_app_state`
    };
  }

  await writeByokModelProjectionToMemmyConfig(modelConfig, memmyConfigPath, { activate: true });
  return {
    source: "app_state_fallback",
    mode: "byok",
    provider: modelConfig.provider,
    model: modelConfig.modelId,
    hydratedAppState: false,
    wroteConfig: true,
    reason: `${stateStatus}_runtime_config_initialized_from_byok_app_state`
  };
}

function readByokRuntimeProjectionInput(
  appStateStore: AppStateStore
): (ModelConfigInput & { memmyMemory: MemmyMemoryModelConfigInput }) | null {
  const row = appStateStore.db
    .prepare(
      `SELECT
        provider,
        base_url,
        model_id,
        api_key_ref,
        embedding_mode,
        embedding_base_url,
        embedding_model_id,
        embedding_api_key_ref,
        memory_provider,
        memory_base_url,
        memory_model_id,
        memory_api_key_ref,
        skill_provider,
        skill_base_url,
        skill_model_id,
        skill_api_key_ref,
        image_provider,
        image_base_url,
        image_model_id,
        image_api_key_ref
      FROM account_model_config
      WHERE uuid = ?`
    )
    .get(LOCAL_BYOK_ACCOUNT_UUID) as ModelConfigProjectionRow | undefined;
  if (!row?.api_key_ref) {
    return null;
  }

  const apiKey = appStateStore.secretStore.get(row.api_key_ref);
  if (!apiKey) {
    return null;
  }

  const input = {
    provider: row.provider as ModelProvider,
    baseUrl: row.base_url,
    modelId: row.model_id,
    apiKey,
    embedding: readEmbeddingProjectionInput(appStateStore, row),
    memmyMemory: {
      summary: readRoleProjectionInput(appStateStore, {
        provider: row.memory_provider ?? row.provider,
        baseUrl: row.memory_base_url ?? row.base_url,
        modelId: row.memory_model_id ?? row.model_id,
        apiKeyRef: row.memory_api_key_ref ?? row.api_key_ref
      }),
      evolution: readRoleProjectionInput(appStateStore, {
        provider: row.skill_provider ?? row.provider,
        baseUrl: row.skill_base_url ?? row.base_url,
        modelId: row.skill_model_id ?? row.model_id,
        apiKeyRef: row.skill_api_key_ref ?? row.api_key_ref
      })
    },
    imageGen: readImageGenProjectionInput(appStateStore, row)
  };
  const parsed = ModelConfigInputSchema.safeParse(input);
  if (!parsed.success || !parsed.data.memmyMemory) {
    return null;
  }

  return {
    ...parsed.data,
    memmyMemory: parsed.data.memmyMemory
  };
}

function readImageGenProjectionInput(
  appStateStore: AppStateStore,
  row: ModelConfigProjectionRow
): ModelConfigInput["imageGen"] {
  if (!row.image_provider || !row.image_base_url || !row.image_model_id) {
    return undefined;
  }

  return {
    provider: row.image_provider as ImageGenProvider,
    baseUrl: row.image_base_url,
    modelId: row.image_model_id,
    apiKey: row.image_api_key_ref ? appStateStore.secretStore.get(row.image_api_key_ref) ?? undefined : undefined
  };
}

function readEmbeddingProjectionInput(
  appStateStore: AppStateStore,
  row: ModelConfigProjectionRow
): ModelConfigInput["embedding"] {
  if (row.embedding_mode !== "custom") {
    return { mode: "local" };
  }

  return {
    mode: "custom",
    baseUrl: row.embedding_base_url ?? "",
    modelId: row.embedding_model_id ?? "",
    apiKey: row.embedding_api_key_ref ? appStateStore.secretStore.get(row.embedding_api_key_ref) ?? undefined : undefined
  };
}

function readRoleProjectionInput(
  appStateStore: AppStateStore,
  input: {
    provider: string;
    baseUrl: string;
    modelId: string;
    apiKeyRef: string | null;
  }
): MemmyMemoryModelConfigInput["summary"] {
  return {
    provider: input.provider as ModelProvider,
    baseUrl: input.baseUrl,
    modelId: input.modelId,
    apiKey: input.apiKeyRef ? appStateStore.secretStore.get(input.apiKeyRef) ?? undefined : undefined
  };
}

function createRuntimeConfigSyncError(
  state: RuntimeConfigSyncErrorState
): Error {
  return Object.assign(new Error(`Invalid Memmy runtime config: ${state.reason}`), {
    code: "invalid_runtime_config" as const,
    configPath: state.configPath,
    reason: state.reason,
    status: state.status
  });
}
