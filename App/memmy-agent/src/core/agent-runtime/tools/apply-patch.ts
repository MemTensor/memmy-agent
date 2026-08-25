import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { Tool, type ToolExecutionContext } from "./base.js";
import { appendFileLintResults, lintFiles, type FileLintRequest } from "./file-lint.js";
import {
  PatchError,
  normalizePatchPath,
  parsePatchEnvelope,
  type PatchFileOperation,
  type PatchHunk,
} from "./patch-envelope.js";

type FileSnapshot = { existed: boolean; bytes: Buffer | null; text: string | null };

type PendingChange =
  | {
      kind: "write";
      rel: string;
      target: string;
      before: Buffer | null;
      after: Buffer;
      verifyText: string;
      lintText: string;
      previousLintText: string | null;
      existed: boolean;
    }
  | { kind: "delete"; rel: string; target: string; before: Buffer }
  | { kind: "unchanged"; rel: string; target: string; before: Buffer };

type PatchPlan = {
  changes: PendingChange[];
  summaries: PatchSummary[];
  initialBytes: Map<string, Buffer | null>;
};

type Replacement = {
  startIndex: number;
  oldLength: number;
  replacementLines: string[];
  hunkIndex: number;
};

type DecodedText = { body: string; raw: string; bom: boolean };
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export class PatchSummary {
  constructor(
    public action: string,
    public path: string,
    public added = 0,
    public deleted = 0,
  ) {}
}

function createToolAbortError(): Error {
  const error = new Error("task cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw createToolAbortError();
}

export function validateRelativePath(value: string): string {
  return normalizePatchPath(value);
}

function splitTextLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function linesToText(lines: string[], newline = "\n"): string {
  return lines.length ? `${lines.join(newline)}${newline}` : "";
}

export function textLineCount(text: string): number {
  return text ? splitTextLines(text.replace(/\r\n/g, "\n")).length : 0;
}

export function lineDiffStats(before: string, after: string): [number, number] {
  const beforeLines = splitTextLines(before.replace(/\r\n/g, "\n"));
  const afterLines = splitTextLines(after.replace(/\r\n/g, "\n"));
  const dp = Array.from(
    { length: beforeLines.length + 1 },
    () => Array(afterLines.length + 1).fill(0) as number[],
  );
  for (let i = beforeLines.length - 1; i >= 0; i -= 1) {
    for (let j = afterLines.length - 1; j >= 0; j -= 1) {
      dp[i][j] =
        beforeLines[i] === afterLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const common = dp[0][0];
  return [afterLines.length - common, beforeLines.length - common];
}

export function formatSummary(summary: PatchSummary): string {
  const stats = summary.added || summary.deleted ? ` (+${summary.added}/-${summary.deleted})` : "";
  return `- ${summary.action} ${summary.path}${stats}`;
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { name?: string }).name === "AbortError");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeUnicodeMatch(value: string): string {
  return value
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018-\u201b]/g, "'")
    .replace(/[\u201c-\u201f]/g, '"')
    .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, " ");
}

function seekSequence(lines: string[], pattern: string[], cursor: number, eof: boolean): number | null {
  const transforms: Array<(value: string) => string> = [
    (value) => value,
    (value) => value.trimEnd(),
    (value) => value.trim(),
    normalizeUnicodeMatch,
  ];
  const lastStart = lines.length - pattern.length;
  for (const transform of transforms) {
    const expected = pattern.map(transform);
    for (let index = cursor; index <= lastStart; index += 1) {
      if (eof && index + pattern.length !== lines.length) continue;
      if (expected.every((line, offset) => transform(lines[index + offset]) === line)) return index;
    }
  }
  return null;
}

function decodeText(bytes: Buffer, rel: string): DecodedText {
  if (bytes.includes(0)) throw new PatchError(`binary files are not supported: ${rel}`);
  const bom = bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
  try {
    const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { raw, body: bom ? raw.slice(1) : raw, bom };
  } catch {
    throw new PatchError(`binary files are not supported: ${rel}`);
  }
}

function detectNewline(text: string, rel: string): { normalized: string; newline: "\n" | "\r\n" } {
  if (/\r(?!\n)/.test(text)) throw new PatchError(`unsupported line endings: ${rel}`);
  if (text.includes("\r\n") && text.replace(/\r\n/g, "").includes("\n")) {
    throw new PatchError(`unsupported mixed line endings: ${rel}`);
  }
  return {
    normalized: text.replace(/\r\n/g, "\n"),
    newline: text.includes("\r\n") ? "\r\n" : "\n",
  };
}

function patchContainsNull(operation: PatchFileOperation): boolean {
  if (operation.kind === "add") return operation.lines.some((line) => line.includes("\0"));
  if (operation.kind === "delete") return false;
  return operation.hunks.some(
    (hunk) =>
      hunk.anchor?.includes("\0") || hunk.lines.some((line) => line.text.includes("\0")),
  );
}

function locateReplacement(
  sourceLines: string[],
  hunk: PatchHunk,
  cursor: number,
  hunkIndex: number,
): { replacement: Replacement; cursor: number } {
  let searchCursor = cursor;
  if (hunk.anchor != null) {
    const anchorIndex = seekSequence(sourceLines, [hunk.anchor], searchCursor, false);
    if (anchorIndex == null) throw new PatchError(`hunk at line ${hunk.line} was not found`);
    searchCursor = anchorIndex + 1;
  }

  const oldLines = hunk.lines
    .filter((line) => line.kind !== "add")
    .map((line) => line.text);
  if (oldLines.length === 0) {
    const startIndex = hunk.endOfFile ? sourceLines.length : searchCursor;
    return {
      replacement: {
        startIndex,
        oldLength: 0,
        replacementLines: hunk.lines.map((line) => line.text),
        hunkIndex,
      },
      cursor: startIndex,
    };
  }

  const startIndex = seekSequence(sourceLines, oldLines, searchCursor, hunk.endOfFile);
  if (startIndex == null) throw new PatchError(`hunk at line ${hunk.line} was not found`);
  let sourceOffset = 0;
  const replacementLines: string[] = [];
  for (const line of hunk.lines) {
    if (line.kind === "add") {
      replacementLines.push(line.text);
      continue;
    }
    if (line.kind === "context") replacementLines.push(sourceLines[startIndex + sourceOffset]);
    sourceOffset += 1;
  }
  return {
    replacement: { startIndex, oldLength: oldLines.length, replacementLines, hunkIndex },
    cursor: startIndex + oldLines.length,
  };
}

function applyHunks(source: DecodedText, hunks: PatchHunk[], rel: string): { bytes: Buffer; text: string } {
  const { normalized, newline } = detectNewline(source.body, rel);
  const sourceLines = splitTextLines(normalized);
  const replacements: Replacement[] = [];
  let cursor = 0;
  for (let index = 0; index < hunks.length; index += 1) {
    try {
      const located = locateReplacement(sourceLines, hunks[index], cursor, index);
      replacements.push(located.replacement);
      cursor = located.cursor;
    } catch (error) {
      if (error instanceof PatchError) throw new PatchError(`${rel}: ${error.message}`);
      throw error;
    }
  }

  const resultLines = [...sourceLines];
  replacements
    .sort((left, right) => right.startIndex - left.startIndex || right.hunkIndex - left.hunkIndex)
    .forEach((replacement) => {
      resultLines.splice(replacement.startIndex, replacement.oldLength, ...replacement.replacementLines);
    });
  const body = linesToText(resultLines, newline);
  const text = `${source.bom ? "\ufeff" : ""}${body}`;
  return { bytes: Buffer.from(text, "utf8"), text };
}

function operationSummary(
  operation: PatchFileOperation,
  beforeText: string | null,
  afterText: string | null,
  unchanged: boolean,
): PatchSummary {
  if (unchanged) return new PatchSummary("unchanged", operation.path);
  if (operation.kind === "add") {
    return new PatchSummary("add", operation.path, textLineCount(afterText ?? ""), 0);
  }
  if (operation.kind === "delete") {
    return new PatchSummary("delete", operation.path, 0, textLineCount(beforeText ?? ""));
  }
  const [added, deleted] = lineDiffStats(beforeText ?? "", afterText ?? "");
  if (operation.moveTo) {
    return new PatchSummary("move", `${operation.path} -> ${operation.moveTo}`, added, deleted);
  }
  return new PatchSummary("update", operation.path, added, deleted);
}

export class ApplyPatchTool extends Tool {
  static scopes = new Set(["core", "subagent"]);
  workspace: string;

  constructor({ workspace = process.cwd() }: { workspace?: string } = {}) {
    super();
    this.workspace = path.resolve(workspace);
  }

  static create(ctx: any): Tool {
    return new ApplyPatchTool({ workspace: ctx?.workspace ?? process.cwd() });
  }

  get name(): string {
    return "apply_patch";
  }

  get description(): string {
    return "Apply a patch to add, update, delete, or move one or more workspace-relative files.";
  }

  get parameters() {
    return {
      type: "object",
      additionalProperties: false,
      properties: {
        input: {
          type: "string",
          minLength: 1,
          description: `The complete patch text. Use this format:

*** Begin Patch
*** Add File: path/to/new-file
+new content
*** Update File: path/to/existing-file
@@
 unchanged line
-old line
+new line
*** Delete File: path/to/obsolete-file
*** End Patch

To move or rename a file, use:

*** Update File: old/path
*** Move to: new/path

Start each update hunk with @@. If needed, add an exact line from the file after @@ to help locate the change, for example: @@ function calculate().
Prefix added lines with +, removed lines with -, and unchanged context lines with a space.
Use *** End of File for an append or a hunk that must end at EOF.
Paths must be workspace-relative. Use at most 20 file operations in one patch.`,
        },
      },
      required: ["input"],
    };
  }

  castParams(params: Record<string, any>): Record<string, any> {
    return params;
  }

  resolve(relativePath: string): string {
    const normalized = normalizePatchPath(relativePath);
    const target = path.resolve(this.workspace, ...normalized.split("/"));
    const relative = path.relative(this.workspace, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new PatchError(`patch path escapes workspace: ${relativePath}`);
    }

    const segments = normalized.split("/");
    let current = this.workspace;
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]);
      let stat: fsSync.Stats;
      try {
        stat = fsSync.lstatSync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw new PatchError(`cannot inspect patch path ${normalized}: ${errorMessage(error)}`);
      }
      if (stat.isSymbolicLink()) throw new PatchError(`symbolic links are not supported: ${normalized}`);
      if (index < segments.length - 1 && !stat.isDirectory()) {
        throw new PatchError(`patch path parent is not a directory: ${normalized}`);
      }
    }
    return target;
  }

  private async readSnapshot(target: string, signal?: AbortSignal | null): Promise<FileSnapshot> {
    throwIfAborted(signal);
    let stat: fsSync.Stats;
    try {
      stat = await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { existed: false, bytes: null, text: null };
      }
      throw error;
    }
    if (!stat.isFile()) throw new PatchError("path is not a regular file: " + target);
    const bytes = await fs.readFile(target, { signal: signal ?? undefined });
    return { existed: true, bytes, text: null };
  }

  private async planOperations(
    operations: PatchFileOperation[],
    signal?: AbortSignal | null,
  ): Promise<PatchPlan> {
    const resolved = new Map<string, string>();
    for (const operation of operations) {
      throwIfAborted(signal);
      resolved.set(operation.path, this.resolve(operation.path));
      if (operation.kind === "update" && operation.moveTo) {
        resolved.set(operation.moveTo, this.resolve(operation.moveTo));
      }
    }

    const snapshots = new Map<string, FileSnapshot>();
    const getSnapshot = async (rel: string): Promise<FileSnapshot> => {
      const target = resolved.get(rel)!;
      let snapshot = snapshots.get(target);
      if (!snapshot) {
        snapshot = await this.readSnapshot(target, signal);
        snapshots.set(target, snapshot);
      }
      return snapshot;
    };

    const changes: PendingChange[] = [];
    const summaries: PatchSummary[] = [];
    for (const operation of operations) {
      throwIfAborted(signal);
      if (patchContainsNull(operation)) {
        throw new PatchError("binary files are not supported: " + operation.path);
      }
      const sourceTarget = resolved.get(operation.path)!;
      const source = await getSnapshot(operation.path);

      if (operation.kind === "add") {
        if (source.existed) throw new PatchError("file already exists: " + operation.path);
        const text = linesToText(operation.lines);
        const after = Buffer.from(text, "utf8");
        changes.push({
          kind: "write",
          rel: operation.path,
          target: sourceTarget,
          before: null,
          after,
          verifyText: text,
          lintText: text,
          previousLintText: null,
          existed: false,
        });
        summaries.push(operationSummary(operation, null, text, false));
        continue;
      }

      if (!source.existed || !source.bytes) {
        throw new PatchError("file does not exist: " + operation.path);
      }
      const decoded = decodeText(source.bytes, operation.path);
      source.text = decoded.raw;
      if (operation.kind === "delete") {
        changes.push({ kind: "delete", rel: operation.path, target: sourceTarget, before: source.bytes });
        summaries.push(operationSummary(operation, decoded.body, null, false));
        continue;
      }

      let after = source.bytes;
      let afterRaw = decoded.raw;
      let afterBody = decoded.body;
      if (operation.hunks.length) {
        const updated = applyHunks(decoded, operation.hunks, operation.path);
        after = updated.bytes;
        afterRaw = updated.text;
        afterBody = decoded.bom ? updated.text.slice(1) : updated.text;
      }

      if (operation.moveTo) {
        const moveTarget = resolved.get(operation.moveTo)!;
        const destination = await getSnapshot(operation.moveTo);
        if (destination.existed) {
          throw new PatchError("move target already exists: " + operation.moveTo);
        }
        changes.push({
          kind: "write",
          rel: operation.moveTo,
          target: moveTarget,
          before: null,
          after,
          verifyText: after.toString("utf8"),
          lintText: afterRaw,
          previousLintText: null,
          existed: false,
        });
        changes.push({ kind: "delete", rel: operation.path, target: sourceTarget, before: source.bytes });
        summaries.push(operationSummary(operation, decoded.body, afterBody, false));
        continue;
      }

      const unchanged = source.bytes.equals(after);
      if (unchanged) {
        changes.push({ kind: "unchanged", rel: operation.path, target: sourceTarget, before: source.bytes });
      } else {
        changes.push({
          kind: "write",
          rel: operation.path,
          target: sourceTarget,
          before: source.bytes,
          after,
          verifyText: after.toString("utf8"),
          lintText: afterRaw,
          previousLintText: decoded.raw,
          existed: true,
        });
      }
      summaries.push(operationSummary(operation, decoded.body, afterBody, unchanged));
    }

    const initialBytes = new Map<string, Buffer | null>();
    for (const [target, snapshot] of snapshots) initialBytes.set(target, snapshot.bytes);
    return { changes, summaries, initialBytes };
  }

  private async rollback(
    attemptedPaths: string[],
    initialBytes: Map<string, Buffer | null>,
  ): Promise<string[]> {
    const failures: string[] = [];
    for (let index = attemptedPaths.length - 1; index >= 0; index -= 1) {
      const target = attemptedPaths[index];
      try {
        const before = initialBytes.get(target) ?? null;
        if (before == null) {
          await fs.rm(target, { force: true });
        } else {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, before);
        }
      } catch (error) {
        failures.push(target + ": " + errorMessage(error));
      }
    }
    return failures;
  }

  private async applyChanges(plan: PatchPlan, context?: ToolExecutionContext): Promise<string> {
    const signal = context?.abortSignal ?? null;
    const actionable = plan.changes.filter((change) => change.kind !== "unchanged");
    const unchanged = plan.changes.filter((change) => change.kind === "unchanged");
    if (!actionable.length) {
      throwIfAborted(signal);
      for (const change of unchanged) {
        context?.reportFileMutation?.({ path: change.target, changed: false });
      }
      throwIfAborted(signal);
      return "No changes made by patch:\n" + plan.summaries.map(formatSummary).join("\n");
    }

    const attemptedPaths: string[] = [];
    const attempted = new Set<string>();
    const markAttempted = (target: string): void => {
      if (attempted.has(target)) return;
      attempted.add(target);
      attemptedPaths.push(target);
    };

    try {
      for (const change of actionable) {
        throwIfAborted(signal);
        markAttempted(change.target);
        if (change.kind === "delete") {
          await fs.rm(change.target);
        } else {
          await fs.mkdir(path.dirname(change.target), { recursive: true });
          await fs.writeFile(change.target, change.after, { signal: signal ?? undefined });
        }
      }

      const lintRequests: FileLintRequest[] = [];
      for (const change of actionable) {
        throwIfAborted(signal);
        if (change.kind === "delete") {
          if (fsSync.existsSync(change.target)) {
            throw new PatchError("Delete verification failed: " + change.target + " still exists");
          }
          continue;
        }
        const stat = await fs.stat(change.target);
        if (!stat.isFile()) {
          throw new PatchError("Write verification failed: " + change.target + " is not a regular file");
        }
        throwIfAborted(signal);
        const content = await fs.readFile(change.target, {
          encoding: "utf8",
          signal: signal ?? undefined,
        });
        if (content !== change.verifyText) {
          throw new PatchError("Write verification failed: content mismatch for " + change.target);
        }
        lintRequests.push({
          path: change.target,
          content: change.lintText,
          previousContent: change.previousLintText,
          useDelta: change.existed,
        });
      }

      throwIfAborted(signal);
      const lintResults = await lintFiles(lintRequests, { abortSignal: signal });
      throwIfAborted(signal);
      const success = "Patch applied:\n" + plan.summaries.map(formatSummary).join("\n");
      const result = appendFileLintResults(success, lintResults);
      for (const change of unchanged) {
        context?.reportFileMutation?.({ path: change.target, changed: false });
      }
      return result;
    } catch (error) {
      const rollbackFailures = await this.rollback(attemptedPaths, plan.initialBytes);
      if (!rollbackFailures.length) throw error;
      throw new PatchError(
        errorMessage(error) + "; rollback failed for " + rollbackFailures.join(", "),
      );
    }
  }

  async execute(params: Record<string, any> = {}, context?: ToolExecutionContext): Promise<string> {
    if (
      !params ||
      typeof params !== "object" ||
      Array.isArray(params) ||
      typeof params.input !== "string" ||
      !params.input.trim()
    ) {
      return "Error applying patch: input must be a non-empty string";
    }
    if (Object.keys(params).length !== 1 || !("input" in params)) {
      return "Error applying patch: apply_patch accepts only the input parameter";
    }

    const signal = context?.abortSignal ?? null;
    let plan: PatchPlan;
    try {
      throwIfAborted(signal);
      const operations = parsePatchEnvelope(params.input);
      plan = await this.planOperations(operations, signal);
      throwIfAborted(signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      return "Error applying patch: " + errorMessage(error);
    }
    return this.applyChanges(plan, context);
  }
}
