import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { Tool, type ToolExecutionContext } from "./base.js";

type EditAction = "add" | "replace" | "delete";
type PatchEdit = {
  path?: string;
  action?: EditAction;
  oldText?: string;
  newText?: string;
};

type PendingChange =
  | { kind: "write"; rel: string; target: string; content: string; existed: boolean }
  | { kind: "delete"; rel: string; target: string; previous: string };

type PatchPlan = {
  changes: PendingChange[];
  summaries: PatchSummary[];
};

export class PatchSummary {
  constructor(
    public action: string,
    public path: string,
    public added = 0,
    public deleted = 0,
  ) {}
}

export class PatchError extends Error {}

function hasParentSegment(value: string): boolean {
  return value.split(/[\\/]+/).some((part) => part === "..");
}

function isWindowsAbsolute(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function normalizeNewText(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
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
  const normalized = value.trim();
  if (!normalized) throw new PatchError("patch path cannot be empty");
  if (normalized.includes("\0")) throw new PatchError(`patch path contains a null byte: ${value}`);
  if (
    normalized.startsWith("~") ||
    normalized.startsWith("/") ||
    normalized.startsWith("\\") ||
    isWindowsAbsolute(normalized)
  ) {
    throw new PatchError(`patch path must be relative: ${value}`);
  }
  if (hasParentSegment(normalized))
    throw new PatchError(`patch path must not contain '..': ${value}`);
  return normalized;
}

export function linesToText(lines: string[]): string {
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export function textLineCount(text: string): number {
  return text
    ? text
        .split(/\r?\n/)
        .filter((line, index, lines) => index < lines.length - 1 || line.length > 0).length
    : 0;
}

export function lineDiffStats(before: string, after: string): [number, number] {
  const beforeLines = before.replace(/\r\n/g, "\n").split("\n");
  if (beforeLines.at(-1) === "") beforeLines.pop();
  const afterLines = after.replace(/\r\n/g, "\n").split("\n");
  if (afterLines.at(-1) === "") afterLines.pop();
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

function findSingle(content: string, needle: string): string | null {
  if (!needle) return "oldText required";
  const first = content.indexOf(needle);
  if (first === -1) return "oldText not found";
  if (content.indexOf(needle, first + needle.length) !== -1)
    return "oldText appears multiple times";
  return null;
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
    return (
      "Default tool for code edits. Supports multi-file changes in a single call. " +
      "Provide a list of structured edits, each specifying a file path, action (replace/add/delete), and the text to change. " +
      "Paths must be relative. Set dryRun=true to validate and preview without writing files. " +
      "Use edit_file only for small exact replacements."
    );
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Relative path to the file to edit." },
              action: {
                type: "string",
                enum: ["replace", "add", "delete"],
                description:
                  "Operation type: replace (find and replace text), add (append new content or create file), delete (remove text).",
              },
              oldText: {
                type: "string",
                nullable: true,
                description: "Exact text to search for in the file. Required for replace and delete.",
              },
              newText: {
                type: "string",
                nullable: true,
                description: "Text to replace with or append. Required for replace and add.",
              },
            },
            required: ["path", "action"],
          },
        },
        dryRun: { type: "boolean" },
      },
      required: ["edits"],
    };
  }

  private resolveRel(rel: string): string | Error {
    try {
      const safe = validateRelativePath(rel);
      return path.resolve(this.workspace, safe.replace(/\\/g, path.sep));
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  private async planEdits(edits: PatchEdit[], signal?: AbortSignal | null): Promise<PatchPlan | string> {
    const contents = new Map<
      string,
      { rel: string; existed: boolean; content: string | null; previous: string | null }
    >();
    const summaries: PatchSummary[] = [];
    const getState = async (rel: string, target: string) => {
      let state = contents.get(target);
      if (!state) {
        throwIfAborted(signal);
        const existed = fsSync.existsSync(target);
        const previous = existed ? await fs.readFile(target, { encoding: "utf8", signal: signal ?? undefined }) : null;
        state = { rel, existed, content: previous, previous };
        contents.set(target, state);
      }
      return state;
    };

    for (const edit of edits) {
      if (!edit || typeof edit !== "object" || Array.isArray(edit))
        return "each edit must be an object";
      const rel = edit.path;
      if (!rel) return "path required for edit";
      if (!edit.action) return `action required for edit: ${rel}`;
      const target = this.resolveRel(rel);
      if (target instanceof Error) return target.message;
      const state = await getState(rel, target);
      const oldText = edit.oldText ?? "";
      const newText = edit.newText;

      if (edit.action === "add") {
        if (newText == null) return `newText required for add: ${rel}`;
        const before = state.content ?? "";
        const addition = normalizeNewText(newText);
        state.content =
          state.content == null ? addition : normalizeNewText(`${state.content}${newText}`);
        if (state.existed) {
          const [added, deleted] = lineDiffStats(before, state.content);
          summaries.push(new PatchSummary("update", rel, added, deleted));
        } else {
          summaries.push(new PatchSummary("add", rel, textLineCount(state.content), 0));
        }
        continue;
      }

      if (state.content == null) return `file to update does not exist: ${rel}`;
      const err = findSingle(state.content, oldText);
      if (err) return err;

      if (edit.action === "replace") {
        if (newText == null) return `newText required for replace: ${rel}`;
        const before = state.content;
        state.content = normalizeNewText(state.content.replace(oldText, newText));
        const [added, deleted] = lineDiffStats(before, state.content);
        summaries.push(new PatchSummary("update", rel, added, deleted));
      } else if (edit.action === "delete") {
        const before = state.content;
        if (state.content === oldText) {
          state.content = null;
          summaries.push(new PatchSummary("delete", rel, 0, textLineCount(before)));
        } else {
          state.content = normalizeNewText(state.content.replace(oldText, ""));
          const [added, deleted] = lineDiffStats(before, state.content);
          summaries.push(new PatchSummary("update", rel, added, deleted));
        }
      } else {
        return `unknown action: ${edit.action}`;
      }
    }

    const changes = [...contents.entries()].map(([target, state]) =>
      state.content == null
        ? { kind: "delete" as const, rel: state.rel, target, previous: state.previous ?? "" }
        : {
            kind: "write" as const,
            rel: state.rel,
            target,
            content: state.content,
            existed: state.existed,
          },
    );
    return { changes, summaries };
  }

  private async applyChanges(plan: PatchPlan, signal?: AbortSignal | null): Promise<string> {
    const backups = new Map<string, Buffer | null>();
    for (const change of plan.changes) {
      throwIfAborted(signal);
      backups.set(
        change.target,
        fsSync.existsSync(change.target) ? await fs.readFile(change.target) : null,
      );
    }
    let applied = false;
    try {
      for (const change of plan.changes) {
        throwIfAborted(signal);
        if (change.kind === "delete") {
          applied = true;
          await fs.rm(change.target, { force: true });
        } else {
          await fs.mkdir(path.dirname(change.target), { recursive: true });
          applied = true;
          await fs.writeFile(change.target, change.content, { encoding: "utf8", signal: signal ?? undefined });
        }
      }
    } catch (err) {
      if (applied) {
        for (const [target, data] of backups) {
          if (data == null) await fs.rm(target, { force: true });
          else {
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, data);
          }
        }
      }
      throw err;
    }
    return `Patch applied:\n${plan.summaries.map(formatSummary).join("\n")}`;
  }

  async execute(params: { edits?: PatchEdit[]; dryRun?: boolean } = {}, context?: ToolExecutionContext): Promise<string> {
    if (!Array.isArray(params.edits)) return "Error: edits must be a list";
    if (!params.edits.length) return "Error applying patch: must provide edits";
    const signal = context?.abortSignal ?? null;
    throwIfAborted(signal);
    const planned = await this.planEdits(params.edits, signal);
    if (typeof planned === "string") return `Error: ${planned}`;
    throwIfAborted(signal);
    if (params.dryRun) {
      return `Patch dry-run succeeded:\n${planned.summaries.map(formatSummary).join("\n")}`;
    }
    return this.applyChanges(planned, signal);
  }
}
