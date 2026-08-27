import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  MigrationError,
  type MigrationDefinition,
  type MigrationScope,
} from "./types.js";

export const CURRENT_MIGRATION_STATE_FORMAT_VERSION = 2 as const;
export const SUPPORTED_MIGRATION_STATE_FORMAT_VERSIONS = Object.freeze([1, 2] as const);

export type AppliedMigrationTarget =
  | { type: "agent-workspace" }
  | { type: "runtime-config"; key: string }
  | { type: "session-dag"; key: string };

export type AppliedMigrationRecord = {
  id: string;
  introducedIn: string;
  appliedAt: string;
  target: AppliedMigrationTarget;
};

export type MigrationState = {
  formatVersion: typeof CURRENT_MIGRATION_STATE_FORMAT_VERSION;
  scope: "agent-workspace";
  applied: AppliedMigrationRecord[];
};

export type MigrationStatePaths = {
  directory: string;
  file: string;
};

type LegacyAppliedMigrationRecord = Omit<AppliedMigrationRecord, "target">;

type LegacyMigrationState = {
  formatVersion: 1;
  scope: "agent-workspace";
  applied: LegacyAppliedMigrationRecord[];
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function stateError(message: string, cause?: unknown): MigrationError {
  return new MigrationError("migration_state_invalid", message, { cause });
}

function ioError(filePath: string, cause: unknown, migrationId: string | null): MigrationError {
  return new MigrationError("migration_io_failed", `Migration state I/O failed for ${filePath}`, {
    migrationId,
    cause,
  });
}

function isUtcIsoTimestamp(value: string): boolean {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function validateRecordFields(
  item: Record<string, unknown>,
  expectedKeys: readonly string[],
): LegacyAppliedMigrationRecord {
  if (
    !hasOnlyKeys(item, expectedKeys) ||
    typeof item.id !== "string" ||
    !item.id.trim() ||
    typeof item.introducedIn !== "string" ||
    typeof item.appliedAt !== "string" ||
    !isUtcIsoTimestamp(item.appliedAt)
  ) {
    throw stateError("Migration state contains an invalid applied record");
  }
  return {
    id: item.id,
    introducedIn: item.introducedIn,
    appliedAt: item.appliedAt,
  };
}

function validateTarget(value: unknown): AppliedMigrationTarget {
  if (!isObject(value) || typeof value.type !== "string") {
    throw stateError("Migration state contains an invalid target");
  }
  if (value.type === "agent-workspace" && hasOnlyKeys(value, ["type"])) {
    return { type: "agent-workspace" };
  }
  if (
    (value.type === "runtime-config" || value.type === "session-dag") &&
    hasOnlyKeys(value, ["type", "key"]) &&
    typeof value.key === "string" &&
    SHA256_PATTERN.test(value.key)
  ) {
    return { type: value.type, key: value.key };
  }
  throw stateError("Migration state contains an invalid target");
}

function recordIdentity(record: Pick<AppliedMigrationRecord, "id" | "target">): string {
  return record.target.type === "agent-workspace"
    ? `${record.id}:agent-workspace`
    : `${record.id}:${record.target.type}:${record.target.key}`;
}

function validateKnownDefinition(
  record: AppliedMigrationRecord,
  definitions: ReadonlyMap<string, MigrationDefinition>,
): void {
  const known = definitions.get(record.id);
  if (!known) return;
  if (known.introducedIn !== record.introducedIn) {
    throw stateError(`Migration state version does not match registry: ${record.id}`);
  }
  if (known.scope !== record.target.type) {
    throw stateError(`Migration state target does not match registry: ${record.id}`);
  }
}

function validateAppliedRecords(
  values: unknown[],
  definitions: readonly MigrationDefinition[],
  legacy: boolean,
): AppliedMigrationRecord[] {
  const knownDefinitions = new Map(definitions.map((definition) => [definition.id, definition]));
  const identities = new Set<string>();
  const applied: AppliedMigrationRecord[] = [];

  for (const value of values) {
    if (!isObject(value)) {
      throw stateError("Migration state contains an invalid applied record");
    }
    const base = validateRecordFields(
      value,
      legacy ? ["id", "introducedIn", "appliedAt"] : ["id", "introducedIn", "appliedAt", "target"],
    );
    const record: AppliedMigrationRecord = {
      ...base,
      target: legacy ? { type: "agent-workspace" } : validateTarget(value.target),
    };
    const identity = recordIdentity(record);
    if (identities.has(identity)) {
      throw stateError(`Migration state contains duplicate target: ${record.id}`);
    }
    identities.add(identity);
    validateKnownDefinition(record, knownDefinitions);
    applied.push(record);
  }
  return applied;
}

export function getMigrationStatePaths(profileWorkspace: string): MigrationStatePaths {
  const directory = path.join(profileWorkspace, ".memmy-migrations");
  return {
    directory,
    file: path.join(directory, "agent-workspace.json"),
  };
}

export function runtimeConfigTargetKey(runtimeConfigFile: string): string {
  const normalized = path.normalize(path.resolve(runtimeConfigFile));
  return createHash("sha256").update(normalized).digest("hex");
}

export function sessionDagTargetKey(sessionDagDir: string): string {
  const normalized = path.normalize(path.resolve(sessionDagDir));
  return createHash("sha256").update(normalized).digest("hex");
}

export function migrationTargetFor(
  definition: Pick<MigrationDefinition, "scope" | "requiredTargets">,
  runtimeConfigFile: string,
  sessionDagDir: string,
  appDatabaseFile?: string,
): AppliedMigrationTarget {
  if (definition.scope === "agent-workspace") return { type: "agent-workspace" };
  if (definition.scope === "runtime-config") {
    const runtimeKey = runtimeConfigTargetKey(runtimeConfigFile);
    const key = definition.requiredTargets?.includes("appDatabaseFile") && appDatabaseFile
      ? createHash("sha256")
          .update(`${runtimeKey}\0${path.normalize(path.resolve(appDatabaseFile))}`)
          .digest("hex")
      : runtimeKey;
    return { type: "runtime-config", key };
  }
  return { type: "session-dag", key: sessionDagTargetKey(sessionDagDir) };
}

export function isMigrationApplied(
  state: MigrationState,
  definition: MigrationDefinition,
  runtimeConfigFile: string,
  sessionDagDir: string,
  appDatabaseFile?: string,
): boolean {
  const target = migrationTargetFor(
    definition,
    runtimeConfigFile,
    sessionDagDir,
    appDatabaseFile,
  );
  const identity = recordIdentity({ id: definition.id, target });
  return state.applied.some((record) => recordIdentity(record) === identity);
}

export function emptyMigrationState(): MigrationState {
  return {
    formatVersion: CURRENT_MIGRATION_STATE_FORMAT_VERSION,
    scope: "agent-workspace",
    applied: [],
  };
}

export function validateMigrationState(
  value: unknown,
  definitions: readonly MigrationDefinition[],
): MigrationState {
  if (!isObject(value)) throw stateError("Migration state must be an object");
  if (!hasOnlyKeys(value, ["formatVersion", "scope", "applied"])) {
    throw stateError("Migration state contains unsupported fields");
  }
  if (value.scope !== "agent-workspace") throw stateError("Migration state scope does not match");
  if (!Array.isArray(value.applied)) throw stateError("Migration state applied must be an array");

  if (value.formatVersion === 1) {
    const legacy = value as unknown as LegacyMigrationState;
    return {
      formatVersion: CURRENT_MIGRATION_STATE_FORMAT_VERSION,
      scope: "agent-workspace",
      applied: validateAppliedRecords(legacy.applied, definitions, true),
    };
  }
  if (value.formatVersion !== CURRENT_MIGRATION_STATE_FORMAT_VERSION) {
    throw stateError("Unsupported migration state format");
  }
  return {
    formatVersion: CURRENT_MIGRATION_STATE_FORMAT_VERSION,
    scope: "agent-workspace",
    applied: validateAppliedRecords(value.applied, definitions, false),
  };
}

export async function readMigrationState(
  stateFile: string,
  definitions: readonly MigrationDefinition[],
): Promise<MigrationState> {
  let source: string;
  try {
    source = await fs.readFile(stateFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyMigrationState();
    throw ioError(stateFile, error, null);
  }
  try {
    return validateMigrationState(JSON.parse(source), definitions);
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw stateError("Migration state is not valid JSON", error);
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeMigrationState(
  paths: MigrationStatePaths,
  state: MigrationState,
  migrationId: string,
  hooks: {
    beforeRename?: (tempFile: string, stateFile: string) => Promise<void>;
  } = {},
): Promise<void> {
  const tempFile = path.join(
    paths.directory,
    `.agent-workspace.json.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle = null;
  try {
    handle = await fs.open(
      tempFile,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await hooks.beforeRename?.(tempFile, paths.file);
    await fs.rename(tempFile, paths.file);
    await fsyncDirectory(paths.directory);
  } catch (error) {
    throw error instanceof MigrationError
      ? error
      : ioError(paths.file, error, migrationId);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(tempFile).catch(() => undefined);
  }
}

export function targetScope(target: AppliedMigrationTarget): MigrationScope {
  return target.type;
}
