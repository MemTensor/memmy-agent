import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { lookup } from "mime-types";
import { Tool, type ToolExecutionContext } from "./base.js";
import { FileStates, FileStateStore, currentFileStates } from "./file-state.js";
import { appendFileLintResults, lintFile } from "./file-lint.js";
import { isPathInside, resolveWorkspacePath, workspaceRelative } from "./path-utils.js";
import { extractText } from "../../../utils/document.js";
import { getMediaDir } from "../../../config/paths.js";
import { BUILTIN_SKILLS_DIR } from "../skills.js";
import {
  EXTERNAL_CONTENT_BANNER,
  boundedHeadTail,
  readPersistedToolResultMetadata,
} from "../../../utils/helpers.js";

const IGNORED_DIRS = new Set([".git", "node_modules"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const DOCUMENT_EXTS = new Set([".pdf", ".docx", ".xlsx", ".pptx"]);
const BLOCKED_DEVICE_PATHS = new Set([
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/full",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
  "/dev/console",
  "/dev/fd/0",
  "/dev/fd/1",
  "/dev/fd/2",
]);

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** Same line split as apply_patch: a final newline does not create an extra blank line. */
function splitFileLines(text: string): string[] {
  if (!text) return [];
  const lines = normalizeNewlines(text).split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function lineNumbered(lines: string[], start: number): string {
  const width = String(start + lines.length - 1).length;
  return lines.map((line, index) => `${String(start + index).padStart(width, " ")}| ${line}`).join("\n");
}

function detectLineEnding(buffer: Buffer): string {
  return buffer.includes(Buffer.from("\r\n")) ? "\r\n" : "\n";
}

export function isBlockedDevicePath(filePath: string): boolean {
  const candidates = [filePath];
  try {
    candidates.push(fsSync.realpathSync(filePath));
  } catch {
    // Nonexistent paths are handled later by normal file checks.
  }
  return candidates.some((candidate) => {
    const normalized = candidate.replaceAll(path.sep, "/");
    return (
      BLOCKED_DEVICE_PATHS.has(normalized)
      || /^\/proc\/(?:self|\d+)\/fd\/[012]$/.test(normalized)
      || normalized.startsWith("/dev/")
    );
  });
}

function parsePageRange(pages: string, total: number): [number, number] | null {
  const match = /^(\d+)(?:-(\d+))?$/.exec(pages.trim());
  if (!match) return null;
  const start = Math.max(1, Number(match[1]));
  const end = Math.min(total, Number(match[2] ?? match[1]));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null;
  return [start, end];
}

function filterExtractedPages(text: string, pages?: string | null): string {
  if (!pages) return text;
  const pageBlocks = [...text.matchAll(/--- Page (\d+) ---\n([\s\S]*?)(?=\n+--- Page \d+ ---|$)/g)];
  if (!pageBlocks.length) return text;
  const range = parsePageRange(pages, pageBlocks.length);
  if (!range) return `Error: Invalid page range '${pages}'. Use format like '1-5'.`;
  const [start, end] = range;
  return pageBlocks
    .filter((match) => {
      const page = Number(match[1]);
      return page >= start && page <= end;
    })
    .map((match) => match[0].trimEnd())
    .join("\n\n");
}

interface DocumentReadOptions {
  char_offset?: number;
  char_limit?: number;
}

function paginateDocument(text: string, options: DocumentReadOptions, maxChars: number): string {
  const offset = options.char_offset ?? 0;
  const limit = options.char_limit ?? 32_000;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) {
    return `Error reading document: char_offset must be between 0 and ${text.length}.`;
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return "Error reading document: char_limit must be a positive integer.";
  }
  // Reserve space for the continuation marker inside the runtime's result budget.
  const budget = Math.max(2, maxChars - 512);
  let end = Math.min(text.length, offset + Math.min(limit, budget));
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) {
    // A one-unit request must still make progress over a surrogate pair.
    end += end - offset === 1 ? 1 : -1;
  }
  const status = end < text.length
    ? `More content remains. Continue with char_offset=${end}. Keep the same path and pages; do not treat this excerpt as the full document.`
    : "End of document (selected pages, if any).";
  return `${text.slice(offset, end)}\n\n[Document read: chars ${offset}-${end} of ${text.length} (UTF-16, end exclusive). ${status}]`;
}

async function formatDocumentRead(
  target: string,
  pages?: string | null,
  maxChars = 128_000,
  options: DocumentReadOptions = {},
): Promise<string> {
  const ext = path.extname(target).toLowerCase();
  // Page filtering and continuation must operate on the complete extraction, not its preview.
  const extracted = await extractText(target, { maxChars: null });
  if (extracted == null) return `Error: Unsupported file format: ${ext}`;
  if (extracted.startsWith("[error:")) return `Error reading ${ext.toUpperCase()} file: ${extracted}`;
  const paged = ext === ".pdf" ? filterExtractedPages(extracted, pages) : extracted;
  if (paged.startsWith("Error:")) return paged;
  if (!paged) return `(${ext.toUpperCase().replace(".", "")} has no extractable text: ${target})`;
  return paginateDocument(paged, options, maxChars);
}

function splitLinesKeepEnds(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

function stripLineEnding(line: string): string {
  return line.endsWith("\n") ? line.slice(0, -1) : line;
}

const QUOTE_TABLE: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201c": '"',
  "\u201d": '"',
};

function normalizeQuotes(text: string): string {
  return [...text].map((ch) => QUOTE_TABLE[ch] ?? ch).join("");
}

function curlyDoubleQuotes(text: string): string {
  let opening = true;
  return [...text].map((ch) => {
    if (ch !== '"') return ch;
    const out = opening ? "\u201c" : "\u201d";
    opening = !opening;
    return out;
  }).join("");
}

function curlySingleQuotes(text: string): string {
  const chars = [...text];
  let opening = true;
  return chars.map((ch, index) => {
    if (ch !== "'") return ch;
    const prev = chars[index - 1] ?? "";
    const next = chars[index + 1] ?? "";
    if (/\p{L}|\p{N}/u.test(prev) && /\p{L}|\p{N}/u.test(next)) return "\u2019";
    const out = opening ? "\u2018" : "\u2019";
    opening = !opening;
    return out;
  }).join("");
}

function preserveQuoteStyle(oldText: string, actualText: string, newText: string): string {
  if (normalizeQuotes(oldText.trim()) !== normalizeQuotes(actualText.trim()) || oldText === actualText) return newText;
  let styled = newText;
  if (/[\u201c\u201d]/.test(actualText) && styled.includes('"')) styled = curlyDoubleQuotes(styled);
  if (/[\u2018\u2019]/.test(actualText) && styled.includes("'")) styled = curlySingleQuotes(styled);
  return styled;
}

export function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

function reindentLikeMatch(oldText: string, actualText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const actualLines = actualText.split("\n");
  if (oldLines.length !== actualLines.length) return newText;
  const comparable = oldLines
    .map((oldLine, index) => [oldLine, actualLines[index]] as const)
    .filter(([oldLine, actualLine]) => oldLine.trim() && actualLine.trim());
  if (!comparable.length) return newText;
  if (comparable.some(([oldLine, actualLine]) => normalizeQuotes(oldLine.trim()) !== normalizeQuotes(actualLine.trim()))) return newText;
  const oldWs = leadingWhitespace(comparable[0][0]);
  const actualWs = leadingWhitespace(comparable[0][1]);
  if (actualWs === oldWs) return newText;
  let delta = "";
  if (oldWs) {
    if (!actualWs.startsWith(oldWs)) return newText;
    delta = actualWs.slice(oldWs.length);
  } else {
    delta = actualWs;
  }
  if (!delta) return newText;
  return newText.split("\n").map((line) => (line ? delta + line : line)).join("\n");
}

export class MatchSpan {
  constructor(
    public start: number,
    public end: number,
    public text: string,
    public line: number,
  ) {}
}

function findExactMatches(content: string, oldText: string): MatchSpan[] {
  if (!oldText) return [];
  const matches: MatchSpan[] = [];
  let start = 0;
  while (start <= content.length) {
    const idx = content.indexOf(oldText, start);
    if (idx === -1) break;
    matches.push({
      start: idx,
      end: idx + oldText.length,
      text: content.slice(idx, idx + oldText.length),
      line: content.slice(0, idx).split("\n").length,
    });
    start = idx + Math.max(1, oldText.length);
  }
  return matches;
}

function findTrimMatches(content: string, oldText: string, { normalize = false }: { normalize?: boolean } = {}): MatchSpan[] {
  const oldLines = splitLinesKeepEnds(oldText).map(stripLineEnding);
  if (!oldLines.length) return [];
  const keepends = splitLinesKeepEnds(content);
  const contentLines = keepends.map(stripLineEnding);
  if (contentLines.length < oldLines.length) return [];
  const offsets: number[] = [];
  let pos = 0;
  for (const line of keepends) {
    offsets.push(pos);
    pos += line.length;
  }
  offsets.push(pos);
  const expected = oldLines.map((line) => normalize ? normalizeQuotes(line.trim()) : line.trim());
  const matches: MatchSpan[] = [];
  for (let i = 0; i <= contentLines.length - expected.length; i += 1) {
    const window = contentLines.slice(i, i + expected.length).map((line) => normalize ? normalizeQuotes(line.trim()) : line.trim());
    if (window.join("\n") !== expected.join("\n")) continue;
    let end = offsets[i + expected.length];
    if (keepends[i + expected.length - 1]?.endsWith("\n")) end -= 1;
    matches.push({ start: offsets[i], end, text: content.slice(offsets[i], end), line: i + 1 });
  }
  return matches;
}

function findQuoteMatches(content: string, oldText: string): MatchSpan[] {
  const normalizedContent = normalizeQuotes(content);
  const normalizedOld = normalizeQuotes(oldText);
  if (!normalizedOld) return [];
  const matches: MatchSpan[] = [];
  let start = 0;
  while (start <= normalizedContent.length) {
    const idx = normalizedContent.indexOf(normalizedOld, start);
    if (idx === -1) break;
    matches.push({
      start: idx,
      end: idx + oldText.length,
      text: content.slice(idx, idx + oldText.length),
      line: content.slice(0, idx).split("\n").length,
    });
    start = idx + Math.max(1, normalizedOld.length);
  }
  return matches;
}

function findMatches(content: string, oldText: string): MatchSpan[] {
  return allMatches(content, oldText);
}

function allMatches(content: string, oldText: string): MatchSpan[] {
  for (const matches of [
    findExactMatches(content, oldText),
    findTrimMatches(content, oldText),
    findTrimMatches(content, oldText, { normalize: true }),
    findQuoteMatches(content, oldText),
  ]) {
    if (matches.length) return matches;
  }
  return [];
}

function collapseInternalWhitespace(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim().split(/\s+/).filter(Boolean).join(" ")).join("\n");
}

function diagnoseNearMatch(oldText: string, actualText: string): string[] {
  const hints: string[] = [];
  if (oldText.toLowerCase() === actualText.toLowerCase() && oldText !== actualText) hints.push("letter case differs");
  if (collapseInternalWhitespace(oldText) === collapseInternalWhitespace(actualText) && oldText !== actualText) hints.push("whitespace differs");
  if (oldText.replace(/\n+$/, "") === actualText.replace(/\n+$/, "") && oldText !== actualText) hints.push("trailing newline differs");
  if (normalizeQuotes(oldText) === normalizeQuotes(actualText) && oldText !== actualText) hints.push("quote style differs");
  return hints;
}

function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length && !b.length) return 1;
  const prev = [...Array(b.length + 1).keys()];
  const curr = Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length, 1);
}

function bestWindow(oldText: string, content: string): { ratio: number; start: number; lines: string[]; hints: string[] } {
  const lines = splitLinesKeepEnds(content);
  const oldLines = splitLinesKeepEnds(oldText);
  const window = Math.max(1, oldLines.length);
  let best = { ratio: -1, start: 0, lines: [] as string[], hints: [] as string[] };
  const count = Math.max(1, lines.length - window + 1);
  for (let i = 0; i < count; i += 1) {
    const current = lines.slice(i, i + window);
    const ratio = levenshteinRatio(oldLines.join(""), current.join(""));
    if (ratio > best.ratio) {
      const actual = current.join("").replace(/\r\n/g, "\n").replace(/\n+$/, "");
      best = {
        ratio,
        start: i,
        lines: current,
        hints: diagnoseNearMatch(oldText.replace(/\r\n/g, "\n").replace(/\n+$/, ""), actual),
      };
    }
  }
  return best;
}

export function stripTrailingWhitespace(text: string): string {
  return text.split("\n").map((line) => line.trimEnd()).join("\n");
}

export function fileNotFoundMessage(requested: string, target: string): string {
  const parent = path.dirname(target);
  const name = path.basename(target);
  const suggestions: string[] = [];
  try {
    for (const entry of fsSync.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (levenshteinRatio(name, entry.name) >= 0.6) suggestions.push(path.join(parent, entry.name));
    }
  } catch {
    // Keep the base error if the parent directory cannot be inspected.
  }
  return suggestions.length
    ? `Error editing file: File not found: ${requested}\nDid you mean: ${suggestions.slice(0, 3).join(", ")}?`
    : `Error editing file: File not found: ${requested}`;
}

function unifiedDiffSnippet(oldText: string, actualLines: string[], requested: string, startLine: number): string {
  return [
    "--- old_text (provided)",
    `+++ ${requested} (actual, line ${startLine})`,
    ...oldText.split("\n").map((line) => `-${line}`),
    ...actualLines.join("").replace(/\n$/, "").split("\n").map((line) => `+${line}`),
  ].join("\n");
}

export function notFoundMessage(oldText: string, content: string, requested: string): string {
  const best = bestWindow(oldText, content);
  if (best.ratio > 0.5) {
    const hint = best.hints.length ? `\nPossible cause: ${best.hints.join(", ")}.` : "";
    return [
      `Error: old_text not found in ${requested}.`,
      `${hint}\nBest match (${Math.round(best.ratio * 100)}% similar) at line ${best.start + 1}:`,
      unifiedDiffSnippet(oldText, best.lines, requested, best.start + 1),
    ].join("");
  }
  if (best.hints.length) {
    return `Error: old_text not found in ${requested}. Possible cause: ${best.hints.join(", ")}. Copy the exact text from read_file and try again.`;
  }
  return `Error: old_text not found in ${requested}. No similar text found. Verify the file content.`;
}

type FileStateOwner = FileStates | FileStateStore | null | undefined;

type FsToolInit = {
  workspace?: string;
  allowedDir?: string;
  extraAllowedDirs?: string[];
  fileStates?: FileStates;
  fileStateStore?: FileStateStore;
  postWriteValidation?: boolean;
};

function shouldRestrictToWorkspace(ctx: any): boolean {
  return Boolean(ctx?.config?.restrictToWorkspace || ctx?.config?.exec?.sandbox);
}

function resolveExtraAllowedDirs(dirs?: string[] | null): string[] {
  return (dirs ?? []).map((dir) => path.resolve(dir));
}

function readonlyExtraAllowedDirs(ctx: any, restrict: boolean): string[] | undefined {
  if (!restrict) return undefined;
  if (Array.isArray(ctx?.readonlySkillRoots)) return [...ctx.readonlySkillRoots];
  return [BUILTIN_SKILLS_DIR];
}

function writableExtraAllowedDirs(ctx: any, restrict: boolean): string[] | undefined {
  if (!restrict) return undefined;
  if (Array.isArray(ctx?.readonlySkillRoots)) return [];
  return [BUILTIN_SKILLS_DIR];
}

function isToolPathAllowed(target: string, allowedDir: string | null, extraAllowedDirs: string[] = []): boolean {
  return (
    !allowedDir
    || isPathInside(target, allowedDir)
    || isPathInside(target, getMediaDir())
    || extraAllowedDirs.some((dir) => isPathInside(target, dir))
  );
}

function stateOwner(init: FsToolInit): FileStateOwner {
  return init.fileStateStore ?? init.fileStates ?? null;
}

function contextSessionKey(ctx: any): string | null {
  return ctx?.sessionKey ?? null;
}

function resolveFileStates(owner: FileStateOwner, fallback: FileStates, ctx: any): FileStates {
  if (owner instanceof FileStateStore) return owner.forSession(contextSessionKey(ctx));
  if (owner instanceof FileStates) return owner;
  return currentFileStates(fallback);
}

function createToolAbortError(): Error {
  const error = new Error("task cancelled");
  error.name = "AbortError";
  return error;
}

function isToolAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw createToolAbortError();
}

async function readBackWrittenFile(
  target: string,
  expected: string,
  signal?: AbortSignal | null,
): Promise<string> {
  throwIfAborted(signal);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error(`Write verification failed: ${target} is not a regular file`);
  throwIfAborted(signal);
  const content = await fs.readFile(target, { encoding: "utf8", signal: signal ?? undefined });
  if (content !== expected) throw new Error(`Write verification failed: content mismatch for ${target}`);
  return content;
}

export class FsTool extends Tool {
  workspace: string;
  allowedDir: string | null;
  explicitAllowedDir: string | null;
  extraAllowedDirs: string[];
  fileStateOwner: FileStateOwner;
  fallbackFileStates = new FileStates();
  requestContext: any = null;

  constructor(init: FsToolInit = {}) {
    super();
    const { workspace = process.cwd(), allowedDir } = init;
    this.workspace = path.resolve(String(workspace));
    this.allowedDir = allowedDir ? path.resolve(allowedDir) : null;
    this.explicitAllowedDir = allowedDir ? path.resolve(allowedDir) : null;
    this.extraAllowedDirs = resolveExtraAllowedDirs(init.extraAllowedDirs);
    this.fileStateOwner = stateOwner(init);
  }

  static create(ctx: any): Tool {
    const restrict = shouldRestrictToWorkspace(ctx);
    return new this({
      workspace: ctx?.workspace ?? process.cwd(),
      allowedDir: restrict ? ctx?.workspace : undefined,
      extraAllowedDirs: readonlyExtraAllowedDirs(ctx, restrict),
      fileStateStore: ctx?.fileStateStore,
    });
  }

  get name(): string {
    return "fs";
  }

  get description(): string {
    return "Filesystem helper base";
  }

  get parameters() {
    return { type: "object", properties: {} };
  }

  async execute(): Promise<string> {
    return "Error: base filesystem tool cannot be executed directly";
  }

  fileStates(): FileStates {
    return resolveFileStates(this.fileStateOwner, this.fallbackFileStates, this.requestContext);
  }

  setContext(ctx: any): void {
    this.requestContext = ctx;
  }

  resolve(requested: string): string {
    const target = resolveWorkspacePath(this.workspace, requested);
    if (!isToolPathAllowed(target, this.allowedDir, this.extraAllowedDirs)) throw new Error(`path outside workspace: ${requested}`);
    return target;
  }
}

export function findMatch(content: string, oldText: string): [string | null, number] {
  if (oldText === "") return ["", 1];
  const matches = allMatches(content, oldText);
  return [matches[0]?.text ?? null, matches.length];
}

export class ReadFileTool extends Tool {
  static scopes = new Set(["core", "subagent", "memory"]);
  static MAX_CHARS = 128_000;
  workspace: string;
  allowedDir: string | null;
  extraAllowedDirs: string[];
  fileStateOwner: FileStateOwner;
  fallbackFileStates = new FileStates();
  requestContext: any = null;

  constructor(init: FsToolInit = {}) {
    super();
    const { workspace = process.cwd(), allowedDir } = init;
    this.workspace = path.resolve(String(workspace));
    this.allowedDir = allowedDir ? path.resolve(allowedDir) : null;
    this.extraAllowedDirs = resolveExtraAllowedDirs(init.extraAllowedDirs);
    this.fileStateOwner = stateOwner(init);
  }

  static create(ctx: any): Tool {
    const restrict = shouldRestrictToWorkspace(ctx);
    return new ReadFileTool({
      workspace: ctx?.workspace ?? process.cwd(),
      allowedDir: restrict ? ctx?.workspace : undefined,
      extraAllowedDirs: readonlyExtraAllowedDirs(ctx, restrict),
      fileStateStore: ctx?.fileStateStore,
    });
  }

  get name(): string {
    return "read_file";
  }

  get description(): string {
    return (
      "Read a file (text, image, or document). Text output format: LINE_NUM|CONTENT. " +
      "Images return visual content for analysis. Supports PDF, DOCX, XLSX, PPTX documents. " +
      "Use find_files/list_dir first when the path is uncertain. " +
      "Read the relevant range before editing so replacements or patches are based on current content. " +
      "Use offset and limit for text file lines, or char_offset/char_limit for oversized single lines. For documents use pages for PDF page ranges, " +
      "and char_offset/char_limit to read extracted text in chunks (also within a large PDF page). " +
      "Follow the returned char_offset with the same path/pages until the required content is read; " +
      "an excerpt is not the full document. Use force=true to re-read text even if unchanged."
    );
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1 },
        pages: { type: "string", description: "PDF page or inclusive page range, e.g. 15 or 15-20." },
        char_offset: { type: "integer", minimum: 0, description: "Text files and documents: zero-based UTF-16 offset (after PDF page selection). Use the returned continuation offset." },
        char_limit: { type: "integer", minimum: 1, description: "Text files and documents: requested raw chunk size in UTF-16 units (default 32000; capped to the output budget)." },
        force: { type: "boolean" },
      },
      required: ["path"],
    };
  }

  get readOnly(): boolean {
    return true;
  }

  setContext(ctx: any): void {
    this.requestContext = ctx;
  }

  fileStates(): FileStates {
    return resolveFileStates(this.fileStateOwner, this.fallbackFileStates, this.requestContext);
  }

  async execute(params: { path?: string; offset?: number; limit?: number; pages?: string; force?: boolean } & DocumentReadOptions = {}, context?: ToolExecutionContext): Promise<any> {
    const requested = params.path;
    if (!requested) return "Error reading file: Unknown path";
    if (isBlockedDevicePath(requested)) {
      return `Error: Reading ${requested} is blocked (device path that could hang or produce infinite output).`;
    }
    const target = resolveWorkspacePath(this.workspace, requested);
    if (isBlockedDevicePath(target)) {
      return `Error: Reading ${target} is blocked (device path that could hang or produce infinite output).`;
    }
    if (!isToolPathAllowed(target, this.allowedDir, this.extraAllowedDirs)) {
      return `Error reading file: path outside workspace: ${requested}`;
    }
    try {
      const stat = await fs.stat(target);
      if (!stat.isFile()) return `Error reading file: not a file: ${requested}`;
      const ext = path.extname(target).toLowerCase();
      if (ext === ".pdf") return await this.readPdfFile(target, params.pages ?? null, params);
      if (DOCUMENT_EXTS.has(ext)) return await this.readOfficeDocument(target, params);
      if (IMAGE_EXTS.has(ext)) {
        const data = await fs.readFile(target);
        const mime = lookup(target) || "image/png";
        return [
          {
            type: "image_url",
            image_url: { url: `data:${mime};base64,${data.toString("base64")}` },
            meta: { path: target },
          },
        ];
      }
      const content = await fs.readFile(target, "utf8");
      if (!content) return "Empty file";
      const metadata = readPersistedToolResultMetadata(target);
      const provenance = metadata?.untrusted
        ? `${EXTERNAL_CONTENT_BANNER}\nSource tool: ${metadata.sourceTool ?? "external"}\n\n` : "";
      const budget = Math.max(1, Math.min(ReadFileTool.MAX_CHARS, context?.maxResultChars ?? ReadFileTool.MAX_CHARS));
      if (params.char_offset !== undefined || params.char_limit !== undefined) {
        const offset = params.char_offset ?? 0;
        const limit = params.char_limit ?? 32000;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > content.length || !Number.isSafeInteger(limit) || limit < 1)
          return "Error reading file: char_offset/char_limit must be valid UTF-16 character positions and a positive limit.";
        const budgetError = () => "Error: read_file budget too small; increase the result budget.".slice(0, budget);
        if (offset > 0 && /[\uDC00-\uDFFF]/.test(content[offset]!) && /[\uD800-\uDBFF]/.test(content[offset - 1]!))
          return "Error: char_offset splits a UTF-16 surrogate pair; use the returned continuation offset.".slice(0, budget);
        const footerFor = (end: number) => `\n[Raw fragment chars ${offset}-${end} of ${content.length}; not standalone JSON. ${end < content.length ? `Continue with char_offset=${end}.` : "End of file"}]`;
        // Reserve the actual footer size. A fixed reservation can prevent every read
        // from advancing when the model has a small per-tool result budget.
        const requestedSize = limit === 1 && /[\uD800-\uDBFF]/.test(content[offset]!) && /[\uDC00-\uDFFF]/.test(content[offset + 1]!) ? 2 : limit;
        let end = Math.min(content.length, offset + Math.min(requestedSize, Math.max(0, budget - provenance.length)));
        while (provenance.length + end - offset + footerFor(end).length > budget && end > offset) {
          end = Math.max(offset, end - (provenance.length + end - offset + footerFor(end).length - budget));
        }
        if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]!) && /[\uDC00-\uDFFF]/.test(content[end]!)) end -= 1;
        if (end === offset && offset < content.length) return budgetError();
        if (provenance.length + footerFor(end).length > budget) return budgetError();
        return provenance + content.slice(offset, end) + footerFor(end);
      }
      const lines = splitFileLines(content);
      const offset = params.offset ?? 1;
      if (offset > lines.length) return `Error reading file: offset ${offset} beyond end (${lines.length} lines)`;
      const limit = params.limit ?? null;
      if (!params.force && this.fileStates().isUnchanged(target, offset, limit)) {
        return `[File unchanged since last read: ${workspaceRelative(this.workspace, target).replaceAll(path.sep, "/")}]`;
      }
      let selected = lines.slice(offset - 1, params.limit ? offset - 1 + params.limit : undefined);
      let body = lineNumbered(selected, offset);
      let nextOffset = offset + selected.length;
      while (body.length > Math.max(0, budget - provenance.length - 300) && selected.length > 1) {
        selected = selected.slice(0, Math.max(1, Math.floor(selected.length * 0.8)));
        body = lineNumbered(selected, offset);
        nextOffset = offset + selected.length;
      }
      const footer =
        nextOffset <= lines.length
          ? `\n\nUse offset=${nextOffset} to continue.`
          : "\n\nEnd of file";
      this.fileStates().recordRead(target, offset, limit);
      if (provenance.length + body.length + footer.length > budget) {
        const hint = `${provenance}Long line: use read_file char_offset/char_limit for raw fragments. ${context?.availableTools?.includes("exec") ? "Use exec with an integer-safe parser for specific fields/records; narrow oversized queries." : "Fragments are not standalone JSON; do not infer missing fields."}\n`;
        return hint.slice(0, budget) + boundedHeadTail(body, Math.max(0, Math.min(4000, budget) - hint.length));
      }
      return provenance + body + footer;
    } catch (error) {
      const msg = (error as NodeJS.ErrnoException).code === "ENOENT" ? "not found" : (error as Error).message;
      return `Error reading file: ${msg}`;
    }
  }

  readPdfFile(target: string, pages?: string | null, options: DocumentReadOptions = {}): Promise<string> {
    return formatDocumentRead(target, pages, ReadFileTool.MAX_CHARS, options);
  }

  readOfficeDocument(target: string, options: DocumentReadOptions = {}): Promise<string> {
    return formatDocumentRead(target, null, ReadFileTool.MAX_CHARS, options);
  }
}

export class WriteFileTool extends Tool {
  static scopes = new Set(["core", "subagent", "memory"]);
  workspace: string;
  allowedDir: string | null;
  extraAllowedDirs: string[];
  fileStateOwner: FileStateOwner;
  fallbackFileStates = new FileStates();
  requestContext: any = null;
  postWriteValidation: boolean;

  constructor(init: FsToolInit = {}) {
    super();
    const { workspace = process.cwd(), allowedDir } = init;
    this.workspace = path.resolve(String(workspace));
    this.allowedDir = allowedDir ? path.resolve(allowedDir) : null;
    this.extraAllowedDirs = resolveExtraAllowedDirs(init.extraAllowedDirs);
    this.fileStateOwner = stateOwner(init);
    this.postWriteValidation = init.postWriteValidation ?? true;
  }

  static create(ctx: any): Tool {
    const restrict = shouldRestrictToWorkspace(ctx);
    return new WriteFileTool({
      workspace: ctx?.workspace ?? process.cwd(),
      allowedDir: restrict ? ctx?.workspace : undefined,
      extraAllowedDirs: writableExtraAllowedDirs(ctx, restrict),
      fileStateStore: ctx?.fileStateStore,
    });
  }

  get name(): string {
    return "write_file";
  }

  get description(): string {
    return (
      "Create a new file or intentionally replace an entire file with the provided content. " +
      "Overwrites existing files and creates parent directories as needed. " +
      "For code changes or partial edits, prefer apply_patch; use edit_file only for small exact replacements."
    );
  }

  get parameters() {
    return {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    };
  }

  setContext(ctx: any): void {
    this.requestContext = ctx;
  }

  fileStates(): FileStates {
    return resolveFileStates(this.fileStateOwner, this.fallbackFileStates, this.requestContext);
  }

  async execute(params: { path?: string; content?: string } = {}, context?: ToolExecutionContext): Promise<string> {
    if (!params.path) return "Error writing file: Unknown path";
    if (params.content == null) return "Error writing file: Unknown content";
    const target = resolveWorkspacePath(this.workspace, params.path);
    if (!isToolPathAllowed(target, this.allowedDir, this.extraAllowedDirs)) return `Error writing file: path outside workspace: ${params.path}`;
    const signal = context?.abortSignal ?? null;
    let writeStarted = false;
    try {
      throwIfAborted(signal);
      const finalBytes = Buffer.from(params.content, "utf8");
      try {
        const stat = await fs.stat(target);
        if (stat.isFile()) {
          const beforeBytes = await fs.readFile(target, { signal: signal ?? undefined });
          throwIfAborted(signal);
          if (beforeBytes.equals(finalBytes)) {
            context?.reportFileMutation?.({ path: target, changed: false });
            return `No changes made to ${target}: existing content is identical.`;
          }
        }
      } catch (error) {
        if (isToolAbortError(error)) throw error;
        // Preserve the existing write/error boundary when the target cannot be inspected.
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      throwIfAborted(signal);
      writeStarted = true;
      await fs.writeFile(target, params.content, { encoding: "utf8", signal: signal ?? undefined });
      this.fileStates().recordWrite(target);
      if (!this.postWriteValidation) return `Successfully wrote ${target}`;
      const content = await readBackWrittenFile(target, params.content, signal);
      const lint = await lintFile({ path: target, content }, { abortSignal: signal });
      return appendFileLintResults(`Successfully wrote ${target}`, [lint]);
    } catch (error) {
      if (isToolAbortError(error)) {
        if (writeStarted && fsSync.existsSync(target)) this.fileStates().recordWrite(target);
        throw error;
      }
      throw error;
    }
  }
}

const EDIT_FILE_ALIASES = [
  ["old_text", "oldText"],
  ["new_text", "newText"],
  ["replace_all", "replaceAll"],
  ["line_hint", "lineHint"],
  ["expected_replacements", "expectedReplacements"],
] as const;

/** Normalize legacy inputs while rejecting ambiguous values before file access. */
function normalizeEditAliases(params: Record<string, any>): { params: Record<string, any>; error: string | null } {
  const normalized = { ...params };
  for (const [canonical, alias] of EDIT_FILE_ALIASES) {
    const value = params[canonical];
    const legacy = params[alias];
    // Nullish values are unset for compatibility; empty text and false are explicit values.
    if (value != null && legacy != null && value !== legacy) {
      return { params, error: `Conflicting parameters: ${canonical} and ${alias} must have the same value when both are provided.` };
    }
    if (value == null && legacy !== undefined) normalized[canonical] = legacy;
    if (normalized[canonical] === undefined) delete normalized[canonical];
    delete normalized[alias];
  }
  return { params: normalized, error: null };
}

interface EditFileParams {
  path?: string;
  old_text?: string;
  oldText?: string;
  new_text?: string;
  newText?: string;
  replace_all?: boolean;
  replaceAll?: boolean;
  occurrence?: number | null;
  line_hint?: number | null;
  lineHint?: number | null;
  expected_replacements?: number | null;
  expectedReplacements?: number | null;
}

function resolveEditParams(params: EditFileParams) {
  return {
    oldText: params.old_text,
    newText: params.new_text,
    replaceAll: params.replace_all ?? false,
    occurrence: params.occurrence ?? null,
    lineHint: params.line_hint ?? null,
    expectedReplacements: params.expected_replacements ?? null,
  };
}

/** Pure validation shared by registry preparation and direct execution, before any file access. */
function editOptionsError(options: ReturnType<typeof resolveEditParams>): string | null {
  const { oldText, replaceAll, occurrence, lineHint, expectedReplacements } = options;
  for (const [name, value] of [
    ["occurrence", occurrence], ["line_hint", lineHint], ["expected_replacements", expectedReplacements],
  ] as const) {
    if (value != null && value < 1) return `${name} must be >= 1.`;
    if (value != null && !Number.isInteger(value)) return `${name} must be a positive integer.`;
  }
  if (replaceAll && occurrence != null) return "occurrence cannot be used with replace_all=true.";
  if (replaceAll && lineHint != null) return "line_hint cannot be used with replace_all=true.";
  if (occurrence != null && lineHint != null) return "line_hint cannot be used with occurrence.";
  if (oldText === "") {
    if (replaceAll || occurrence != null || lineHint != null) {
      return "old_text is empty (create mode); omit occurrence and line_hint, and leave replace_all false.";
    }
    if (expectedReplacements != null && expectedReplacements !== 1) {
      return `expected ${expectedReplacements} replacements but would make 1 (create mode).`;
    }
  }
  return null;
}

export class EditFileTool extends Tool {
  static scopes = new Set(["core", "subagent", "memory"]);
  static MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024;
  static MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);
  workspace: string;
  allowedDir: string | null;
  extraAllowedDirs: string[];
  fileStateOwner: FileStateOwner;
  fallbackFileStates = new FileStates();
  requestContext: any = null;
  postWriteValidation: boolean;

  constructor(init: FsToolInit = {}) {
    super();
    const { workspace = process.cwd(), allowedDir } = init;
    this.workspace = path.resolve(String(workspace));
    this.allowedDir = allowedDir ? path.resolve(allowedDir) : null;
    this.extraAllowedDirs = resolveExtraAllowedDirs(init.extraAllowedDirs);
    this.fileStateOwner = stateOwner(init);
    this.postWriteValidation = init.postWriteValidation ?? true;
  }

  static create(ctx: any): Tool {
    const restrict = shouldRestrictToWorkspace(ctx);
    return new EditFileTool({
      workspace: ctx?.workspace ?? process.cwd(),
      allowedDir: restrict ? ctx?.workspace : undefined,
      extraAllowedDirs: writableExtraAllowedDirs(ctx, restrict),
      fileStateStore: ctx?.fileStateStore,
    });
  }

  get name(): string {
    return "edit_file";
  }

  get description(): string {
    return (
      "Perform a small, exact replacement in one file by replacing old_text with new_text. " +
      "Use this for narrow text substitutions with old_text copied from read_file. " +
      "Choose at most one selector: occurrence, line_hint, or replace_all=true; they are mutually exclusive. " +
      "With no selector, old_text must match exactly once. expected_replacements is an independent count assertion. " +
      "Empty old_text creates a missing file or fills an empty/whitespace-only file; omit selectors in this mode. " +
      "For multi-file, structural, or generated code edits, prefer apply_patch."
    );
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to the workspace." },
        old_text: { type: "string", description: "Required text to replace, copied from read_file. Empty string selects create mode: create a missing file or fill an empty/whitespace-only file, without selectors." },
        new_text: { type: "string", description: "Required replacement text; empty string deletes the selected text." },
        replace_all: { type: "boolean", description: "Replace every match when true; defaults to false. When true, cannot be combined with non-null occurrence or line_hint, or used in create mode. When false, may be combined with occurrence or line_hint, or used in create mode." },
        occurrence: { type: ["integer", "null"], minimum: 1, description: "Select the 1-based occurrence of old_text in file order. Omit or use null when unused. Cannot be combined with line_hint or replace_all=true, or used in create mode." },
        line_hint: { type: ["integer", "null"], minimum: 1, description: "Select the match whose start is nearest this 1-based line number; equal-distance ties fail. Omit or use null when unused. Cannot be combined with occurrence or replace_all=true, or used in create mode." },
        expected_replacements: { type: ["integer", "null"], minimum: 1, description: "Independent assertion of the number of selected replacements, checked before writing. Works with every selection mode; does not select a match. Omit or use null to skip; create mode accepts only 1 when supplied, including a no-op." },
      },
      required: ["path", "old_text", "new_text"],
    };
  }

  castParams(params: Record<string, any>): Record<string, any> {
    const cast = super.castParams(params);
    if (!cast || typeof cast !== "object" || Array.isArray(cast)) return cast;
    for (const [canonical, alias] of EDIT_FILE_ALIASES) {
      if (alias in cast) {
        cast[alias] = super.castParams({ [canonical]: cast[alias] })[canonical];
      }
    }
    // On conflict, preserve both cast values so validateParams can report the error.
    return normalizeEditAliases(cast).params;
  }

  validateParams(params: Record<string, any>): string[] {
    if (!params || typeof params !== "object" || Array.isArray(params)) return super.validateParams(params);
    const normalized = normalizeEditAliases(params);
    if (normalized.error) return [normalized.error];
    const errors = super.validateParams(normalized.params);
    if (errors.length) return errors;
    const error = editOptionsError(resolveEditParams(normalized.params as EditFileParams));
    return error ? [error] : [];
  }

  setContext(ctx: any): void {
    this.requestContext = ctx;
  }

  fileStates(): FileStates {
    return resolveFileStates(this.fileStateOwner, this.fallbackFileStates, this.requestContext);
  }

  async execute(params: EditFileParams = {}, context?: ToolExecutionContext): Promise<string> {
    params = this.castParams(params) as EditFileParams;
    if (!params || typeof params !== "object" || Array.isArray(params)) return "Error editing file: parameters must be an object.";
    const normalized = normalizeEditAliases(params);
    if (normalized.error) return `Error: ${normalized.error}`;
    params = normalized.params as EditFileParams;
    if (!params.path) return "Error editing file: Unknown path";
    const { oldText, newText, replaceAll, occurrence, lineHint, expectedReplacements } = resolveEditParams(params);
    if (oldText == null) return "Error editing file: Unknown old_text";
    if (newText == null) return "Error editing file: Unknown new_text";
    const parameterErrors = this.validateParams(params);
    if (parameterErrors.length) return `Error: ${parameterErrors.join("; ")}`;
    const target = resolveWorkspacePath(this.workspace, params.path);
    if (!isToolPathAllowed(target, this.allowedDir, this.extraAllowedDirs)) return `Error editing file: path outside workspace: ${params.path}`;
    const signal = context?.abortSignal ?? null;
    let writeStarted = false;
    try {
      throwIfAborted(signal);
      if (!fsSync.existsSync(target) && oldText !== "") return fileNotFoundMessage(params.path, target);
      if (oldText === "") {
        const exists = fsSync.existsSync(target);
        if (exists) {
          throwIfAborted(signal);
          const existingBytes = await fs.readFile(target, { signal: signal ?? undefined });
          const existing = existingBytes.toString("utf8");
          if (existing.trim()) return `Error editing file: cannot create file; ${params.path} already exists and is not empty.`;
          throwIfAborted(signal);
          if (existingBytes.equals(Buffer.from(newText, "utf8"))) {
            context?.reportFileMutation?.({ path: target, changed: false });
            return `No changes made to ${target}: replacement produced identical content.`;
          }
        }
        throwIfAborted(signal);
        await fs.mkdir(path.dirname(target), { recursive: true });
        throwIfAborted(signal);
        writeStarted = true;
        await fs.writeFile(target, newText, { encoding: "utf8", signal: signal ?? undefined });
        this.fileStates().recordWrite(target);
        const success = exists ? "Successfully edited file" : `Successfully created ${target}`;
        if (!this.postWriteValidation) return success;
        const content = await readBackWrittenFile(target, newText, signal);
        const lint = await lintFile({ path: target, content }, { abortSignal: signal });
        return appendFileLintResults(success, [lint]);
      }
      const stat = fsSync.statSync(target);
      if (stat.size > EditFileTool.MAX_EDIT_FILE_SIZE) {
        return `Error: File too large to edit (${(stat.size / (1024 ** 3)).toFixed(1)} GiB). Maximum is 1 GiB.`;
      }
      const warning = this.fileStates().checkRead(target);
      throwIfAborted(signal);
      const raw = await fs.readFile(target, { signal: signal ?? undefined });
      const lineEnding = detectLineEnding(raw);
      const normalized = normalizeNewlines(raw.toString("utf8"));
      const normalizedOld = normalizeNewlines(oldText);
      throwIfAborted(signal);
      const matches = findMatches(normalized, normalizedOld);
      throwIfAborted(signal);
      if (!matches.length) return notFoundMessage(normalizedOld, normalized, params.path);
      const count = matches.length;
      if (count > 1 && !replaceAll) {
        if (occurrence != null) {
          if (occurrence > count) return `Error: occurrence ${occurrence} is out of range; old_text appears ${count} times.`;
        } else if (lineHint != null) {
          const nearestDistance = Math.min(...matches.map((match) => Math.abs(match.line - lineHint)));
          if (matches.filter((match) => Math.abs(match.line - lineHint) === nearestDistance).length > 1) {
            return `Error: line_hint ${lineHint} is ambiguous; old_text appears ${count} times.`;
          }
        } else {
          const preview = matches.slice(0, 3).map((match) => `line ${match.line}`).join(", ");
          const suffix = matches.length > 3 ? ", ..." : "";
          return `Warning: old_text appears ${count} times at ${preview}${suffix}. Provide more context, set occurrence to choose one match, or set replace_all=true.`;
        }
      } else if (occurrence != null && occurrence > count) {
        return `Error: occurrence ${occurrence} is out of range; old_text appears ${count} time.`;
      }
      let normalizedNew = normalizeNewlines(newText);
      if (!EditFileTool.MARKDOWN_EXTENSIONS.has(path.extname(target).toLowerCase())) {
        normalizedNew = stripTrailingWhitespace(normalizedNew);
      }
      const selected = replaceAll
        ? matches
        : lineHint != null
          ? [matches.toSorted((a, b) => Math.abs(a.line - lineHint) - Math.abs(b.line - lineHint))[0]]
          : [matches[(occurrence ?? 1) - 1]];
      if (expectedReplacements != null && selected.length !== expectedReplacements) {
        return `Error: expected ${expectedReplacements} replacements but would make ${selected.length}.`;
      }
      let updated = normalized;
      for (const match of [...selected].sort((a, b) => b.start - a.start)) {
        throwIfAborted(signal);
        let replacement = preserveQuoteStyle(normalizedOld, match.text, normalizedNew);
        replacement = reindentLikeMatch(normalizedOld, match.text, replacement);
        let end = match.end;
        if (replacement === "" && !match.text.endsWith("\n") && normalized[end] === "\n") end += 1;
        updated = updated.slice(0, match.start) + replacement + updated.slice(end);
      }
      updated = updated.replace(/\n/g, lineEnding);
      throwIfAborted(signal);
      if (raw.equals(Buffer.from(updated, "utf8"))) {
        context?.reportFileMutation?.({ path: target, changed: false });
        const noChange = `No changes made to ${target}: replacement produced identical content.`;
        return warning ? `${warning}\n${noChange}` : noChange;
      }
      writeStarted = true;
      await fs.writeFile(target, updated, { encoding: "utf8", signal: signal ?? undefined });
      this.fileStates().recordWrite(target);
      const success = warning ? `${warning}\nSuccessfully edited file` : "Successfully edited file";
      if (!this.postWriteValidation) return success;
      const content = await readBackWrittenFile(target, updated, signal);
      const lint = await lintFile({
        path: target,
        content,
        previousContent: raw.toString("utf8"),
        useDelta: true,
      }, { abortSignal: signal });
      return appendFileLintResults(success, [lint]);
    } catch (error) {
      if (isToolAbortError(error)) {
        if (writeStarted && fsSync.existsSync(target)) this.fileStates().recordWrite(target);
        throw error;
      }
      return `Error editing file: ${(error as Error).message}`;
    }
  }
}

export class ListDirTool extends Tool {
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

  static create(ctx: any): Tool {
    const restrict = shouldRestrictToWorkspace(ctx);
    return new ListDirTool({
      workspace: ctx?.workspace ?? process.cwd(),
      allowedDir: restrict ? ctx?.workspace : undefined,
      extraAllowedDirs: readonlyExtraAllowedDirs(ctx, restrict),
    });
  }

  get name(): string {
    return "list_dir";
  }

  get description(): string {
    return "List files in a directory.";
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" },
        max_entries: { type: "integer" },
        maxEntries: { type: "integer" },
      },
    };
  }

  get readOnly(): boolean {
    return true;
  }

  async execute(params: { path?: string; recursive?: boolean; max_entries?: number; maxEntries?: number } = {}): Promise<string> {
    if (!params.path) return "Error listing directory: Unknown path";
    const target = resolveWorkspacePath(this.workspace, params.path);
    if (!isToolPathAllowed(target, this.allowedDir, this.extraAllowedDirs)) return `Error: path outside workspace: ${params.path}`;
    const maxEntries = params.max_entries ?? params.maxEntries ?? 200;
    const rows: string[] = [];
    const walk = async (dir: string) => {
      const entries = (await fs.readdir(dir, { withFileTypes: true }))
        .filter((entry) => !IGNORED_DIRS.has(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = workspaceRelative(this.workspace, full).replaceAll(path.sep, "/") + (entry.isDirectory() ? "/" : "");
        rows.push(rel);
        if (params.recursive && entry.isDirectory()) await walk(full);
      }
    };
    if (!fsSync.existsSync(target)) return `Error: path not found: ${params.path}`;
    await walk(target);
    if (!rows.length) return "(empty directory)";
    const selected = rows.slice(0, maxEntries);
    if (rows.length > maxEntries) selected.push(`... truncated (${maxEntries} of ${rows.length} entries)`);
    return selected.join("\n");
  }
}
