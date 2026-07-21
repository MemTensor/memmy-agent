import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { XMLValidator } from "fast-xml-parser";
import { HtmlValidate, type Message as HtmlValidateMessage } from "html-validate";
import { parse as parseHtml, type DefaultTreeAdapterTypes } from "parse5";
import postcss from "postcss";
import { parse as parseToml, TomlError } from "smol-toml";
import ts from "typescript";
import which from "which";
import YAML from "yaml";

export type FileLintStatus = "passed" | "failed" | "skipped";

export type FileLintResult = {
  path: string;
  status: FileLintStatus;
  output: string;
};

export type FileLintRequest = {
  path: string;
  content: string;
  previousContent?: string | null;
  useDelta?: boolean;
};

export type FileLintRuntime = {
  resolveCommand?: (command: string) => string | null;
  spawn?: typeof spawn;
  now?: () => number;
  timeoutMs?: number;
};

export type FileLintOptions = {
  abortSignal?: AbortSignal | null;
  runtime?: FileLintRuntime;
};

type ValidatorResult = {
  status: FileLintStatus;
  output: string;
};

type ResolvedRuntime = {
  resolveCommand: (command: string) => string | null;
  spawn: typeof spawn;
  now: () => number;
  timeoutMs: number;
};

type StderrBudget = {
  used: number;
  exceeded: boolean;
};

type ProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  timedOut: boolean;
  outputExceeded: boolean;
  error: Error | null;
};

const MAX_LINT_BYTES = 2 * 1024 * 1024;
const MAX_VALIDATOR_OUTPUT_CHARS = 64 * 1024;
const VALIDATOR_TIMEOUT_MS = 5_000;
const MAX_LINT_WORKERS = 4;
const MAX_FORMATTED_LINT_OUTPUT_CHARS = 8_000;
const OMISSION_MARKER_CHARS = 48;
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const HTML_INLINE_DIRECTIVE_RE = /^\s*\[?html-validate-(enable|disable|disable-block|disable-next)\b/i;
const RUST_EDITIONS = ["2024", "2021", "2018", "2015"] as const;
const RUST_INTERNAL_ERROR_RE = /(internal error|panicked at|fatal runtime error)/i;
const JAVASCRIPT_SCRIPT_TYPES = new Set([
  "module",
  "text/javascript",
  "application/javascript",
  "text/ecmascript",
  "application/ecmascript",
]);
const rustEditionCache = new Map<string, readonly string[]>();

function createAbortError(): Error {
  const error = new Error("task cancelled");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { name?: string }).name === "AbortError");
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw createAbortError();
}

function defaultResolveCommand(command: string): string | null {
  const resolved = which.sync(command, { nothrow: true });
  return typeof resolved === "string" ? path.resolve(resolved) : null;
}

function resolveRuntime(runtime: FileLintRuntime | undefined): ResolvedRuntime {
  return {
    resolveCommand: runtime?.resolveCommand ?? defaultResolveCommand,
    spawn: runtime?.spawn ?? spawn,
    now: runtime?.now ?? Date.now,
    timeoutMs: runtime?.timeoutMs ?? VALIDATOR_TIMEOUT_MS,
  };
}

function passed(output = ""): ValidatorResult {
  return { status: "passed", output };
}

function failed(output: string): ValidatorResult {
  return { status: "failed", output };
}

function skipped(output: string): ValidatorResult {
  return { status: "skipped", output };
}

function errorSummary(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function truncateValidatorOutput(output: string): string {
  if (output.length <= MAX_VALIDATOR_OUTPUT_CHARS) return output;
  const retained = MAX_VALIDATOR_OUTPUT_CHARS - OMISSION_MARKER_CHARS;
  const head = Math.ceil(retained / 2);
  const tail = Math.floor(retained / 2);
  const omitted = output.length - head - tail;
  const marker = `\n... omitted ${omitted} characters ...\n`;
  return `${output.slice(0, head)}${marker}${tail ? output.slice(-tail) : ""}`;
}

function normalizeDiagnosticOutput(output: string): string {
  return output
    .replace(/\r\n?/g, "\n")
    .replace(ANSI_ESCAPE_RE, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\s+$/u, "");
}

function formatUnknownError(label: string, error: unknown): ValidatorResult {
  return skipped(`${label} validator unavailable: ${errorSummary(error)}`);
}

function scriptKindForExtension(ext: string): ts.ScriptKind | null {
  if ([".js", ".mjs", ".cjs"].includes(ext)) return ts.ScriptKind.JS;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if ([".ts", ".mts", ".cts"].includes(ext)) return ts.ScriptKind.TS;
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  return null;
}

function validateTypeScript(filePath: string, content: string, scriptKind: ts.ScriptKind): ValidatorResult {
  const target = path.resolve(filePath);
  const sourceFile = ts.createSourceFile(target, content, ts.ScriptTarget.Latest, true, scriptKind);
  const options: ts.CompilerOptions = {
    allowJs: scriptKind === ts.ScriptKind.JS || scriptKind === ts.ScriptKind.JSX,
    jsx: ts.JsxEmit.Preserve,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const host: ts.CompilerHost = {
    fileExists: (candidate) => path.resolve(candidate) === target,
    getCanonicalFileName: (candidate) => candidate,
    getCurrentDirectory: () => path.dirname(target),
    getDefaultLibFileName: () => "lib.d.ts",
    getNewLine: () => "\n",
    getSourceFile: (candidate) => (path.resolve(candidate) === target ? sourceFile : undefined),
    readFile: (candidate) => (path.resolve(candidate) === target ? content : undefined),
    useCaseSensitiveFileNames: () => true,
    writeFile: () => undefined,
  };
  const program = ts.createProgram([target], options, host);
  const diagnostics = program.getSyntacticDiagnostics(sourceFile);
  if (!diagnostics.length) return passed();
  const output = ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (candidate) => candidate,
    getCurrentDirectory: () => path.dirname(target),
    getNewLine: () => "\n",
  });
  return failed(output.trimEnd());
}

function validateJson(content: string): ValidatorResult {
  try {
    JSON.parse(content);
    return passed();
  } catch (error) {
    if (error instanceof SyntaxError) return failed(error.message);
    throw error;
  }
}

function validateYaml(content: string): ValidatorResult {
  const documents = YAML.parseAllDocuments(content, { logLevel: "error", prettyErrors: true });
  const errors = documents.flatMap((document) => document.errors.map((error) => error.toString()));
  const warnings = documents.flatMap((document) => document.warnings.map((warning) => warning.toString()));
  if (errors.length) return failed([...errors, ...warnings].join("\n"));
  return passed(warnings.join("\n"));
}

function validateToml(content: string): ValidatorResult {
  try {
    parseToml(content);
    return passed();
  } catch (error) {
    if (error instanceof TomlError) return failed(error.message);
    throw error;
  }
}

function validateXml(content: string): ValidatorResult {
  const result = XMLValidator.validate(content);
  if (result === true) return passed();
  const line = result.err.line ? `:${result.err.line}` : "";
  const column = result.err.col ? `:${result.err.col}` : "";
  return failed(`${result.err.code}${line}${column} ${result.err.msg}`.trim());
}

function validateCss(filePath: string, content: string): ValidatorResult {
  try {
    postcss.parse(content, { from: filePath });
    return passed();
  } catch (error) {
    if (error && typeof error === "object" && (error as { name?: string }).name === "CssSyntaxError") {
      return failed(String(error));
    }
    throw error;
  }
}

function formatHtmlMessage(filePath: string, message: HtmlValidateMessage): string {
  const severity = message.severity === 2 ? "error" : "warning";
  const rule = message.ruleId ? ` (${message.ruleId})` : "";
  return `${filePath}:${message.line}:${message.column} ${severity} ${message.message}${rule}`;
}

function isElement(node: DefaultTreeAdapterTypes.Node): node is DefaultTreeAdapterTypes.Element {
  return "tagName" in node;
}

function childNodes(node: DefaultTreeAdapterTypes.Node): DefaultTreeAdapterTypes.ChildNode[] {
  return "childNodes" in node ? node.childNodes : [];
}

function collectHtmlNodes(document: DefaultTreeAdapterTypes.Document): DefaultTreeAdapterTypes.Node[] {
  const nodes: DefaultTreeAdapterTypes.Node[] = [];
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    nodes.push(node);
    for (const child of childNodes(node)) visit(child);
    if (isElement(node) && node.tagName === "template" && "content" in node) visit(node.content);
  };
  visit(document);
  return nodes;
}

function elementText(element: DefaultTreeAdapterTypes.Element): string {
  return element.childNodes
    .filter((node): node is DefaultTreeAdapterTypes.TextNode => node.nodeName === "#text")
    .map((node) => node.value)
    .join("");
}

function elementLine(element: DefaultTreeAdapterTypes.Element): number {
  return element.sourceCodeLocation?.startTag?.startLine ?? element.sourceCodeLocation?.startLine ?? 1;
}

async function validateHtml(filePath: string, content: string): Promise<ValidatorResult> {
  const htmlValidate = new HtmlValidate({
    root: true,
    extends: [],
    rules: {
      "close-order": "error",
      "element-name": "error",
      "no-dup-attr": "error",
      "script-element": "error",
    },
  });
  const report = await htmlValidate.validateString(content, filePath);
  const messages = report.results.flatMap((result) => result.messages);
  const errors = messages.filter((message) => message.severity === 2).map((message) => formatHtmlMessage(filePath, message));
  const warnings = messages.filter((message) => message.severity !== 2).map((message) => formatHtmlMessage(filePath, message));

  const document = parseHtml(content, { sourceCodeLocationInfo: true });
  const nodes = collectHtmlNodes(document);
  const elements = nodes.filter(isElement);
  const comments = nodes.filter((node): node is DefaultTreeAdapterTypes.CommentNode => node.nodeName === "#comment");
  for (const comment of comments) {
    if (HTML_INLINE_DIRECTIVE_RE.test(comment.data)) {
      errors.push(`${filePath}:${comment.sourceCodeLocation?.startLine ?? 1}:1 error Inline html-validate directives are not allowed by the file validator`);
    }
  }

  const explicitHtml = elements.filter((element) => element.tagName === "html" && element.sourceCodeLocation?.startTag);
  const hasExplicitDoctype = nodes.some((node) => node.nodeName === "#documentType" && node.sourceCodeLocation);
  if (hasExplicitDoctype || explicitHtml.length) {
    if (explicitHtml.length !== 1) {
      errors.push(`${filePath}: error Complete documents must contain exactly one explicit <html> start tag`);
    } else {
      const html = explicitHtml[0];
      const htmlStart = html.sourceCodeLocation?.startTag?.startOffset;
      const htmlEnd = html.sourceCodeLocation?.endTag?.startOffset;
      const explicitBodies = elements.filter(
        (element) => element.tagName === "body" && element.parentNode === html && element.sourceCodeLocation?.startTag,
      );
      if (htmlEnd == null) errors.push(`${filePath}: error Missing explicit </html> end tag`);
      if (explicitBodies.length !== 1) {
        errors.push(`${filePath}: error Complete documents must contain exactly one explicit <body> start tag inside <html>`);
      } else {
        const body = explicitBodies[0];
        const bodyStart = body.sourceCodeLocation?.startTag?.startOffset;
        const bodyEnd = body.sourceCodeLocation?.endTag?.startOffset;
        if (bodyEnd == null) errors.push(`${filePath}: error Missing explicit </body> end tag`);
        if (
          htmlStart != null
          && bodyStart != null
          && bodyEnd != null
          && htmlEnd != null
          && !(htmlStart < bodyStart && bodyStart < bodyEnd && bodyEnd < htmlEnd)
        ) {
          errors.push(`${filePath}: error Explicit <html>/<body> tags are not in document order`);
        }
      }
      const explicitHeads = elements.filter(
        (element) => element.tagName === "head" && element.parentNode === html && element.sourceCodeLocation?.startTag,
      );
      if (explicitHeads.length > 1) {
        errors.push(`${filePath}: error Complete documents may contain at most one explicit <head>`);
      } else if (explicitHeads.length === 1) {
        const head = explicitHeads[0];
        const headStart = head.sourceCodeLocation?.startTag?.startOffset;
        const headEnd = head.sourceCodeLocation?.endTag?.startOffset;
        const bodyStart = elements.find(
          (element) => element.tagName === "body" && element.parentNode === html && element.sourceCodeLocation?.startTag,
        )?.sourceCodeLocation?.startTag?.startOffset;
        if (headEnd == null) errors.push(`${filePath}: error Missing explicit </head> end tag`);
        if (
          htmlStart != null
          && headStart != null
          && headEnd != null
          && bodyStart != null
          && !(htmlStart < headStart && headStart < headEnd && headEnd < bodyStart)
        ) {
          errors.push(`${filePath}: error Explicit <head> tags are not in document order`);
        }
      }
    }
  }

  let styleIndex = 0;
  let scriptIndex = 0;
  for (const element of elements) {
    if (element.tagName === "style") {
      styleIndex += 1;
      const result = validateCss(`${filePath}.style-${styleIndex}.css`, elementText(element));
      if (result.output) {
        const block = `${filePath}:${elementLine(element)} Embedded <style>:\n${result.output}`;
        if (result.status === "failed") errors.push(block);
        else if (result.status === "passed") warnings.push(block);
      }
    }
    if (element.tagName === "script") {
      const rawType = element.attrs.find((attribute) => attribute.name.toLowerCase() === "type")?.value ?? "";
      const scriptType = rawType.trim().toLowerCase();
      if (!scriptType || JAVASCRIPT_SCRIPT_TYPES.has(scriptType)) {
        scriptIndex += 1;
        const result = validateTypeScript(`${filePath}.script-${scriptIndex}.js`, elementText(element), ts.ScriptKind.JS);
        if (result.output) {
          const block = `${filePath}:${elementLine(element)} Embedded <script>:\n${result.output}`;
          if (result.status === "failed") errors.push(block);
          else if (result.status === "passed") warnings.push(block);
        }
      }
    }
  }

  if (errors.length || report.errorCount > 0) return failed([...errors, ...warnings].join("\n"));
  return passed(warnings.join("\n"));
}

async function runProcess(
  executable: string,
  args: readonly string[],
  input: string,
  options: {
    abortSignal?: AbortSignal | null;
    budget: StderrBudget;
    cwd?: string;
    deadline: number;
    runtime: ResolvedRuntime;
  },
): Promise<ProcessResult> {
  const { abortSignal, budget, cwd, deadline, runtime } = options;
  throwIfAborted(abortSignal);
  const remaining = deadline - runtime.now();
  if (remaining <= 0) {
    return { code: null, signal: null, stderr: "", timedOut: true, outputExceeded: false, error: null };
  }

  return new Promise<ProcessResult>((resolve, reject) => {
    let child: ChildProcess;
    let settled = false;
    let timedOut = false;
    let outputExceeded = false;
    let processError: Error | null = null;
    const stderr: string[] = [];

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      if (abortSignal?.aborted) {
        reject(createAbortError());
        return;
      }
      resolve({ code, signal, stderr: stderr.join(""), timedOut, outputExceeded, error: processError });
    };
    const onAbort = (): void => {
      child.kill("SIGTERM");
    };

    try {
      child = runtime.spawn(executable, [...args], {
        cwd,
        shell: false,
        stdio: ["pipe", "ignore", "pipe"],
      });
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        stderr: "",
        timedOut: false,
        outputExceeded: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, remaining);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      processError = error;
    });
    child.once("close", finish);
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      const available = Math.max(0, MAX_VALIDATOR_OUTPUT_CHARS - budget.used);
      if (text.length > available) {
        if (available) stderr.push(text.slice(0, available));
        budget.used += available;
        budget.exceeded = true;
        outputExceeded = true;
        child.kill("SIGTERM");
        return;
      }
      stderr.push(text);
      budget.used += text.length;
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });
}

function processUnavailable(result: ProcessResult): ValidatorResult | null {
  if (result.timedOut) return skipped("Validator timed out after 5000ms");
  if (result.outputExceeded) return skipped(`Validator stderr exceeded ${MAX_VALIDATOR_OUTPUT_CHARS} characters`);
  if (result.error) return skipped(`Validator process failed: ${result.error.message}`);
  if (result.signal) return skipped(`Validator process terminated by ${result.signal}`);
  return null;
}

function resolveFirstCommand(runtime: ResolvedRuntime, commands: readonly string[], deadline: number): string | null {
  for (const command of commands) {
    if (runtime.now() >= deadline) return null;
    const resolved = runtime.resolveCommand(command);
    if (resolved) return path.resolve(resolved);
  }
  return null;
}

const PYTHON_VALIDATOR_SCRIPT = [
  "import ast,sys",
  "try:",
  " ast.parse(sys.stdin.read())",
  "except SyntaxError as e:",
  " print(f'SyntaxError: {e.msg} at line {e.lineno}, column {e.offset}', file=sys.stderr)",
  " sys.exit(1)",
  "except Exception as e:",
  " print(f'ValidatorError: {type(e).__name__}: {e}', file=sys.stderr)",
  " sys.exit(2)",
].join("\n");

async function validatePython(content: string, options: FileLintOptions): Promise<ValidatorResult> {
  const runtime = resolveRuntime(options.runtime);
  const deadline = runtime.now() + runtime.timeoutMs;
  const executable = resolveFirstCommand(runtime, ["python3", "python"], deadline);
  if (!executable) return skipped("python3 or python not available");
  const budget = { used: 0, exceeded: false };
  const result = await runProcess(executable, ["-c", PYTHON_VALIDATOR_SCRIPT], content, {
    abortSignal: options.abortSignal,
    budget,
    deadline,
    runtime,
  });
  const unavailable = processUnavailable(result);
  if (unavailable) return unavailable;
  if (result.code === 0) return passed();
  if (result.code === 1) return failed(result.stderr.trim());
  return skipped(result.stderr.trim() || `Python validator exited with code ${result.code}`);
}

async function validateGo(content: string, options: FileLintOptions): Promise<ValidatorResult> {
  const runtime = resolveRuntime(options.runtime);
  const deadline = runtime.now() + runtime.timeoutMs;
  const executable = resolveFirstCommand(runtime, ["gofmt"], deadline);
  if (!executable) return skipped("gofmt not available");
  const budget = { used: 0, exceeded: false };
  const result = await runProcess(executable, ["-e"], content, {
    abortSignal: options.abortSignal,
    budget,
    deadline,
    runtime,
  });
  const unavailable = processUnavailable(result);
  if (unavailable) return unavailable;
  if (result.code === 0) return passed();
  const output = result.stderr.trim();
  if (!output || RUST_INTERNAL_ERROR_RE.test(output)) return skipped(output || "gofmt failed without diagnostics");
  return failed(output);
}

async function supportedRustEditions(
  executable: string,
  configPath: string,
  deadline: number,
  budget: StderrBudget,
  options: FileLintOptions,
): Promise<readonly string[] | ValidatorResult> {
  const cached = rustEditionCache.get(executable);
  if (cached) return cached;
  const runtime = resolveRuntime(options.runtime);
  const supported: string[] = [];
  for (const edition of RUST_EDITIONS) {
    const result = await runProcess(
      executable,
      ["--emit", "stdout", "--edition", edition, "--config-path", configPath],
      "fn main() {}\n",
      { abortSignal: options.abortSignal, budget, cwd: path.dirname(configPath), deadline, runtime },
    );
    const unavailable = processUnavailable(result);
    if (unavailable) return unavailable;
    if (result.code === 0) supported.push(edition);
  }
  if (!supported.length) return skipped("rustfmt did not accept any supported Rust edition");
  rustEditionCache.set(executable, supported);
  return supported;
}

function isValidatorResult(value: readonly string[] | ValidatorResult): value is ValidatorResult {
  return !Array.isArray(value);
}

async function validateRust(content: string, options: FileLintOptions): Promise<ValidatorResult> {
  const runtime = resolveRuntime(options.runtime);
  const deadline = runtime.now() + runtime.timeoutMs;
  const executable = resolveFirstCommand(runtime, ["rustfmt"], deadline);
  if (!executable) return skipped("rustfmt not available");
  const budget = { used: 0, exceeded: false };
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-rustfmt-"));
  const configPath = path.join(tempDir, "rustfmt.toml");
  try {
    await fs.writeFile(configPath, "", "utf8");
    const editions = await supportedRustEditions(executable, configPath, deadline, budget, options);
    if (isValidatorResult(editions)) return editions;
    const diagnostics: string[] = [];
    for (const edition of editions) {
      const result = await runProcess(
        executable,
        ["--emit", "stdout", "--edition", edition, "--config-path", configPath],
        content,
        { abortSignal: options.abortSignal, budget, cwd: tempDir, deadline, runtime },
      );
      const unavailable = processUnavailable(result);
      if (unavailable) return unavailable;
      if (result.code === 0) return passed();
      const output = result.stderr.trim();
      if (!output || RUST_INTERNAL_ERROR_RE.test(output)) return skipped(output || "rustfmt failed without diagnostics");
      diagnostics.push(`[edition ${edition}]\n${output}`);
    }
    return failed(diagnostics.join("\n"));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function validateContent(filePath: string, content: string, options: FileLintOptions): Promise<ValidatorResult> {
  throwIfAborted(options.abortSignal);
  const ext = path.extname(filePath).toLowerCase();
  const supported = new Set([
    ".json", ".yaml", ".yml", ".toml", ".xml", ".svg", ".js", ".mjs", ".cjs", ".jsx",
    ".ts", ".mts", ".cts", ".tsx", ".py", ".go", ".rs", ".css", ".html", ".htm",
  ]);
  if (!supported.has(ext)) return skipped(`No validator for ${ext || "files without an extension"}`);
  if (content.includes("\0")) return skipped("Content contains NUL bytes and is not suitable for text validation");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_LINT_BYTES) return skipped(`Content is ${bytes} bytes; maximum lint size is ${MAX_LINT_BYTES} bytes`);

  try {
    let result: ValidatorResult;
    if (ext === ".json") result = validateJson(content);
    else if (ext === ".yaml" || ext === ".yml") result = validateYaml(content);
    else if (ext === ".toml") result = validateToml(content);
    else if (ext === ".xml" || ext === ".svg") result = validateXml(content);
    else if (ext === ".css") result = validateCss(filePath, content);
    else if (ext === ".html" || ext === ".htm") result = await validateHtml(filePath, content);
    else if (ext === ".py") result = await validatePython(content, options);
    else if (ext === ".go") result = await validateGo(content, options);
    else if (ext === ".rs") result = await validateRust(content, options);
    else {
      const scriptKind = scriptKindForExtension(ext);
      result = scriptKind == null ? skipped(`No validator for ${ext}`) : validateTypeScript(filePath, content, scriptKind);
    }
    throwIfAborted(options.abortSignal);
    return { ...result, output: truncateValidatorOutput(result.output) };
  } catch (error) {
    if (isAbortError(error)) throw error;
    const result = formatUnknownError(ext || "file", error);
    return { ...result, output: truncateValidatorOutput(result.output) };
  }
}

export async function lintFile(request: FileLintRequest, options: FileLintOptions = {}): Promise<FileLintResult> {
  const normalizedPath = path.resolve(request.path);
  const post = await validateContent(normalizedPath, request.content, options);
  if (post.status !== "failed" || !request.useDelta || request.previousContent == null) {
    return { path: normalizedPath, ...post };
  }
  const pre = await validateContent(normalizedPath, request.previousContent, options);
  if (pre.status === "failed" && normalizeDiagnosticOutput(pre.output) === normalizeDiagnosticOutput(post.output)) {
    return {
      path: normalizedPath,
      status: "passed",
      output: `Warning: pre-existing lint output unchanged\n${post.output}`,
    };
  }
  return { path: normalizedPath, ...post };
}

export async function lintFiles(
  requests: readonly FileLintRequest[],
  options: FileLintOptions = {},
): Promise<FileLintResult[]> {
  const results = new Array<FileLintResult>(requests.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      throwIfAborted(options.abortSignal);
      const index = nextIndex;
      nextIndex += 1;
      if (index >= requests.length) return;
      results[index] = await lintFile(requests[index], options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_LINT_WORKERS, requests.length) }, () => worker()));
  return results;
}

function truncateFormattedOutput(output: string, quota: number): string {
  if (output.length <= quota) return output;
  if (quota <= OMISSION_MARKER_CHARS) return `... omitted ${output.length} characters ...`.slice(0, quota);
  const retained = quota - OMISSION_MARKER_CHARS;
  const head = Math.ceil(retained / 2);
  const tail = Math.floor(retained / 2);
  const omitted = output.length - head - tail;
  const marker = `\n... omitted ${omitted} characters ...\n`;
  return `${output.slice(0, head)}${marker}${tail ? output.slice(-tail) : ""}`;
}

export function formatFileLintResults(results: readonly FileLintResult[]): string {
  const nonempty = results.filter((result) => result.output.length > 0);
  const baseQuota = nonempty.length ? Math.floor(MAX_FORMATTED_LINT_OUTPUT_CHARS / nonempty.length) : 0;
  let remainder = nonempty.length ? MAX_FORMATTED_LINT_OUTPUT_CHARS % nonempty.length : 0;
  const quotas = new Map<FileLintResult, number>();
  for (const result of nonempty) {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    quotas.set(result, baseQuota + extra);
  }
  const lines = ["Lint results:"];
  for (const result of results) {
    lines.push(`- ${result.path}: ${result.status}`);
    if (!result.output) continue;
    const output = truncateFormattedOutput(result.output, quotas.get(result) ?? 0);
    lines.push(...output.split("\n").map((line) => `  ${line}`));
  }
  return lines.join("\n");
}

export function appendFileLintResults(successText: string, results: readonly FileLintResult[]): string {
  return `${successText}\n\n${formatFileLintResults(results)}`;
}

export const fileLintTesting = {
  clearRustEditionCache(): void {
    rustEditionCache.clear();
  },
  constants: {
    MAX_FORMATTED_LINT_OUTPUT_CHARS,
    MAX_LINT_BYTES,
    MAX_VALIDATOR_OUTPUT_CHARS,
    OMISSION_MARKER_CHARS,
  },
};
