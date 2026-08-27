import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  MigrationError,
  type AgentWorkspaceMigrationContext,
  type MigrationDefinition,
  type MigrationResult,
} from "../../types.js";

const MIGRATION_ID = "v1.0.7/0003-normalize-goal-state";
const TEMP_MARKER = "v1.0.7-0003";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINAL_STATUSES = new Set([
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
  "completed",
]);
const FINAL_KEYS = new Set([
  "goalId",
  "objective",
  "status",
  "tokenBudget",
  "tokensUsed",
  "timeUsedSeconds",
  "createdAt",
  "updatedAt",
]);
const TEMP_FILE_PATTERN = /^\..+\.jsonl\.v1\.0\.7-0003\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;

type JsonObject = Record<string, unknown>;

type MigrationHooks = {
  beforeCommit?: (filePath: string) => Promise<void>;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function parseIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function nonNegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function positiveIntegerOrNull(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function stableGoalId(sessionKey: string, startedAt: string, objective: string): string {
  const bytes = createHash("sha256")
    .update(sessionKey)
    .update("\0")
    .update(startedAt)
    .update("\0")
    .update(objective)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isFinalGoalState(value: unknown): boolean {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === FINAL_KEYS.size
    && keys.every((key) => FINAL_KEYS.has(key))
    && typeof value.goalId === "string"
    && UUID_PATTERN.test(value.goalId)
    && typeof value.objective === "string"
    && Boolean(value.objective.trim())
    && value.objective.length <= 12_000
    && typeof value.status === "string"
    && FINAL_STATUSES.has(value.status)
    && (value.tokenBudget === null || (Number.isSafeInteger(value.tokenBudget) && Number(value.tokenBudget) > 0))
    && Number.isSafeInteger(value.tokensUsed)
    && Number(value.tokensUsed) >= 0
    && Number.isSafeInteger(value.timeUsedSeconds)
    && Number(value.timeUsedSeconds) >= 0
    && isIso(value.createdAt)
    && isIso(value.updatedAt);
}

function parseLegacyGoal(value: unknown): JsonObject | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return isObject(value) ? value : null;
}

function validRoute(value: unknown): value is { channel: string; chatId: string } {
  return isObject(value)
    && Object.keys(value).length === 2
    && typeof value.channel === "string"
    && Boolean(value.channel.trim())
    && typeof value.chatId === "string"
    && Boolean(value.chatId.trim());
}

function routeFromSessionKey(sessionKey: string): { channel: string; chatId: string } | null {
  if (sessionKey === "unified:default") return null;
  const separator = sessionKey.indexOf(":");
  if (separator <= 0 || separator === sessionKey.length - 1) return null;
  return { channel: sessionKey.slice(0, separator), chatId: sessionKey.slice(separator + 1) };
}

function ioError(filePath: string, cause: unknown): MigrationError {
  return new MigrationError("migration_io_failed", `Migration I/O failed for ${filePath}`, {
    migrationId: MIGRATION_ID,
    cause,
  });
}

function sourceChangedError(filePath: string): MigrationError {
  return new MigrationError(
    "migration_source_changed",
    `Session changed while it was being migrated: ${filePath}`,
    { migrationId: MIGRATION_ID },
  );
}

function sameFingerprint(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

function firstRecord(source: Buffer): { start: number; end: number; newline: Buffer; content: Buffer } | null {
  let start = 0;
  while (start < source.length) {
    const newlineIndex = source.indexOf(0x0a, start);
    const end = newlineIndex < 0 ? source.length : newlineIndex + 1;
    let contentEnd = newlineIndex < 0 ? source.length : newlineIndex;
    let newline = newlineIndex < 0 ? Buffer.alloc(0) : Buffer.from("\n");
    if (contentEnd > start && source[contentEnd - 1] === 0x0d) {
      contentEnd -= 1;
      newline = Buffer.from("\r\n");
    }
    const content = source.subarray(start, contentEnd);
    if (content.toString("utf8").trim()) return { start, end, newline, content };
    start = end;
  }
  return null;
}

function normalizeRecord(
  record: JsonObject,
  fileMtime: string,
  context: AgentWorkspaceMigrationContext,
  filePath: string,
): JsonObject | null {
  if (record.recordType !== "metadata" || !isObject(record.metadata)) return null;
  if (!Object.prototype.hasOwnProperty.call(record.metadata, "goalState")) return null;
  const metadata = { ...record.metadata };
  const rawGoal = parseLegacyGoal(metadata.goalState);
  if (!rawGoal) {
    delete metadata.goalState;
    delete metadata.goalRoute;
    context.logger.warn("migration_goal_state_removed", {
      migrationId: MIGRATION_ID,
      scope: "agent-workspace",
      filePath,
      errorCode: "goal_state_invalid",
    });
    return { ...record, metadata };
  }
  const objective = typeof rawGoal.objective === "string" ? rawGoal.objective : "";
  const status = typeof rawGoal.status === "string" ? rawGoal.status : "";
  if (!objective.trim() || objective.length > 12_000 || !FINAL_STATUSES.has(status)) {
    delete metadata.goalState;
    delete metadata.goalRoute;
    context.logger.warn("migration_goal_state_removed", {
      migrationId: MIGRATION_ID,
      scope: "agent-workspace",
      filePath,
      errorCode: "goal_state_invalid",
    });
    return { ...record, metadata };
  }
  const createdAt = parseIso(rawGoal.startedAt)
    ?? parseIso(rawGoal.createdAt)
    ?? parseIso(record.createdAt)
    ?? fileMtime;
  const updatedAt = status === "completed"
    ? parseIso(rawGoal.completedAt) ?? parseIso(rawGoal.updatedAt) ?? parseIso(record.updatedAt) ?? createdAt
    : parseIso(rawGoal.updatedAt) ?? parseIso(record.updatedAt) ?? createdAt;
  const sessionKey = typeof record.key === "string" ? record.key : path.basename(filePath, ".jsonl");
  const goalState: JsonObject = {
    goalId: typeof rawGoal.goalId === "string" && UUID_PATTERN.test(rawGoal.goalId)
      ? rawGoal.goalId
      : stableGoalId(sessionKey, createdAt, objective),
    objective,
    status,
    tokenBudget: positiveIntegerOrNull(rawGoal.tokenBudget),
    tokensUsed: nonNegativeInteger(rawGoal.tokensUsed),
    timeUsedSeconds: nonNegativeInteger(rawGoal.timeUsedSeconds),
    createdAt,
    updatedAt,
  };
  metadata.goalState = goalState;
  if (status === "completed") {
    delete metadata.goalRoute;
  } else {
    const route = validRoute(metadata.goalRoute) ? metadata.goalRoute : routeFromSessionKey(sessionKey);
    if (route) {
      metadata.goalRoute = route;
    } else {
      goalState.status = "blocked";
      delete metadata.goalRoute;
      context.logger.warn("migration_goal_route_unavailable", {
        migrationId: MIGRATION_ID,
        scope: "agent-workspace",
        filePath,
        errorCode: "goal_route_unavailable",
      });
    }
  }
  if (isFinalGoalState(record.metadata.goalState)) {
    const originalRoute = record.metadata.goalRoute;
    const routeUnchanged = status === "completed"
      ? originalRoute === undefined
      : validRoute(originalRoute) && JSON.stringify(originalRoute) === JSON.stringify(metadata.goalRoute);
    if (routeUnchanged) return null;
  }
  return { ...record, metadata };
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

async function cleanupTemps(sessionsDir: string): Promise<void> {
  for (const entry of await fs.readdir(sessionsDir, { withFileTypes: true })) {
    if (entry.isFile() && TEMP_FILE_PATTERN.test(entry.name)) {
      await fs.unlink(path.join(sessionsDir, entry.name));
    }
  }
}

async function migrateFile(
  filePath: string,
  context: AgentWorkspaceMigrationContext,
  hooks: MigrationHooks,
): Promise<"changed" | "ignored"> {
  const initial = await fs.lstat(filePath, { bigint: true }).catch((error) => {
    throw ioError(filePath, error);
  });
  if (!initial.isFile() || initial.size > BigInt(Number.MAX_SAFE_INTEGER)) return "ignored";
  const source = await fs.readFile(filePath).catch((error) => {
    throw ioError(filePath, error);
  });
  const location = firstRecord(source);
  if (!location) return "ignored";
  let record: unknown;
  try {
    record = JSON.parse(location.content.toString("utf8"));
  } catch {
    return "ignored";
  }
  if (!isObject(record)) return "ignored";
  const migrated = normalizeRecord(
    record,
    new Date(Number(initial.mtimeNs / 1_000_000n)).toISOString(),
    context,
    filePath,
  );
  if (!migrated) return "ignored";
  const replacement = Buffer.concat([
    source.subarray(0, location.start),
    Buffer.from(JSON.stringify(migrated), "utf8"),
    location.newline,
    source.subarray(location.end),
  ]);
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${TEMP_MARKER}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle = null;
  try {
    handle = await fs.open(
      tempPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      Number(initial.mode & 0o7777n),
    );
    await handle.chmod(Number(initial.mode & 0o7777n));
    await handle.writeFile(replacement);
    await handle.sync();
    await handle.close();
    handle = null;
    await hooks.beforeCommit?.(filePath);
    const current = await fs.lstat(filePath, { bigint: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw sourceChangedError(filePath);
      throw error;
    });
    if (!sameFingerprint(initial, current)) throw sourceChangedError(filePath);
    await fs.rename(tempPath, filePath);
    await fsyncDirectory(path.dirname(filePath));
    return "changed";
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw ioError(filePath, error);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(tempPath).catch(() => undefined);
  }
}

export async function normalizeGoalStates(
  context: AgentWorkspaceMigrationContext,
  hooks: MigrationHooks = {},
): Promise<MigrationResult> {
  const result: MigrationResult = { scanned: 0, changed: 0, ignored: 0 };
  let entries;
  try {
    entries = await fs.readdir(context.sessionsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw ioError(context.sessionsDir, error);
  }
  await cleanupTemps(context.sessionsDir).catch((error) => {
    throw error instanceof MigrationError ? error : ioError(context.sessionsDir, error);
  });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    result.scanned += 1;
    const outcome = await migrateFile(path.join(context.sessionsDir, name), context, hooks);
    if (outcome === "changed") result.changed += 1;
    else result.ignored += 1;
  }
  return result;
}

export const normalizeGoalStateV107: MigrationDefinition = {
  id: MIGRATION_ID,
  introducedIn: "1.0.7",
  scope: "agent-workspace",
  description: "Normalize persisted Goal state and route metadata",
  up: normalizeGoalStates,
};
