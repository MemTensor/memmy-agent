import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  MigrationError,
  type MigrationDefinition,
  type MigrationScope,
} from "./types.js";

export type AppliedMigrationRecord = {
  id: string;
  introducedIn: string;
  appliedAt: string;
};

export type MigrationState = {
  formatVersion: 1;
  scope: MigrationScope;
  applied: AppliedMigrationRecord[];
};

export type MigrationStatePaths = {
  directory: string;
  file: string;
};

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

export function getMigrationStatePaths(profileWorkspace: string): MigrationStatePaths {
  const directory = path.join(profileWorkspace, ".memmy-migrations");
  return {
    directory,
    file: path.join(directory, "agent-workspace.json"),
  };
}

export function emptyMigrationState(): MigrationState {
  return {
    formatVersion: 1,
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
  if (value.formatVersion !== 1) throw stateError("Unsupported migration state format");
  if (value.scope !== "agent-workspace") throw stateError("Migration state scope does not match");
  if (!Array.isArray(value.applied)) throw stateError("Migration state applied must be an array");

  const knownDefinitions = new Map(definitions.map((definition) => [definition.id, definition]));
  const ids = new Set<string>();
  const applied: AppliedMigrationRecord[] = [];
  for (const item of value.applied) {
    if (
      !isObject(item) ||
      !hasOnlyKeys(item, ["id", "introducedIn", "appliedAt"]) ||
      typeof item.id !== "string" ||
      !item.id.trim() ||
      typeof item.introducedIn !== "string" ||
      typeof item.appliedAt !== "string" ||
      !isUtcIsoTimestamp(item.appliedAt)
    ) {
      throw stateError("Migration state contains an invalid applied record");
    }
    if (ids.has(item.id)) throw stateError(`Migration state contains duplicate ID: ${item.id}`);
    ids.add(item.id);

    const known = knownDefinitions.get(item.id);
    if (known && known.introducedIn !== item.introducedIn) {
      throw stateError(`Migration state version does not match registry: ${item.id}`);
    }
    applied.push({
      id: item.id,
      introducedIn: item.introducedIn,
      appliedAt: item.appliedAt,
    });
  }
  return {
    formatVersion: 1,
    scope: "agent-workspace",
    applied,
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
