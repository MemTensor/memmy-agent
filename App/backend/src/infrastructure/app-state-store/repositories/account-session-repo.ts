/** Account session repo module. */
import { createHash } from "node:crypto";
import {
  AccountProfileViewSchema,
  AccountSessionViewSchema,
  type AccountProfileView,
  type AccountSessionView
} from "@memmy/local-api-contracts";
import type { DatabaseSync } from "node:sqlite";
import { ensureAccountDefaults, getActiveAccountUuid, setActiveAccountUuid } from "../account-context.js";
import type { SecretStore } from "../secret-store.js";

export interface AccountSessionRepository {
  get(): AccountSessionView;
  /** Reads get cloud uuid. */
  getCloudUuid(): string | null;
  /** Reads get latest cloud uuid. */
  getLatestCloudUuid(): string | null;
  /** Handles activate by cloud uuid. */
  activateByCloudUuid(cloudUuid: string): boolean;
  upsert(input: UpsertAccountSessionInput): AccountSessionView;
  clear(): void;
  getLastCodeSentAt(key: string): string | null;
  markCodeSent(key: string, at: string): void;
}

export interface AccountSessionProfileInput extends AccountProfileView {
  rawProfile: Record<string, unknown>;
}

export interface UpsertAccountSessionInput {
  profile: AccountSessionProfileInput;
  /** Uuid. */
  uuid?: string;
  /** Cloud uuid. */
  cloudUuid?: string;
  /** Is new user. */
  isNewUser?: boolean | null;
}

interface AccountSessionRow {
  uuid: string;
  user_id: string | null;
  email: string | null;
  phone: string | null;
  nickname: string | null;
  avatar: string | null;
  plan_type: string | null;
  has_finished_guide: number | null;
  region: string | null;
  registered_at: string | null;
  raw_profile_json: string | null;
  cloud_uuid_ref: string | null;
}

interface VerificationThrottleRow {
  last_code_sent_at: string;
}

/** Creates create account session repository. */
export function createAccountSessionRepository(db: DatabaseSync, secretStore: SecretStore): AccountSessionRepository {
  return {
    get() {
      const row = repairAccountContactFromRawProfile(db, getActiveAccountRow(db));
      if (!row?.user_id || !row.nickname) {
        return AccountSessionViewSchema.parse({ authenticated: false });
      }

      return AccountSessionViewSchema.parse({
        authenticated: true,
        isNewUser: false,
        profile: toProfileView(row)
      });
    },

    getCloudUuid() {
      return getCloudUuidFromRow(secretStore, getActiveAccountRow(db));
    },

    getLatestCloudUuid() {
      return findLatestCloudUuid(db, secretStore);
    },

    activateByCloudUuid(cloudUuid) {
      const normalizedCloudUuid = cloudUuid.trim();
      if (!normalizedCloudUuid) {
        setActiveAccountUuid(db, null);
        return false;
      }

      const rows = listRowsWithCloudUuidRef(db);
      for (const row of rows) {
        if (getCloudUuidFromRow(secretStore, row) !== normalizedCloudUuid) {
          continue;
        }

        ensureAccountDefaults(db, row.uuid);
        setActiveAccountUuid(db, row.uuid);
        return true;
      }

      setActiveAccountUuid(db, null);
      return false;
    },

    upsert(input) {
      const activeUuid = getActiveAccountUuid(db);
      const accountUuid = input.uuid ?? activeUuid;
      if (!accountUuid) {
        throw Object.assign(new Error("Cloud account uuid is required"), { code: "invalid_argument" as const });
      }

      const previous = getAccountRow(db, accountUuid);
      const isNewUser = input.isNewUser ?? (!previous?.user_id || previous.user_id !== input.profile.userId);
      const now = new Date().toISOString();
      const registeredAt = resolveRegisteredAt(previous, input.profile, now);

      db.prepare(
        `INSERT INTO cloud_accounts (
          uuid,
          user_id,
          email,
          phone,
          nickname,
          avatar,
          plan_type,
          has_finished_guide,
          region,
          registered_at,
          raw_profile_json,
          cloud_uuid_ref,
          last_login_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(uuid) DO UPDATE SET
          user_id = excluded.user_id,
          email = excluded.email,
          phone = excluded.phone,
          nickname = excluded.nickname,
          avatar = excluded.avatar,
          plan_type = excluded.plan_type,
          has_finished_guide = excluded.has_finished_guide,
          region = excluded.region,
          registered_at = excluded.registered_at,
          raw_profile_json = excluded.raw_profile_json,
          cloud_uuid_ref = excluded.cloud_uuid_ref,
          last_login_at = excluded.last_login_at,
          updated_at = excluded.updated_at`
      ).run(
        accountUuid,
        input.profile.userId,
        input.profile.email,
        input.profile.phoneNumber,
        input.profile.nickname,
        input.profile.avatarUrl,
        input.profile.planType,
        toNullableInteger(input.profile.hasFinishedGuide),
        input.profile.region,
        registeredAt,
        JSON.stringify(stripCloudCredential(input.profile.rawProfile)),
        previous?.cloud_uuid_ref ?? null,
        now,
        now,
        now
      );
      const uuidRef = persistUuid(secretStore, accountUuid, input.cloudUuid, previous?.cloud_uuid_ref ?? null);
      if (uuidRef !== (previous?.cloud_uuid_ref ?? null)) {
        db.prepare("UPDATE cloud_accounts SET cloud_uuid_ref = ?, updated_at = ? WHERE uuid = ?").run(uuidRef, now, accountUuid);
      }
      ensureAccountDefaults(db, accountUuid);
      setActiveAccountUuid(db, accountUuid);

      return AccountSessionViewSchema.parse({
        authenticated: true,
        isNewUser,
        profile: AccountProfileViewSchema.parse({
          userId: input.profile.userId,
          email: input.profile.email,
          phoneNumber: input.profile.phoneNumber,
          nickname: input.profile.nickname,
          avatarUrl: input.profile.avatarUrl,
          planType: input.profile.planType,
          hasFinishedGuide: input.profile.hasFinishedGuide,
          region: input.profile.region,
          registeredAt
        })
      });
    },

    clear() {
      setActiveAccountUuid(db, null);
    },

    getLastCodeSentAt(key) {
      const throttleKey = toThrottleKey(key);
      const row = db
        .prepare("SELECT last_code_sent_at FROM verification_code_throttle WHERE throttle_key = ?")
        .get(throttleKey) as VerificationThrottleRow | undefined;
      return row?.last_code_sent_at ?? null;
    },

    markCodeSent(key, at) {
      const throttle = toThrottleRecord(key);
      db.prepare(
        `INSERT INTO verification_code_throttle (
          throttle_key,
          channel,
          identifier_hash,
          last_code_sent_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(throttle_key) DO UPDATE SET
          last_code_sent_at = excluded.last_code_sent_at,
          updated_at = excluded.updated_at`
      ).run(throttle.throttleKey, throttle.channel, throttle.identifierHash, at, at, at);
    }
  };
}

/** Reads get active account row. */
function getActiveAccountRow(db: DatabaseSync): AccountSessionRow | null {
  const activeUuid = getActiveAccountUuid(db);
  return activeUuid ? getAccountRow(db, activeUuid) : null;
}

/** Reads get account row. */
function getAccountRow(db: DatabaseSync, uuid: string): AccountSessionRow | null {
  const row = db
    .prepare(
      `SELECT
        ${ACCOUNT_SESSION_COLUMNS}
      FROM cloud_accounts
      WHERE uuid = ?`
    )
    .get(uuid) as AccountSessionRow | undefined;
  return row ?? null;
}

const ACCOUNT_SESSION_COLUMNS = `
  uuid,
  user_id,
  email,
  phone,
  nickname,
  avatar,
  plan_type,
  has_finished_guide,
  region,
  registered_at,
  raw_profile_json,
  cloud_uuid_ref
`;

function findLatestCloudUuid(db: DatabaseSync, secretStore: SecretStore): string | null {
  const rows = listRowsWithCloudUuidRef(db);

  for (const row of rows) {
    const cloudUuid = getCloudUuidFromRow(secretStore, row);
    if (cloudUuid) {
      return cloudUuid;
    }
  }

  return null;
}

function listRowsWithCloudUuidRef(db: DatabaseSync): AccountSessionRow[] {
  return db
    .prepare(
      `SELECT
        ${ACCOUNT_SESSION_COLUMNS}
      FROM cloud_accounts
      WHERE cloud_uuid_ref IS NOT NULL AND trim(cloud_uuid_ref) <> ''
      ORDER BY COALESCE(last_login_at, updated_at, created_at, '') DESC`
    )
    .all() as unknown as AccountSessionRow[];
}

function getCloudUuidFromRow(secretStore: SecretStore, row: AccountSessionRow | null): string | null {
  return row?.cloud_uuid_ref ? secretStore.get(row.cloud_uuid_ref) : null;
}

/**
 * Repairs missing account contact info from the historical raw profile.
 *
 * @param db the app-state SQLite connection.
 * @param row the current cloud_accounts row.
 * @returns the account row with contact info filled in; returns the original row when there is no repairable data.
 */
function repairAccountContactFromRawProfile(db: DatabaseSync, row: AccountSessionRow | null): AccountSessionRow | null {
  if (!row?.raw_profile_json || (row.email && row.phone)) {
    return row;
  }

  const rawProfile = parseRawProfile(row.raw_profile_json);
  if (!rawProfile) {
    return row;
  }

  const email = row.email ?? readRawProfileString(rawProfile.email);
  const phone = row.phone ?? readRawProfileString(rawProfile.phoneNumber) ?? readRawProfileString(rawProfile.phone);
  if (email === row.email && phone === row.phone) {
    return row;
  }

  db.prepare("UPDATE cloud_accounts SET email = ?, phone = ?, updated_at = ? WHERE uuid = ?").run(
    email,
    phone,
    new Date().toISOString(),
    row.uuid
  );
  return {
    ...row,
    email,
    phone
  };
}

/**
 * Parses raw_profile_json.
 *
 * @param rawProfileJson the cloud_accounts.raw_profile_json string.
 * @returns an object whose fields can be read; returns null for invalid JSON or a non-object.
 */
function parseRawProfile(rawProfileJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawProfileJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Reads a string from a raw profile field.
 *
 * @param value the candidate field value from the raw profile.
 * @returns a non-empty string; returns null for empty values or unsupported types.
 */
function readRawProfileString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

/**
 * Converts a database row into an account profile view.
 *
 * @param row the cloud_accounts row.
 * @returns an account profile view without the cloud uuid.
 */
function toProfileView(row: AccountSessionRow): AccountProfileView {
  return AccountProfileViewSchema.parse({
    userId: row.user_id,
    email: row.email,
    phoneNumber: row.phone,
    nickname: row.nickname,
    avatarUrl: row.avatar,
    planType: row.plan_type,
    hasFinishedGuide: row.has_finished_guide === null ? null : row.has_finished_guide === 1,
    region: row.region,
    registeredAt: row.registered_at
  });
}

/**
 * Resolves the account registration time.
 *
 * @param previous the current cloud_accounts account row.
 * @param profile the account profile to be written this time.
 * @param now the local fallback time.
 * @returns the cloud registration time, the already-saved registration time, or the local first-write time.
 */
function resolveRegisteredAt(
  previous: AccountSessionRow | null,
  profile: AccountSessionProfileInput,
  now: string
): string {
  if (previous?.user_id === profile.userId && previous.registered_at) {
    return previous.registered_at;
  }

  return profile.registeredAt ?? now;
}

/**
 * Saves the cloud uuid and returns the business-table ref.
 *
 * @param secretStore the SecretStore instance.
 * @param accountUuid the stable account primary key.
 * @param cloudUuid the cloud login credential returned by this login.
 * @param previousRef the existing uuid ref.
 * @returns the uuid ref saved in the business table.
 */
function persistUuid(
  secretStore: SecretStore,
  accountUuid: string,
  cloudUuid: string | undefined,
  previousRef: string | null
): string | null {
  if (cloudUuid) {
    const ref = `account:${accountUuid}:cloud-uuid`;
    secretStore.set(ref, cloudUuid, { uuid: accountUuid, purpose: "cloud_uuid" });
    return ref;
  }

  return previousRef;
}

/**
 * Strips login-credential fields that may appear in the raw profile.
 *
 * @param rawProfile the raw cloud profile.
 * @returns a profile without token/uuid fields.
 */
function stripCloudCredential(rawProfile: Record<string, unknown>): Record<string, unknown> {
  const result = { ...rawProfile };
  delete result.token;
  delete result.uuid;
  return result;
}

/**
 * Converts a nullable boolean into a SQLite nullable integer.
 *
 * @param value a boolean value or null.
 * @returns 1, 0, or null.
 */
function toNullableInteger(value: boolean | null): number | null {
  if (value === null) {
    return null;
  }

  return value ? 1 : 0;
}

/**
 * Converts a verification-code key into a hashed throttle record.
 *
 * @param key the channel:identifier key passed in by AccountService.
 * @returns throttle fields ready to be persisted.
 */
function toThrottleRecord(key: string): {
  throttleKey: string;
  channel: "email" | "phone";
  identifierHash: string;
} {
  const separatorIndex = key.indexOf(":");
  const channel = key.slice(0, separatorIndex);
  const identifier = key.slice(separatorIndex + 1);
  if (channel !== "email" && channel !== "phone") {
    throw Object.assign(new Error("Unsupported verification channel"), { code: "invalid_argument" as const });
  }

  const identifierHash = createHash("sha256").update(identifier.trim().toLowerCase()).digest("hex");
  return {
    throttleKey: `${channel}:${identifierHash}`,
    channel,
    identifierHash
  };
}

/**
 * Generates the verification-code throttle primary key.
 *
 * @param key the channel:identifier key passed in by AccountService.
 * @returns a throttle key without the plaintext email/phone number.
 */
function toThrottleKey(key: string): string {
  return toThrottleRecord(key).throttleKey;
}
