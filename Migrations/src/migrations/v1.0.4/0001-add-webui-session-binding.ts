import { randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";
import {
  MigrationError,
  type AgentWorkspaceMigrationContext,
  type MigrationDefinition,
  type MigrationResult,
} from "../../types.js";

const MIGRATION_ID = "v1.0.4/0001-add-webui-session-binding";
const TEMP_MARKER = "v1.0.4-0001";
const READ_BUFFER_SIZE = 64 * 1024;
const TEMP_FILE_PATTERN =
  /^\..+\.jsonl\.v1\.0\.4-0001\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;

type JsonObject = Record<string, unknown>;

type RecordLocation = {
  content: Buffer;
  start: number;
  end: number;
  newline: Buffer;
};

type MigrationHooks = {
  beforeCommit?: (filePath: string) => Promise<void>;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

async function findFirstNonEmptyRecord(
  source: FileHandle,
  fileSize: number,
): Promise<RecordLocation | null> {
  const readBuffer = Buffer.allocUnsafe(READ_BUFFER_SIZE);
  let absoluteOffset = 0;
  let lineStart = 0;
  let lineParts: Buffer[] = [];

  while (absoluteOffset < fileSize) {
    const bytesToRead = Math.min(readBuffer.length, fileSize - absoluteOffset);
    const { bytesRead } = await source.read(readBuffer, 0, bytesToRead, absoluteOffset);
    if (bytesRead === 0) break;

    let segmentStart = 0;
    for (let index = 0; index < bytesRead; index += 1) {
      if (readBuffer[index] !== 0x0a) continue;

      lineParts.push(Buffer.from(readBuffer.subarray(segmentStart, index)));
      let content = Buffer.concat(lineParts);
      let newline = Buffer.from("\n");
      if (content.at(-1) === 0x0d) {
        content = content.subarray(0, content.length - 1);
        newline = Buffer.from("\r\n");
      }

      const lineEnd = absoluteOffset + index + 1;
      if (content.toString("utf8").trim().length > 0) {
        return { content, start: lineStart, end: lineEnd, newline };
      }

      lineParts = [];
      lineStart = lineEnd;
      segmentStart = index + 1;
    }

    if (segmentStart < bytesRead) {
      lineParts.push(Buffer.from(readBuffer.subarray(segmentStart, bytesRead)));
    }
    absoluteOffset += bytesRead;
  }

  const content = Buffer.concat(lineParts);
  if (content.toString("utf8").trim().length === 0) return null;
  return {
    content,
    start: lineStart,
    end: fileSize,
    newline: Buffer.alloc(0),
  };
}

async function writeAll(handle: FileHandle, value: Buffer): Promise<void> {
  let offset = 0;
  while (offset < value.length) {
    const { bytesWritten } = await handle.write(value, offset, value.length - offset);
    if (bytesWritten === 0) {
      throw new Error("Unable to make progress while writing migration output");
    }
    offset += bytesWritten;
  }
}

async function copyRange(
  source: FileHandle,
  target: FileHandle,
  start: number,
  end: number,
): Promise<void> {
  const buffer = Buffer.allocUnsafe(READ_BUFFER_SIZE);
  let position = start;
  while (position < end) {
    const bytesToRead = Math.min(buffer.length, end - position);
    const { bytesRead } = await source.read(buffer, 0, bytesToRead, position);
    if (bytesRead === 0) {
      throw new Error("Session ended before migration copy completed");
    }
    await writeAll(target, buffer.subarray(0, bytesRead));
    position += bytesRead;
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

function isValidBinding(metadata: JsonObject): boolean {
  const projectId = metadata.webuiProjectId;
  const cwd = metadata.webuiWorkspaceCwd;
  const projectIdValid =
    projectId === null || (typeof projectId === "string" && projectId.trim().length > 0);
  return (
    projectIdValid &&
    typeof cwd === "string" &&
    path.isAbsolute(cwd) &&
    path.resolve(cwd) === cwd
  );
}

function parseCandidate(
  location: RecordLocation,
):
  | { kind: "candidate"; record: JsonObject; metadata: JsonObject }
  | { kind: "ignore" }
  | { kind: "warning"; code: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(location.content.toString("utf8"));
  } catch {
    return { kind: "warning", code: "metadata_json_invalid" };
  }
  if (!isObject(parsed)) return { kind: "warning", code: "metadata_record_invalid" };
  if (parsed.recordType !== "metadata") return { kind: "ignore" };
  if (typeof parsed.key !== "string" || !parsed.key.trim() || !parsed.key.startsWith("websocket:")) {
    return { kind: "ignore" };
  }
  if (!isObject(parsed.metadata)) {
    return { kind: "warning", code: "metadata_value_invalid" };
  }
  if (parsed.metadata.webui !== true) return { kind: "ignore" };

  const hasProjectId = Object.prototype.hasOwnProperty.call(
    parsed.metadata,
    "webuiProjectId",
  );
  const hasWorkspaceCwd = Object.prototype.hasOwnProperty.call(
    parsed.metadata,
    "webuiWorkspaceCwd",
  );
  if (!hasProjectId && !hasWorkspaceCwd) {
    return { kind: "candidate", record: parsed, metadata: parsed.metadata };
  }
  if (hasProjectId && hasWorkspaceCwd && isValidBinding(parsed.metadata)) {
    return { kind: "ignore" };
  }
  return { kind: "warning", code: "webui_binding_invalid" };
}

async function cleanupMigrationTemps(sessionsDir: string): Promise<void> {
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !TEMP_FILE_PATTERN.test(entry.name)) continue;
    await fs.unlink(path.join(sessionsDir, entry.name));
  }
}

async function migrateSessionFile(
  filePath: string,
  profileWorkspace: string,
  context: AgentWorkspaceMigrationContext,
  hooks: MigrationHooks,
): Promise<"changed" | "ignored"> {
  let initial: BigIntStats;
  try {
    initial = await fs.lstat(filePath, { bigint: true });
  } catch (error) {
    throw ioError(filePath, error);
  }
  if (!initial.isFile()) return "ignored";
  if (initial.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw ioError(filePath, new Error("Session file is too large to address safely"));
  }

  let source: FileHandle | null = null;
  let target: FileHandle | null = null;
  let tempPath: string | null = null;
  try {
    source = await fs.open(filePath, fsConstants.O_RDONLY);
    const fileSize = Number(initial.size);
    const location = await findFirstNonEmptyRecord(source, fileSize);
    if (!location) return "ignored";

    const candidate = parseCandidate(location);
    if (candidate.kind === "warning") {
      context.logger.warn("migration_session_ignored", {
        migrationId: MIGRATION_ID,
        scope: "agent-workspace",
        filePath,
        errorCode: candidate.code,
      });
      return "ignored";
    }
    if (candidate.kind === "ignore") return "ignored";

    const migratedRecord: JsonObject = {
      ...candidate.record,
      metadata: {
        ...candidate.metadata,
        webuiProjectId: null,
        webuiWorkspaceCwd: profileWorkspace,
      },
    };
    const migratedLine = Buffer.concat([
      Buffer.from(JSON.stringify(migratedRecord), "utf8"),
      location.newline,
    ]);

    tempPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${TEMP_MARKER}.${process.pid}.${randomUUID()}.tmp`,
    );
    const mode = Number(initial.mode & 0o7777n);
    target = await fs.open(
      tempPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      mode,
    );
    await target.chmod(mode);
    await copyRange(source, target, 0, location.start);
    await writeAll(target, migratedLine);
    await copyRange(source, target, location.end, fileSize);
    await target.sync();
    await target.close();
    target = null;
    await source.close();
    source = null;

    await hooks.beforeCommit?.(filePath);
    let current: BigIntStats;
    try {
      current = await fs.lstat(filePath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw sourceChangedError(filePath);
      }
      throw error;
    }
    if (!sameFingerprint(initial, current)) throw sourceChangedError(filePath);

    await fs.rename(tempPath, filePath);
    tempPath = null;
    await fsyncDirectory(path.dirname(filePath));
    return "changed";
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw ioError(filePath, error);
  } finally {
    await source?.close().catch(() => undefined);
    await target?.close().catch(() => undefined);
    if (tempPath) await fs.unlink(tempPath).catch(() => undefined);
  }
}

export async function migrateWebuiSessionBindings(
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

  try {
    await cleanupMigrationTemps(context.sessionsDir);
  } catch (error) {
    throw error instanceof MigrationError ? error : ioError(context.sessionsDir, error);
  }

  const jsonlNames = entries
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".jsonl"))
    .sort((left, right) => left.localeCompare(right));

  for (const name of jsonlNames) {
    result.scanned += 1;
    const outcome = await migrateSessionFile(
      path.join(context.sessionsDir, name),
      context.profileWorkspace,
      context,
      hooks,
    );
    if (outcome === "changed") result.changed += 1;
    else result.ignored += 1;
  }
  return result;
}

export const addWebuiSessionBindingV104: MigrationDefinition = {
  id: MIGRATION_ID,
  introducedIn: "1.0.4",
  scope: "agent-workspace",
  description: "Add standalone project bindings to legacy WebUI sessions",
  up: migrateWebuiSessionBindings,
};
