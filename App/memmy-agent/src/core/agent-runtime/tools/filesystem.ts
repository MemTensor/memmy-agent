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

async function formatDocumentRead(target: string, pages?: string | null, maxChars = 128_000): Promise<string> {
  const ext = path.extname(target).toLowerCase();
  const extracted = await extractText(target);
  if (extracted == null) return `Error: Unsupported file format: ${ext}`;
  if (extracted.startsWith("[error:")) return `Error reading ${ext.toUpperCase()} file: ${extracted}`;
  const paged = ext === ".pdf" ? filterExtractedPages(extracted, pages) : extracted;
  if (paged.startsWith("Error:")) return paged;
  if (!paged) return `(${ext.toUpperCase().replace(".", "")} has no extractable text: ${target})`;
  if (paged.length > maxChars) return `${paged.slice(0, maxChars)}\n\n(Document text truncated at ~128K chars)`;
  return paged;
}

async function readPdf(target: string, pages?: string | null, maxChars = 128_000): Promise<string> {
  const extracted = await extractText(target);
  if (extracted == null) return "Error: PDF reading requires PDF text extraction support.";
  if (extracted.startsWith("[error:")) return `Error reading PDF: ${extracted}`;
  const paged = filterExtractedPages(extracted, pages);
  if (paged.startsWith("Error:")) return paged;
  if (!paged) return `(PDF has no extractable text: ${target})`;
  if (paged.length > maxChars) return `${paged.slice(0, maxChars)}\n\n(PDF text truncated at ~128K chars)`;
  return paged;
}

async function readOfficeDoc(target: string, maxChars = 128_000): Promise<string> {
  const ext = path.extname(target).toLowerCase();
  const extracted = await extractText(target);
  if (extracted == null) return `Error: Unsupported file format: ${ext}`;
  if (extracted.startsWith("[error:")) return `Error reading ${ext.toUpperCase()} file: ${extracted}`;
  if (!extracted) return `(${ext.toUpperCase().replace(".", "")} has no extractable text: ${target})`;
  if (extracted.length > maxChars) return `${extracted.slice(0, maxChars)}\n\n(Document text truncated at ~128K chars)`;
  return extracted;
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
      extraAllowedDirs: restrict ? [BUILTIN_SKILLS_DIR] : undefined,
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
      extraAllowedDirs: restrict ? [BUILTIN_SKILLS_DIR] : undefined,
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
      "Use offset and limit for large text files. Use force=true to re-read content even if unchanged."
    );
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1 },
        pages: { type: "string" },
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

  async execute(params: { path?: string; offset?: number; limit?: number; pages?: string; force?: boolean } = {}): Promise<any> {
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
      if (ext === ".pdf") return this.readPdfFile(target, params.pages ?? null);
      if ([".docx", ".xlsx", ".pptx"].includes(ext)) return this.readOfficeDocument(target);
      if (DOCUMENT_EXTS.has(ext)) return await formatDocumentRead(target, params.pages, ReadFileTool.MAX_CHARS);
      if (IMAGE_EXTS.has(ext)) {
        const data = await fs.readFile(target);
        const mime = lookup(target) || "image/png";
        return [
          {
            type: "image_url",
            image_url: { url: `data:${mime};base64,${data.toString("base64")}` },
            meta: { path: target },
          },
          { type: "text", text: `(Image file: ${target})` },
        ];
      }
      const content = await fs.readFile(target, "utf8");
      if (!content) return "Empty file";
      const lines = normalizeNewlines(content).split("\n");
      const offset = params.offset ?? 1;
      if (offset > lines.length) return `Error reading file: offset ${offset} beyond end (${lines.length} lines)`;
      const limit = params.limit ?? null;
      if (!params.force && this.fileStates().isUnchanged(target, offset, limit)) {
        return `[File unchanged since last read: ${workspaceRelative(this.workspace, target).replaceAll(path.sep, "/")}]`;
      }
      let selected = lines.slice(offset - 1, params.limit ? offset - 1 + params.limit : undefined);
      let body = lineNumbered(selected, offset);
      let nextOffset = offset + selected.length;
      while (body.length > ReadFileTool.MAX_CHARS && selected.length > 1) {
        selected = selected.slice(0, Math.max(1, Math.floor(selected.length * 0.8)));
        body = lineNumbered(selected, offset);
        nextOffset = offset + selected.length;
      }
      const footer =
        nextOffset <= lines.length
          ? `\n\nUse offset=${nextOffset} to continue.`
          : "\n\nEnd of file";
      this.fileStates().recordRead(target, offset, limit);
      return body + footer;
    } catch (error) {
      const msg = (error as NodeJS.ErrnoException).code === "ENOENT" ? "not found" : (error as Error).message;
      return `Error reading file: ${msg}`;
    }
  }

  readPdfFile(target: string, pages?: string | null): Promise<string> {
    return readPdf(target, pages, ReadFileTool.MAX_CHARS);
  }

  readOfficeDocument(target: string): Promise<string> {
    return readOfficeDoc(target, ReadFileTool.MAX_CHARS);
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
      extraAllowedDirs: restrict ? [BUILTIN_SKILLS_DIR] : undefined,
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
      extraAllowedDirs: restrict ? [BUILTIN_SKILLS_DIR] : undefined,
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
      "For multi-file, structural, or generated code edits, prefer apply_patch."
    );
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        oldText: { type: "string" },
        new_text: { type: "string" },
        newText: { type: "string" },
        replace_all: { type: "boolean" },
        replaceAll: { type: "boolean" },
        occurrence: { type: ["integer", "null"], minimum: 1 },
        line_hint: { type: ["integer", "null"], minimum: 1 },
        lineHint: { type: ["integer", "null"], minimum: 1 },
        expected_replacements: { type: ["integer", "null"], minimum: 1 },
        expectedReplacements: { type: ["integer", "null"], minimum: 1 },
      },
      required: ["path"],
    };
  }

  setContext(ctx: any): void {
    this.requestContext = ctx;
  }

  fileStates(): FileStates {
    return resolveFileStates(this.fileStateOwner, this.fallbackFileStates, this.requestContext);
  }

  async execute(params: {
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
  } = {}, context?: ToolExecutionContext): Promise<string> {
    if (!params.path) return "Error editing file: Unknown path";
    const oldText = params.old_text ?? params.oldText;
    const newText = params.new_text ?? params.newText;
    if (oldText == null) return "Error editing file: Unknown old_text";
    if (newText == null) return "Error editing file: Unknown new_text";
    const replaceAll = params.replace_all ?? params.replaceAll ?? false;
    const occurrence = params.occurrence ?? null;
    const lineHint = params.line_hint ?? params.lineHint ?? null;
    const expectedReplacements = params.expected_replacements ?? params.expectedReplacements ?? null;
    if (occurrence != null && occurrence < 1) return "Error: occurrence must be >= 1.";
    if (lineHint != null && lineHint < 1) return "Error: line_hint must be >= 1.";
    if (expectedReplacements != null && expectedReplacements < 1) return "Error: expected_replacements must be >= 1.";
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
          const existing = await fs.readFile(target, { encoding: "utf8", signal: signal ?? undefined });
          if (existing.trim()) return `Error editing file: cannot create file; ${params.path} already exists and is not empty.`;
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
      if (replaceAll && occurrence != null) return "Error: occurrence cannot be used with replace_all=true.";
      if (replaceAll && lineHint != null) return "Error: line_hint cannot be used with replace_all=true.";
      if (occurrence != null && lineHint != null) return "Error: line_hint cannot be used with occurrence.";
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
      extraAllowedDirs: restrict ? [BUILTIN_SKILLS_DIR] : undefined,
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
