/** Runtime config sync service module. */
import type { AccountChannel, UserMode } from "@memmy/local-api-contracts";
import {
  createAppStateStore,
  type AppStateStore
} from "../infrastructure/app-state-store/index.js";
import {
  clearAccountModelProjectionFromMemmyConfig,
  readRuntimeMemmyConfigState,
  writeAccountModelProjectionToMemmyConfig,
  type RuntimeMemmyConfigState
} from "../infrastructure/memmy-config/index.js";

export interface RuntimeConfigMigrationConsistency {
  /** The account database was replaced from an explicitly trusted install generation. */
  accountSourceIsAuthoritative: boolean;
  /** Runtime config was copied from a migration source instead of retaining the target. */
  runtimeSourceWasMigrated: boolean;
  /** Account and runtime directories came from the same trusted install generation. */
  categorySourcesShareGeneration: boolean;
}

export interface SyncRuntimeConfigWithAppStateOptions {
  appStateStore: AppStateStore;
  memmyConfigPath: string;
  /** Login channel supported by the current desktop package. */
  accountChannel?: AccountChannel;
  migrationConsistency?: RuntimeConfigMigrationConsistency;
}

export interface SyncRuntimeConfigForStartupOptions {
  databasePath: string;
  memmyConfigPath: string;
  /** Login channel supported by the current desktop package. */
  accountChannel?: AccountChannel;
  migrationConsistency?: RuntimeConfigMigrationConsistency;
}

export interface RuntimeConfigSyncResult {
  source: "runtime_config" | "none";
  mode: UserMode;
  provider?: string;
  model?: string;
  hydratedAppState: boolean;
  wroteConfig: boolean;
  reason: string;
}

type RuntimeConfigSyncErrorState = {
  status: "invalid_yaml" | "conflict" | "no_model_config";
  configPath: string;
  reason: string;
};

/**
 * Hydrate current AppState from config.yaml. Missing runtime config is left untouched:
 * importing SQLite model rows into YAML belongs exclusively to startup migrations.
 */
export async function syncRuntimeConfigWithAppState(
  options: SyncRuntimeConfigWithAppStateOptions
): Promise<RuntimeConfigSyncResult> {
  let state = await readRuntimeMemmyConfigState(options.memmyConfigPath);
  if (options.migrationConsistency) {
    state = await reconcileMigratedAccountProjection(options, state);
  }
  const activeChannelMismatch = await clearMismatchedActiveSession(options, state);
  if (activeChannelMismatch) {
    const clearedUntrustedProjection = await clearUntrustedAccountProjection(
      options,
      accountProjectionFromState(state)
    );
    const wroteConfig = activeChannelMismatch.wroteConfig || clearedUntrustedProjection;
    if (state.status === "valid_byok") {
      const hydrated = hydrateByokRuntimeConfig(options.appStateStore, state);
      return {
        ...hydrated,
        wroteConfig,
        reason: "cleared_mismatched_account_session_and_hydrated_byok"
      };
    }
    if (state.status === "conflict" && state.reason === "account_runtime_credentials_conflict") {
      return {
        ...await syncRuntimeConfigWithAppState(options),
        wroteConfig: true,
        reason: "cleared_conflicting_account_credentials"
      };
    }
    if (state.status === "invalid_yaml" || state.status === "conflict") {
      throw createRuntimeConfigSyncError(state);
    }
    return accountChannelMismatchResult(options.appStateStore, wroteConfig);
  }
  switch (state.status) {
    case "valid_byok": {
      const clearedDormantProjection = await clearUntrustedAccountProjection(options, state.accountProjection);
      const hydrated = hydrateByokRuntimeConfig(options.appStateStore, state);
      return clearedDormantProjection
        ? { ...hydrated, wroteConfig: true, reason: "cleared_untrusted_account_projection_and_hydrated_byok" }
        : hydrated;
    }
    case "valid_account":
      return hydrateAccountRuntimeConfig(options, state);
    case "missing":
    case "empty":
      return {
        source: "none",
        mode: options.appStateStore.repositories.bootstrap.getAppSettings().userMode,
        hydratedAppState: false,
        wroteConfig: false,
        reason: `${state.status}_runtime_config_requires_startup_migration`
      };
    case "no_model_config": {
      const clearedProjection = await clearUntrustedAccountProjection(options, state.accountProjection);
      return {
        source: "none",
        mode: options.appStateStore.repositories.bootstrap.getAppSettings().userMode,
        hydratedAppState: false,
        wroteConfig: clearedProjection,
        reason: clearedProjection ? "cleared_untrusted_account_projection" : state.reason
      };
    }
    case "invalid_yaml":
      throw createRuntimeConfigSyncError(state);
    case "conflict":
      if (state.reason !== "account_runtime_credentials_conflict") {
        throw createRuntimeConfigSyncError(state);
      }
      options.appStateStore.repositories.accountSession.clear();
      await clearAccountModelProjectionFromMemmyConfig(options.memmyConfigPath, { force: true });
      return {
        ...await syncRuntimeConfigWithAppState(options),
        wroteConfig: true,
        reason: "cleared_conflicting_account_credentials"
      };
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
      memmyConfigPath: options.memmyConfigPath,
      accountChannel: options.accountChannel,
      migrationConsistency: options.migrationConsistency
    });
  } finally {
    appStateStore.close();
  }
}

async function reconcileMigratedAccountProjection(
  options: SyncRuntimeConfigWithAppStateOptions,
  state: RuntimeMemmyConfigState
): Promise<RuntimeMemmyConfigState> {
  const session = options.appStateStore.repositories.accountSession.get();
  const projection = accountProjectionFromState(state);
  if (!session.authenticated) {
    if (projection || (
      options.migrationConsistency?.accountSourceIsAuthoritative
      && options.appStateStore.repositories.bootstrap.getAppSettings().userMode === "account"
    )) {
      throw createMigrationConsistencyError(
        "Migrated account runtime config has no authenticated local account session"
      );
    }
    return state;
  }

  const sessionChannel = options.appStateStore.repositories.accountSession.getAuthChannel();
  if (options.accountChannel && sessionChannel !== options.accountChannel) {
    throw createMigrationConsistencyError(
      `Migrated account authentication channel ${String(sessionChannel)} does not match package channel ${options.accountChannel}`
    );
  }
  const cloudUuid = options.appStateStore.repositories.accountSession.getCloudUuid();
  if (!cloudUuid) {
    throw createMigrationConsistencyError("Migrated account session is missing its cloud credential");
  }

  const projectionMatchesSession = projection
    && projection.cloudUuid === cloudUuid
    && projection.userId === session.profile.userId;
  if (projection && !projectionMatchesSession) {
    if (
      !options.migrationConsistency?.accountSourceIsAuthoritative
      || options.migrationConsistency.categorySourcesShareGeneration
    ) {
      throw createMigrationConsistencyError(
        "Migrated account database and runtime model projection have different owners"
      );
    }
  }

  if (!projectionMatchesSession || state.status === "no_model_config") {
    await writeAccountModelProjectionToMemmyConfig({
      cloudUuid,
      userId: session.profile.userId
    }, options.memmyConfigPath);
    const repaired = await readRuntimeMemmyConfigState(options.memmyConfigPath);
    const repairedProjection = accountProjectionFromState(repaired);
    if (
      !repairedProjection
      || repairedProjection.cloudUuid !== cloudUuid
      || repairedProjection.userId !== session.profile.userId
      || (repaired.status !== "valid_account" && repaired.status !== "valid_byok")
    ) {
      throw createMigrationConsistencyError(
        "Migrated account model projection could not be restored from the authoritative account database"
      );
    }
    return repaired;
  }
  return state;
}

function hydrateByokRuntimeConfig(
  appStateStore: AppStateStore,
  state: Extract<RuntimeMemmyConfigState, { status: "valid_byok" }>
): RuntimeConfigSyncResult {
  appStateStore.repositories.bootstrap.updateAppSettings({ userMode: "byok" });
  return {
    source: "runtime_config",
    mode: "byok",
    provider: state.context.provider,
    model: state.context.model,
    hydratedAppState: true,
    wroteConfig: false,
    reason: "hydrated_byok_from_runtime_config"
  };
}

async function hydrateAccountRuntimeConfig(
  options: SyncRuntimeConfigWithAppStateOptions,
  state: Extract<RuntimeMemmyConfigState, { status: "valid_account" }>
): Promise<RuntimeConfigSyncResult> {
  const { appStateStore } = options;
  const activated = appStateStore.repositories.accountSession.activateByCloudUuid(
    state.cloudUuid,
    options.accountChannel
  );
  const session = appStateStore.repositories.accountSession.get();
  const sessionChannel = appStateStore.repositories.accountSession.getAuthChannel();
  if (
    !activated
    || !session.authenticated
    || (options.accountChannel && sessionChannel !== options.accountChannel)
    || (state.userId && session.profile.userId !== state.userId)
  ) {
    if (activated) appStateStore.repositories.accountSession.clear();
    const projection = await clearAccountModelProjectionFromMemmyConfig(options.memmyConfigPath, {
      ownerAccountId: state.userId ?? (session.authenticated ? session.profile.userId : undefined),
      force: true
    });
    return {
      source: "none",
      mode: appStateStore.repositories.bootstrap.getAppSettings().userMode,
      hydratedAppState: false,
      wroteConfig: projection.changed,
      reason: "account_projection_has_no_matching_local_session"
    };
  }
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

async function clearMismatchedActiveSession(
  options: SyncRuntimeConfigWithAppStateOptions,
  state: RuntimeMemmyConfigState
): Promise<{ wroteConfig: boolean } | null> {
  if (!options.accountChannel) return null;
  const session = options.appStateStore.repositories.accountSession.get();
  if (!session.authenticated) return null;
  if (options.appStateStore.repositories.accountSession.getAuthChannel() === options.accountChannel) {
    return null;
  }

  options.appStateStore.repositories.accountSession.clear();
  if (
    state.status === "missing"
    || state.status === "empty"
    || state.status === "invalid_yaml"
    || state.status === "conflict"
  ) {
    return { wroteConfig: false };
  }
  const projection = await clearAccountModelProjectionFromMemmyConfig(options.memmyConfigPath, {
    ownerAccountId: session.profile.userId
  });
  return { wroteConfig: projection.changed };
}

async function clearUntrustedAccountProjection(
  options: SyncRuntimeConfigWithAppStateOptions,
  accountProjection: { cloudUuid: string; userId?: string } | undefined
): Promise<boolean> {
  if (!options.accountChannel || !accountProjection) return false;
  const storedChannel = options.appStateStore.repositories.accountSession.getAuthChannelByCloudUuid(
    accountProjection.cloudUuid
  );
  if (storedChannel === options.accountChannel) return false;
  const projection = await clearAccountModelProjectionFromMemmyConfig(options.memmyConfigPath, {
    ownerAccountId: accountProjection.userId,
    force: true
  });
  return projection.changed;
}

function accountProjectionFromState(
  state: RuntimeMemmyConfigState
): { cloudUuid: string; userId?: string } | undefined {
  if (state.status === "valid_account") {
    return state.userId ? { cloudUuid: state.cloudUuid, userId: state.userId } : { cloudUuid: state.cloudUuid };
  }
  return "accountProjection" in state ? state.accountProjection : undefined;
}

function accountChannelMismatchResult(
  appStateStore: AppStateStore,
  wroteConfig: boolean
): RuntimeConfigSyncResult {
  return {
    source: "none",
    mode: appStateStore.repositories.bootstrap.getAppSettings().userMode,
    hydratedAppState: false,
    wroteConfig,
    reason: "account_session_channel_mismatch"
  };
}

function createRuntimeConfigSyncError(state: RuntimeConfigSyncErrorState): Error {
  return Object.assign(new Error(`Invalid Memmy runtime config: ${state.reason}`), {
    code: "invalid_runtime_config" as const,
    configPath: state.configPath,
    reason: state.reason,
    status: state.status
  });
}

function createMigrationConsistencyError(reason: string): Error {
  return Object.assign(new Error(`Windows data migration consistency check failed: ${reason}`), {
    code: "windows_data_migration_inconsistent" as const,
    reason
  });
}
