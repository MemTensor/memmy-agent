import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";
import { Tool } from "./base.js";
import { isPathInside, resolveWorkspacePath, workspaceRelative } from "./path-utils.js";
import { getMediaDir } from "../../../config/paths.js";
import { BUILTIN_SKILLS_DIR } from "../skills.js";

const DEFAULT_HEAD_LIMIT = 250;
const DEFAULT_FILE_HEAD_LIMIT = 200;

const TYPE_GLOB_MAP: Record<string, string[]> = {
  js: ["*.js", "*.jsx", "*.mjs", "*.cjs"],
  ts: ["*.ts", "*.tsx", "*.mts", "*.cts"],
  tsx: ["*.tsx"],
  jsx: ["*.jsx"],
  json: ["*.json"],
  md: ["*.md", "*.mdx"],
  markdown: ["*.md", "*.mdx"],
  go: ["*.go"],
  rs: ["*.rs"],
  rust: ["*.rs"],
  java: ["*.java"],
  sh: ["*.sh", "*.bash"],
  yaml: ["*.yaml", "*.yml"],
  yml: ["*.yaml", "*.yml"],
  toml: ["*.toml"],
  sql: ["*.sql"],
  html: ["*.html", "*.htm"],
  css: ["*.css", "*.scss", "*.sass"],
  log: ["*.log"],
};

const IGNORE_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage"]);

export function normalizePattern(pattern: string): string {
  return pattern.trim().replaceAll("\\", "/");
}

export function matchGlob(relPath: string, name: string, pattern: string): boolean {
  const normalized = normalizePattern(pattern);
  if (!normalized) return false;
  if (normalized.includes("/") || normalized.startsWith("**")) return minimatch(relPath, normalized, { dot: true });
  return minimatch(name, normalized, { dot: true });
}

export function isBinary(raw: Buffer | Uint8Array): boolean {
  if (Buffer.from(raw).includes(0)) return true;
  const sample = Buffer.from(raw).subarray(0, 4096);
  if (!sample.length) return false;
  let nonText = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) nonText += 1;
  }
  return nonText / sample.length > 0.2;
}

export function paginate<T>(items: T[], limit: number | null | undefined, offset: number): [T[], boolean] {
  if (limit == null) return [items.slice(offset), false];
  return [items.slice(offset, offset + limit), items.length > offset + limit];
}

export function paginationNote(limit: number | null | undefined, offset: number, truncated: boolean): string | null {
  if (truncated) return limit == null ? `(pagination: offset=${offset})` : `(pagination: limit=${limit}, offset=${offset})`;
  if (offset > 0) return `(pagination: offset=${offset})`;
  return null;
}

export function matchesType(name: string, fileType?: string | null): boolean {
  if (!fileType) return true;
  const lowered = fileType.trim().toLowerCase();
  if (!lowered) return true;
  const patterns = TYPE_GLOB_MAP[lowered] ?? [`*.${lowered.replace(/^\./, "")}`];
  return patterns.some((pattern) => minimatch(name.toLowerCase(), pattern.toLowerCase(), { dot: true }));
}

export function matchesQuery(relPath: string, query?: string | null): boolean {
  if (!query) return true;
  const haystack = relPath.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
}

async function safeStat(target: string): Promise<fsSync.Stats | null> {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

function shouldRestrictToWorkspace(ctx: any): boolean {
  return Boolean(ctx?.config?.restrictToWorkspace || ctx?.config?.exec?.sandbox);
}

function resolveExtraAllowedDirs(dirs?: string[] | null): string[] {
  return (dirs ?? []).map((dir) => path.resolve(dir));
}

function isSearchPathAllowed(target: string, allowedDir: string | null, extraAllowedDirs: string[] = []): boolean {
  return (
    !allowedDir
    || isPathInside(target, allowedDir)
    || isPathInside(target, getMediaDir())
    || extraAllowedDirs.some((dir) => isPathInside(target, dir))
  );
}

export class SearchTool extends Tool {
  static IGNORE_DIRS = IGNORE_DIRS;
  static scopes = new Set(["core", "subagent"]);
  workspace: string;
  allowedDir: string | null;
  extraAllowedDirs: string[];

  constructor({ workspace = process.cwd(), allowedDir, extraAllowedDirs }: { workspace?: string; allowedDir?: string; extraAllowedDirs?: string[] } = {}) {
    super();
    this.workspace = path.resolve(String(workspace));
    this.allowedDir = allowedDir ? path.resolve(allowedDir) : null;
    this.extraAllowedDirs = resolveExtraAllowedDirs(extraAllowedDirs);
  }

  get name(): string {
    return "search";
  }

  get description(): string {
    return "Base search tool";
  }

  get parameters() {
    return { type: "object", properties: {} };
  }

  async execute(): Promise<string> {
    return "Error: base search tool cannot be executed directly";
  }

  override get readOnly(): boolean {
    return true;
  }

  resolvePath(requested = "."): string {
    return resolveWorkspacePath(this.workspace, requested || ".");
  }

  displayPath(target: string, root: string): string {
    if (this.workspace && isPathInside(target, this.workspace)) {
      return workspaceRelative(this.workspace, target).replaceAll(path.sep, "/");
    }
    return path.relative(root, target).replaceAll(path.sep, "/") || ".";
  }

  async *iterFiles(root: string): AsyncIterable<string> {
    const stat = await safeStat(root);
    if (!stat) return;
    if (stat.isFile()) {
      yield root;
      return;
    }
    if (!stat.isDirectory()) return;
    const entries = await fs.readdir(root, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory() && !IGNORE_DIRS.has(entry.name)).map((entry) => entry.name).sort();
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
    for (const file of files) yield path.join(root, file);
    for (const dir of dirs) yield* this.iterFiles(path.join(root, dir));
  }
}

export class FindFilesTool extends SearchTool {
  static override scopes = new Set(["core", "subagent"]);

  static create(ctx: any): Tool {
    const restrict = shouldRestrictToWorkspace(ctx);
    return new FindFilesTool({
      workspace: ctx?.workspace ?? process.cwd(),
      allowedDir: restrict ? ctx?.workspace : undefined,
      extraAllowedDirs: restrict ? [BUILTIN_SKILLS_DIR] : undefined,
    });
  }

  override get name(): string {
    return "find_files";
  }

  override get description(): string {
    return (
      "Find files by path fragment, glob, or file type. " +
      "Use this before read_file when you need to locate files, and prefer it over shell find/ls for ordinary workspace discovery. " +
      "Returns workspace-relative paths and skips common dependency/build directories."
    );
  }

  override get parameters() {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory or file to search in (default '.')" },
        query: { type: "string", description: "Optional case-insensitive path fragment search. Whitespace-separated terms must all be present." },
        glob: { type: "string", description: "Optional file filter, e.g. '*.ts' or 'tests/**/*.test.ts'" },
        type: { type: "string", description: "Optional file type shorthand, e.g. 'ts', 'md', 'json'" },
        include_dirs: { type: "boolean", description: "Include matching directories as well as files (default false)" },
        sort: { type: "string", enum: ["path", "modified"], description: "Sort by path or most recently modified first (default path)" },
        head_limit: { type: "integer", minimum: 0, maximum: 1000, description: "Maximum number of paths to return (default 200, 0 for all, max 1000)" },
        offset: { type: "integer", minimum: 0, maximum: 100000, description: "Skip the first N results before applying head_limit" },
      },
    };
  }

  async *iterPaths(root: string, { includeDirs = false }: { includeDirs?: boolean } = {}): AsyncIterable<string> {
    const stat = await safeStat(root);
    if (!stat) return;
    if (stat.isFile()) {
      yield root;
      return;
    }
    if (!stat.isDirectory()) return;
    if (includeDirs) yield root;
    const entries = await fs.readdir(root, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory() && !IGNORE_DIRS.has(entry.name)).map((entry) => entry.name).sort();
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
    for (const file of files) yield path.join(root, file);
    for (const dir of dirs) {
      const child = path.join(root, dir);
      if (includeDirs) yield child;
      yield* this.iterPaths(child, { includeDirs });
    }
  }

  async execute(params: {
    path?: string;
    query?: string;
    glob?: string;
    type?: string;
    include_dirs?: boolean;
    includeDirs?: boolean;
    sort?: "path" | "modified" | "name";
    head_limit?: number | null;
    headLimit?: number | null;
    offset?: number;
  } = {}): Promise<string> {
    try {
      const requested = params.path ?? ".";
      const target = this.resolvePath(requested);
      if (!isSearchPathAllowed(target, this.allowedDir, this.extraAllowedDirs)) return `Error: Path outside workspace: ${requested}`;
      const stat = await safeStat(target);
      if (!stat) return `Error: Path not found: ${requested}`;
      if (!stat.isDirectory() && !stat.isFile()) return `Error: Unsupported path: ${requested}`;
      const sort = params.sort ?? "path";
      if (sort !== "path" && sort !== "modified" && sort !== "name") return "Error: sort must be 'path' or 'modified'";

      const rawLimit = params.head_limit ?? params.headLimit;
      const limit = rawLimit == null ? DEFAULT_FILE_HEAD_LIMIT : rawLimit === 0 ? null : rawLimit;
      const offset = params.offset ?? 0;
      const includeDirs = params.include_dirs ?? params.includeDirs ?? false;
      const root = stat.isDirectory() ? target : path.dirname(target);
      const matches: Array<{ display: string; mtime: number }> = [];

      for await (const candidate of this.iterPaths(target, { includeDirs })) {
        const candidateStat = await safeStat(candidate);
        if (!candidateStat) continue;
        if (candidateStat.isDirectory() && !includeDirs) continue;
        const relPath = path.relative(root, candidate).replaceAll(path.sep, "/") || path.basename(candidate);
        const displayPath = this.displayPath(candidate, root);
        const name = path.basename(candidate);
        if (params.glob && !matchGlob(relPath, name, params.glob)) continue;
        if (candidateStat.isFile() && !matchesType(name, params.type)) continue;
        if (candidateStat.isDirectory() && params.type) continue;
        if (!matchesQuery(displayPath, params.query)) continue;
        matches.push({ display: displayPath + (candidateStat.isDirectory() ? "/" : ""), mtime: candidateStat.mtimeMs });
      }

      matches.sort((a, b) => (sort === "modified" ? b.mtime - a.mtime || a.display.localeCompare(b.display) : a.display.localeCompare(b.display)));
      const [paged, truncated] = paginate(matches.map((item) => item.display), limit, offset);
      if (!paged.length) return "No files found";
      const note = paginationNote(limit, offset, truncated);
      return note ? `${paged.join("\n")}\n\n${note}` : paged.join("\n");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EACCES") return `Error: ${(error as Error).message}`;
      return `Error finding files: ${(error as Error).message}`;
    }
  }
}

export class GrepTool extends SearchTool {
  static override scopes = new Set(["core", "subagent"]);
  static MAX_RESULT_CHARS = 128_000;
  static MAX_FILE_BYTES = 2_000_000;

  static create(ctx: any): Tool {
    const restrict = shouldRestrictToWorkspace(ctx);
    return new GrepTool({
      workspace: ctx?.workspace ?? process.cwd(),
      allowedDir: restrict ? ctx?.workspace : undefined,
      extraAllowedDirs: restrict ? [BUILTIN_SKILLS_DIR] : undefined,
    });
  }

  override get name(): string {
    return "grep";
  }

  override get description(): string {
    return (
      "Search file contents with a regex pattern. " +
      "Default output_mode is files_with_matches (file paths only); use content mode for matching lines with context. " +
      "Prefer this over shell grep for ordinary workspace searches. Skips binary and files >2 MB. Supports glob/type filtering."
    );
  }

  override get parameters() {
    return {
      type: "object",
      properties: {
        pattern: { type: "string", minLength: 1, description: "Regex or plain text pattern to search for" },
        path: { type: "string", description: "File or directory to search in (default '.')" },
        glob: { type: "string", description: "Optional file filter, e.g. '*.ts' or 'tests/**/*.test.ts'" },
        type: { type: "string", description: "Optional file type shorthand, e.g. 'ts', 'md', 'json'" },
        case_insensitive: { type: "boolean", description: "Case-insensitive search (default false)" },
        fixed_strings: { type: "boolean", description: "Treat pattern as plain text instead of regex (default false)" },
        output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "Default: files_with_matches" },
        context_before: { type: "integer", minimum: 0, maximum: 20, description: "Number of lines of context before each match" },
        context_after: { type: "integer", minimum: 0, maximum: 20, description: "Number of lines of context after each match" },
        max_matches: { type: "integer", minimum: 1, maximum: 1000, description: "Legacy alias for head_limit in content mode" },
        max_results: { type: "integer", minimum: 1, maximum: 1000, description: "Legacy alias for head_limit in files_with_matches or count mode" },
        head_limit: { type: "integer", minimum: 0, maximum: 1000, description: "Maximum number of results to return. Default 250" },
        offset: { type: "integer", minimum: 0, maximum: 100000, description: "Skip the first N results before applying head_limit" },
      },
      required: ["pattern"],
    };
  }

  static formatBlock(displayPath: string, lines: string[], matchLine: number, before: number, after: number): string {
    const start = Math.max(1, matchLine - before);
    const end = Math.min(lines.length, matchLine + after);
    const block = [`${displayPath}:${matchLine}`];
    for (let lineNo = start; lineNo <= end; lineNo += 1) {
      const marker = lineNo === matchLine ? ">" : " ";
      block.push(`${marker} ${lineNo}| ${lines[lineNo - 1]}`);
    }
    return block.join("\n");
  }

  async execute(params: {
    pattern?: string;
    path?: string;
    glob?: string;
    type?: string;
    output_mode?: "files_with_matches" | "content" | "count";
    outputMode?: "files_with_matches" | "content" | "count";
    context_before?: number;
    contextBefore?: number;
    context_after?: number;
    contextAfter?: number;
    case_insensitive?: boolean;
    caseInsensitive?: boolean;
    fixed_strings?: boolean;
    fixedStrings?: boolean;
    max_matches?: number;
    maxMatches?: number;
    head_limit?: number | null;
    headLimit?: number | null;
    offset?: number;
    max_results?: number;
    maxResults?: number;
  } = {}): Promise<string> {
    if (!params.pattern) return "Error: missing pattern";
    try {
      const requested = params.path ?? ".";
      const target = this.resolvePath(requested);
      if (!isSearchPathAllowed(target, this.allowedDir, this.extraAllowedDirs)) return `Error: Path outside workspace: ${requested}`;
      const stat = await safeStat(target);
      if (!stat) return `Error: Path not found: ${requested}`;
      if (!stat.isDirectory() && !stat.isFile()) return `Error: Unsupported path: ${requested}`;

      const needle = params.fixed_strings ?? params.fixedStrings ? params.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : params.pattern;
      let regex: RegExp;
      try {
        regex = new RegExp(needle, params.case_insensitive ?? params.caseInsensitive ? "i" : "");
      } catch (error) {
        return `Error: invalid regex pattern: ${(error as Error).message}`;
      }

      const outputMode = params.output_mode ?? params.outputMode ?? "files_with_matches";
      const rawLimit = params.head_limit ?? params.headLimit;
      const limit = rawLimit != null
        ? rawLimit === 0 ? null : rawLimit
        : outputMode === "content" && (params.max_matches ?? params.maxMatches) != null
          ? (params.max_matches ?? params.maxMatches)!
          : outputMode !== "content" && (params.max_results ?? params.maxResults) != null
            ? (params.max_results ?? params.maxResults)!
            : DEFAULT_HEAD_LIMIT;
      const offset = params.offset ?? 0;
      const before = params.context_before ?? params.contextBefore ?? 0;
      const after = params.context_after ?? params.contextAfter ?? 0;
      const root = stat.isDirectory() ? target : path.dirname(target);

      const blocks: string[] = [];
      let resultChars = 0;
      let seenContentMatches = 0;
      let truncated = false;
      let sizeTruncated = false;
      let skippedBinary = 0;
      let skippedLarge = 0;
      const matchingFiles: string[] = [];
      const counts = new Map<string, number>();
      const fileMtimes = new Map<string, number>();

      for await (const filePath of this.iterFiles(target)) {
        const fileStat = await safeStat(filePath);
        if (!fileStat?.isFile()) continue;
        const relPath = path.relative(root, filePath).replaceAll(path.sep, "/") || path.basename(filePath);
        if (params.glob && !matchGlob(relPath, path.basename(filePath), params.glob)) continue;
        if (!matchesType(path.basename(filePath), params.type)) continue;
        if (fileStat.size > GrepTool.MAX_FILE_BYTES) {
          skippedLarge += 1;
          continue;
        }
        const raw = await fs.readFile(filePath).catch(() => null);
        if (!raw || isBinary(raw)) {
          skippedBinary += 1;
          continue;
        }
        let content: string;
        try {
          content = raw.toString("utf8");
        } catch {
          skippedBinary += 1;
          continue;
        }

        const lines = content.split(/\r?\n/);
        const displayPath = this.displayPath(filePath, root);
        let fileHadMatch = false;
        for (const [index, line] of lines.entries()) {
          regex.lastIndex = 0;
          if (!regex.test(line)) continue;
          const lineNo = index + 1;
          fileHadMatch = true;
          if (outputMode === "count") {
            counts.set(displayPath, (counts.get(displayPath) ?? 0) + 1);
            continue;
          }
          if (outputMode === "files_with_matches") {
            if (!matchingFiles.includes(displayPath)) {
              matchingFiles.push(displayPath);
              fileMtimes.set(displayPath, fileStat.mtimeMs);
            }
            break;
          }

          seenContentMatches += 1;
          if (seenContentMatches <= offset) continue;
          if (limit != null && blocks.length >= limit) {
            truncated = true;
            break;
          }
          const block = GrepTool.formatBlock(displayPath, lines, lineNo, before, after);
          const extraSep = blocks.length ? 2 : 0;
          if (resultChars + extraSep + block.length > GrepTool.MAX_RESULT_CHARS) {
            sizeTruncated = true;
            break;
          }
          blocks.push(block);
          resultChars += extraSep + block.length;
        }
        if (outputMode === "count" && fileHadMatch) {
          if (!matchingFiles.includes(displayPath)) {
            matchingFiles.push(displayPath);
            fileMtimes.set(displayPath, fileStat.mtimeMs);
          }
        }
        if ((truncated || sizeTruncated) && outputMode === "content") break;
      }

      let result: string;
      if (outputMode === "files_with_matches") {
        if (!matchingFiles.length) result = `No matches found for pattern '${params.pattern}' in ${requested}`;
        else {
          const ordered = [...matchingFiles].sort((a, b) => (fileMtimes.get(b) ?? 0) - (fileMtimes.get(a) ?? 0) || a.localeCompare(b));
          const [paged, wasTruncated] = paginate(ordered, limit, offset);
          truncated = wasTruncated;
          result = paged.join("\n");
        }
      } else if (outputMode === "count") {
        if (!counts.size) result = `No matches found for pattern '${params.pattern}' in ${requested}`;
        else {
          const orderedFiles = [...matchingFiles].sort((a, b) => (fileMtimes.get(b) ?? 0) - (fileMtimes.get(a) ?? 0) || a.localeCompare(b));
          const [ordered, wasTruncated] = paginate(orderedFiles, limit, offset);
          truncated = wasTruncated;
          result = ordered.map((name) => `${name}: ${counts.get(name) ?? 0}`).join("\n");
        }
      } else {
        result = blocks.length ? blocks.join("\n\n") : `No matches found for pattern '${params.pattern}' in ${requested}`;
      }

      const notes: string[] = [];
      if (outputMode === "content" && truncated) notes.push(`(pagination: limit=${limit}, offset=${offset})`);
      else if (outputMode === "content" && sizeTruncated) notes.push("(output truncated due to size)");
      else if (truncated && ["count", "files_with_matches"].includes(outputMode)) notes.push(`(pagination: limit=${limit}, offset=${offset})`);
      else if (["count", "files_with_matches"].includes(outputMode) && offset > 0) notes.push(`(pagination: offset=${offset})`);
      else if (outputMode === "content" && offset > 0 && blocks.length) notes.push(`(pagination: offset=${offset})`);
      if (skippedBinary) notes.push(`(skipped ${skippedBinary} binary/unreadable files)`);
      if (skippedLarge) notes.push(`(skipped ${skippedLarge} large files)`);
      if (outputMode === "count" && counts.size) {
        const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
        notes.push(`(total matches: ${total} in ${counts.size} files)`);
      }
      return notes.length ? `${result}\n\n${notes.join("\n")}` : result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EACCES") return `Error: ${(error as Error).message}`;
      return `Error searching files: ${(error as Error).message}`;
    }
  }
}
