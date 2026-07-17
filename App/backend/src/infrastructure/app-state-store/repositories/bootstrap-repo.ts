/** Bootstrap repo module. */
import {
  AppSettingsDtoSchema,
  OnboardingStateDtoSchema,
  PrivacySettingsDtoSchema,
  TokenUsageDtoSchema,
  type AppSettingsDto,
  type LastLaunchMode,
  type OnboardingStateDto,
  type PatchAppSettingsInput,
  type PatchOnboardingInput,
  type PatchPrivacyInput,
  type PatchScanPreferencesInput,
  type PrivacySettingsDto,
  type ScanPreferences,
  ScanPreferencesSchema,
  type TokenUsageDto
} from "@memmy/local-api-contracts";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  ensureAccountDefaults,
  ensureLocalByokAccount,
  getActiveAccountUuid,
  LOCAL_BYOK_ACCOUNT_UUID
} from "../account-context.js";

interface AppSettingsRow {
  user_mode: string;
  language: string;
  theme: string;
  auto_update_enabled: number;
  default_launch_mode: string;
  last_launch_mode: string;
  avatar: string;
  skin: string;
  task_done_notification_enabled: number;
  notification_sound_enabled: number;
  menu_bar_icon_enabled: number;
  auto_scan_known_agents: number;
  watch_file_changes: number;
  auto_inject_skill: number;
}

interface OnboardingStateRow {
  has_finished_guide: number;
  current_step: string;
  has_accepted_terms: number;
  accepted_terms_version: string | null;
  scan_permission: string;
  improvement_program: string;
  completed_at: string | null;
}

interface PrivacySettingsRow {
  allow_memory_improvement_upload: number;
  local_only_mode: number;
}

interface TokenUsageRow {
  plan_name: string;
  total_tokens: number;
  used_tokens: number;
  remaining_tokens: number;
  expires_at: string | null;
  last_synced_at: string | null;
}

const DEFAULT_TOKEN_USAGE = TokenUsageDtoSchema.parse({
  planName: "体验 Token",
  totalTokens: 30000000,
  usedTokens: 0,
  remainingTokens: 30000000,
  expiresAt: null,
  lastSyncedAt: null
});
export interface BootstrapRepository {
  getAppSettings(): AppSettingsDto;
  updateAppSettings(patch: PatchAppSettingsInput): AppSettingsDto;
  /** Handles record last launch mode. */
  recordLastLaunchMode(mode: LastLaunchMode): AppSettingsDto;
  setAvatarSkin(patch: AvatarSkinPatch): AppSettingsDto;
  getOnboardingState(): OnboardingStateDto;
  updateOnboarding(patch: PatchOnboardingInput): OnboardingStateDto;
  getPrivacySettings(): PrivacySettingsDto;
  updatePrivacy(patch: PatchPrivacyInput): PrivacySettingsDto;
  getScanPreferences(): ScanPreferences;
  updateScanPreferences(patch: PatchScanPreferencesInput): ScanPreferences;
  getTokenUsage(): TokenUsageDto;
  /** Handles update token usage. */
  updateTokenUsage(usage: TokenUsageDto): TokenUsageDto;
}

export interface AvatarSkinPatch {
  avatarId?: string;
  skinId?: string;
}

export function createBootstrapRepository(db: DatabaseSync): BootstrapRepository {
  return {
    getAppSettings() {
      const row = getRequiredRow<AppSettingsRow>(
        db,
        `SELECT
          user_mode,
          language,
          theme,
          auto_update_enabled,
          default_launch_mode,
          last_launch_mode,
          avatar,
          skin,
          task_done_notification_enabled,
          notification_sound_enabled,
          menu_bar_icon_enabled,
          auto_scan_known_agents,
          watch_file_changes,
          auto_inject_skill
        FROM app_settings
        WHERE id = 'default'`
      );

      return AppSettingsDtoSchema.parse({
        userMode: row.user_mode,
        language: row.language,
        theme: row.theme,
        autoUpdateEnabled: toBoolean(row.auto_update_enabled),
        defaultLaunchMode: row.default_launch_mode,
        lastLaunchMode: row.last_launch_mode,
        avatarId: row.avatar,
        skinId: row.skin,
        taskDoneNotificationEnabled: toBoolean(row.task_done_notification_enabled),
        notificationSoundEnabled: toBoolean(row.notification_sound_enabled),
        menuBarIconEnabled: toBoolean(row.menu_bar_icon_enabled)
      });
    },

    recordLastLaunchMode(mode) {
      applyPatch(
        db,
        "app_settings",
        {
          lastLaunchMode: { column: "last_launch_mode" }
        },
        { lastLaunchMode: mode }
      );
      return this.getAppSettings();
    },

    updateAppSettings(patch) {
      applyPatch(
        db,
        "app_settings",
        {
          userMode: { column: "user_mode" },
          language: { column: "language" },
          theme: { column: "theme" },
          autoUpdateEnabled: { column: "auto_update_enabled", serialize: toInteger },
          defaultLaunchMode: { column: "default_launch_mode" },
          taskDoneNotificationEnabled: { column: "task_done_notification_enabled", serialize: toInteger },
          notificationSoundEnabled: { column: "notification_sound_enabled", serialize: toInteger },
          menuBarIconEnabled: { column: "menu_bar_icon_enabled", serialize: toInteger }
        },
        patch
      );
      return this.getAppSettings();
    },

    setAvatarSkin(patch) {
      applyPatch(
        db,
        "app_settings",
        {
          avatarId: { column: "avatar" },
          skinId: { column: "skin" }
        },
        patch
      );
      return this.getAppSettings();
    },

    getOnboardingState() {
      const uuid = resolveOnboardingUuidWithDefaults(db);
      const row = getRequiredRow<OnboardingStateRow>(
        db,
        `SELECT
          has_finished_guide,
          current_step,
          has_accepted_terms,
          accepted_terms_version,
          scan_permission,
          improvement_program,
          completed_at
        FROM account_onboarding_state
        WHERE uuid = ?`,
        [uuid]
      );

      return OnboardingStateDtoSchema.parse({
        completed: toBoolean(row.has_finished_guide),
        currentStep: row.current_step,
        hasAcceptedTerms: toBoolean(row.has_accepted_terms),
        acceptedTermsVersion: row.accepted_terms_version,
        scanPermission: row.scan_permission,
        improvementProgram: row.improvement_program,
        completedAt: row.completed_at
      });
    },

    updateOnboarding(patch) {
      const uuid = resolveOnboardingUuidWithDefaults(db);
      applyPatch(
        db,
        "account_onboarding_state",
        {
          completed: { column: "has_finished_guide", serialize: toInteger },
          currentStep: { column: "current_step" },
          hasAcceptedTerms: { column: "has_accepted_terms", serialize: toInteger },
          acceptedTermsVersion: { column: "accepted_terms_version" },
          scanPermission: { column: "scan_permission" },
          improvementProgram: { column: "improvement_program" },
          completedAt: { column: "completed_at" }
        },
        patch,
        { column: "uuid", value: uuid }
      );
      return this.getOnboardingState();
    },

    getPrivacySettings() {
      const uuid = resolvePrivacyUuidWithDefaults(db);

      const row = getRequiredRow<PrivacySettingsRow>(
        db,
        `SELECT
          allow_memory_improvement_upload,
          local_only_mode
        FROM account_privacy_settings
        WHERE uuid = ?`,
        [uuid]
      );

      return PrivacySettingsDtoSchema.parse({
        telemetryOptIn: false,
        crashReportOptIn: false,
        allowMemoryImprovementUpload: toBoolean(row.allow_memory_improvement_upload),
        localOnlyMode: toBoolean(row.local_only_mode)
      });
    },

    updatePrivacy(patch) {
      const uuid = resolvePrivacyUuidWithDefaults(db);
      applyPatch(
        db,
        "account_privacy_settings",
        {
          allowMemoryImprovementUpload: { column: "allow_memory_improvement_upload", serialize: toInteger },
          localOnlyMode: { column: "local_only_mode", serialize: toInteger }
        },
        patch,
        { column: "uuid", value: uuid }
      );
      return this.getPrivacySettings();
    },

    getScanPreferences() {
      const row = getRequiredRow<Pick<AppSettingsRow, "auto_scan_known_agents" | "watch_file_changes" | "auto_inject_skill">>(
        db,
        `SELECT
          auto_scan_known_agents,
          watch_file_changes,
          auto_inject_skill
        FROM app_settings
        WHERE id = 'default'`
      );

      return ScanPreferencesSchema.parse({
        autoScanKnownAgents: toBoolean(row.auto_scan_known_agents),
        watchFileChanges: toBoolean(row.watch_file_changes),
        autoInjectSkill: toBoolean(row.auto_inject_skill)
      });
    },

    updateScanPreferences(patch) {
      applyPatch(
        db,
        "app_settings",
        {
          autoScanKnownAgents: { column: "auto_scan_known_agents", serialize: toInteger },
          watchFileChanges: { column: "watch_file_changes", serialize: toInteger },
          autoInjectSkill: { column: "auto_inject_skill", serialize: toInteger }
        },
        patch
      );
      return this.getScanPreferences();
    },

    getTokenUsage() {
      const uuid = getActiveUuidWithDefaults(db);
      if (!uuid) {
        return DEFAULT_TOKEN_USAGE;
      }

      const row = getRequiredRow<TokenUsageRow>(
        db,
        `SELECT
          plan_name,
          total_tokens,
          used_tokens,
          remaining_tokens,
          expires_at,
          last_synced_at
        FROM account_token_usage_cache
        WHERE uuid = ?`,
        [uuid]
      );

      return TokenUsageDtoSchema.parse({
        planName: row.plan_name,
        totalTokens: row.total_tokens,
        usedTokens: row.used_tokens,
        remainingTokens: row.remaining_tokens,
        expiresAt: row.expires_at,
        lastSyncedAt: row.last_synced_at
      });
    },

    updateTokenUsage(usage) {
      const uuid = requireActiveUuidWithDefaults(db, "token usage");
      const parsed = TokenUsageDtoSchema.parse(usage);
      db.prepare(
        `UPDATE account_token_usage_cache SET
          plan_name = ?,
          total_tokens = ?,
          used_tokens = ?,
          remaining_tokens = ?,
          expires_at = ?,
          last_synced_at = ?,
          updated_at = ?
        WHERE uuid = ?`
      ).run(
        parsed.planName,
        parsed.totalTokens,
        parsed.usedTokens,
        parsed.remainingTokens,
        parsed.expiresAt,
        parsed.lastSyncedAt,
        new Date().toISOString(),
        uuid
      );

      return this.getTokenUsage();
    }
  };
}

interface ColumnBinding {
  column: string;
  serialize?: (value: unknown) => SQLInputValue;
}

function applyPatch<TPatch extends object>(
  db: DatabaseSync,
  tableName: string,
  bindings: Partial<Record<keyof TPatch & string, ColumnBinding>>,
  patch: TPatch,
  where: { column: string; value: SQLInputValue } = { column: "id", value: "default" }
): void {
  const entries = Object.entries(patch as Record<string, unknown>)
    .map(([key, value]) => ({
      key,
      value,
      binding: bindings[key as keyof TPatch & string]
    }))
    .filter((entry): entry is { key: string; value: unknown; binding: ColumnBinding } => {
      return entry.value !== undefined && Boolean(entry.binding);
    });
  if (entries.length === 0) {
    return;
  }

  const assignments = entries.map((entry) => `${entry.binding.column} = ?`);
  const params: SQLInputValue[] = entries.map((entry) => {
    return entry.binding.serialize ? entry.binding.serialize(entry.value) : toSqlInputValue(entry.value);
  });
  params.push(new Date().toISOString());

  params.push(where.value);

  db.prepare(`UPDATE ${tableName} SET ${assignments.join(", ")}, updated_at = ? WHERE ${where.column} = ?`).run(...params);
}

function getRequiredRow<T>(db: DatabaseSync, sql: string, params: SQLInputValue[] = []): T {
  const row = db.prepare(sql).get(...params) as T | undefined;
  if (!row) {
    throw new Error(`Missing required app state row for query: ${sql}`);
  }

  return row;
}

function toBoolean(value: number): boolean {
  return value === 1;
}

function toInteger(value: unknown): number {
  return value === true ? 1 : 0;
}

function toSqlInputValue(value: unknown): SQLInputValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value === null) {
    return value;
  }

  if (typeof value === "boolean") {
    return toInteger(value);
  }

  throw new TypeError("Unsupported SQLite input value");
}

/**
 * Reads the onboarding write scope and ensures the default row exists.
 *
 * BYOK users have no cloud account; this kind of first-run onboarding state only needs local persistence, so it lands in a local row that is not set as active.
 * Key point: BYOK mode must be anchored to the local scope by userMode and must never reuse a leftover active_uuid—
 * otherwise, when switching from an account login to BYOK, active_uuid still points at the old cloud account and would write BYOK's "guide finished" into the account row,
 * and on the next logout/restart, once active_uuid is cleared, it can no longer be read back, causing the onboarding to pop up every time.
 * Account-login mode still uses the account-level row of the current active cloud account, continuing to maintain account isolation.
 *
 * @param db the app-state SQLite connection.
 * @returns the uuid used for onboarding.
 */
function resolveOnboardingUuidWithDefaults(db: DatabaseSync): string {
  if (!isByokUserMode(db)) {
    const uuid = getActiveUuidWithDefaults(db);
    if (uuid) {
      return uuid;
    }
  }

  ensureLocalOnboardingDefaults(db);
  return LOCAL_BYOK_ACCOUNT_UUID;
}

/**
 * Resolves the privacy-settings scope uuid and ensures the corresponding row exists.
 *
 * Isomorphic to onboarding: the logged-in state uses the cloud-account scope; the BYOK / logged-out state falls back to the local BYOK scope,
 * so the shared-data toggle can persist even without a cloud account and does not revert across restarts.
 *
 * @param db the app-state SQLite connection.
 * @returns the privacy-settings scope uuid.
 */
function resolvePrivacyUuidWithDefaults(db: DatabaseSync): string {
  if (!isByokUserMode(db)) {
    const uuid = getActiveUuidWithDefaults(db);
    if (uuid) {
      return uuid;
    }
  }

  ensureLocalPrivacyDefaults(db);
  return LOCAL_BYOK_ACCOUNT_UUID;
}

/**
 * Ensures the BYOK local privacy-settings row exists.
 *
 * @param db the app-state SQLite connection.
 */
function ensureLocalPrivacyDefaults(db: DatabaseSync): void {
  const now = new Date().toISOString();
  const uuid = ensureLocalByokAccount(db);
  db.prepare(
    `INSERT OR IGNORE INTO account_privacy_settings (
      uuid,
      created_at,
      updated_at
    ) VALUES (?, ?, ?)`
  ).run(uuid, now, now);
}

/**
 * Determines whether the current login mode is BYOK.
 *
 * @param db the app-state SQLite connection.
 * @returns true means the current userMode is byok.
 */
function isByokUserMode(db: DatabaseSync): boolean {
  try {
    const row = db.prepare("SELECT user_mode FROM app_settings WHERE id = 'default'").get() as
      | { user_mode: string | null }
      | undefined;
    return row?.user_mode === "byok";
  } catch {
    return false;
  }
}

/**
 * Ensures the BYOK local onboarding row exists.
 *
 * @param db the app-state SQLite connection.
 */
function ensureLocalOnboardingDefaults(db: DatabaseSync): void {
  const now = new Date().toISOString();
  const uuid = ensureLocalByokAccount(db);
  db.prepare(
    `INSERT OR IGNORE INTO account_onboarding_state (
      uuid,
      created_at,
      updated_at
    ) VALUES (?, ?, ?)`
  ).run(uuid, now, now);
}

/**
 * Reads the current account and ensures account-level default rows exist.
 *
 * @param db the app-state SQLite connection.
 * @returns the current account uuid; returns null when not logged in.
 */
function getActiveUuidWithDefaults(db: DatabaseSync): string | null {
  const uuid = getActiveAccountUuid(db);
  if (uuid) {
    ensureAccountDefaults(db, uuid);
  }

  return uuid;
}

/**
 * Reads the current account and requires that an account is logged in.
 *
 * @param db the app-state SQLite connection.
 * @param stateName the name of the account-level state being written.
 * @returns the current account uuid.
 */
function requireActiveUuidWithDefaults(db: DatabaseSync, stateName: string): string {
  const uuid = getActiveUuidWithDefaults(db);
  if (!uuid) {
    throw Object.assign(new Error(`${stateName} requires an active cloud account`), { code: "unauthorized" as const });
  }

  return uuid;
}
