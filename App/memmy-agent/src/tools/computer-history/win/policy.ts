import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { windowsPathKey } from "../core/application-identity.js";
export { windowsApplicationId } from "../core/application-identity.js";

const decimal = z.string().regex(/^[1-9][0-9]*$/u).refine((value) => BigInt(value) <= 0xffffffffffffffffn);
const executable = z.string().min(1).max(32768).refine((value) => path.win32.isAbsolute(value)
  && !value.includes("\0") && !value.startsWith("\\\\.\\") && !value.startsWith("\\\\?\\"));
const browserExecutables = { chrome: "chrome.exe", edge: "msedge.exe" } as const;
export function browserKind(executable: string): keyof typeof browserExecutables | null {
  const name = path.win32.basename(executable).toLowerCase();
  return name === browserExecutables.chrome ? "chrome" : name === browserExecutables.edge ? "edge" : null;
}
const selector = z.object({ controlType: z.enum(["Edit", "Document"]), automationId: z.string().min(1).max(256) }).strict();
export const documentSelector = z.union([selector,
  z.object({ controlType: z.literal("Edit"), automationId: z.literal(""), scope: z.literal("vscode.editor") }).strict(),
  z.object({ controlType: z.literal("Document"), automationId: z.literal(""), scope: z.literal("word.document") }).strict()]);
const app = z.object({ pid: z.number().int().min(1).max(0xffffffff), executable,
  captureText: z.boolean().default(true),
  browser: z.enum(["chrome", "edge"]).optional(),
  processStart: decimal.optional(), hwnd: decimal.optional(),
  searchFields: z.array(selector.refine((value) => value.controlType === "Edit")).max(32).optional(),
  documentRegions: z.array(documentSelector).max(32).optional(),
  sensitiveAutomationIds: z.array(z.string().min(1).max(256)).max(128).optional(),
}).strict().refine(value => !value.browser || browserKind(value.executable) === value.browser)
  .refine(value => value.captureText || (value.documentRegions?.every(item => !("scope" in item)
  || path.win32.basename(value.executable).toLowerCase() === (item.scope === "vscode.editor" ? "code.exe" : "winword.exe")) ?? true));
const limits = z.object({
  maxDepth: z.number().int().min(1).max(64).default(24),
  maxNodes: z.number().int().min(1).max(5000).default(400),
  maxVisited: z.number().int().min(1).max(20000).default(2000),
  maxTextChars: z.number().int().min(1).max(200000).default(12000),
  maxNodeTextChars: z.number().int().min(1).max(20000).default(2048),
  queryBudgetMs: z.number().int().min(50).max(10000).default(650),
  workerTimeoutMs: z.number().int().min(200).max(30000).default(1500),
}).strict().refine((value) => value.maxVisited >= value.maxNodes && value.maxNodeTextChars <= value.maxTextChars
  && value.workerTimeoutMs > value.queryBudgetMs);
const schema = z.object({ version: z.literal(1), applications: z.array(app).min(1).max(512),
  defaultApplicationBehavior: z.enum(["observe", "do_not_observe"]).optional(),
  sensitiveAutomationIds: z.array(z.string().min(1).max(256)).max(128).optional(),
  deny: z.object({ pids: z.array(z.number().int().min(1).max(0xffffffff)).max(128).optional(),
    executables: z.array(executable).max(128).optional() }).strict().optional(),
  limits: limits.optional(),
}).strict().refine((value) => value.defaultApplicationBehavior === "observe" || value.applications.length <= 32);

export type NativePolicy = z.infer<typeof schema> & { limits: z.infer<typeof limits> };
export type NativeAppRule = z.infer<typeof app>;

export function parseNativePolicy(input: unknown): NativePolicy {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error("windows_policy_invalid");
  return { ...parsed.data, limits: parsed.data.limits ?? limits.parse({}) };
}
export function readNativePolicy(file: string): { policy: NativePolicy; revision: string } {
  try {
    const fd = fs.openSync(file, "r");
    let bytes: Buffer;
    try {
      if (fs.fstatSync(fd).size > 256 * 1024) throw new Error();
      bytes = fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
    if (bytes.length > 256 * 1024) throw new Error();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, "");
    return { policy: parseNativePolicy(JSON.parse(text)), revision: crypto.createHash("sha256").update(bytes).digest("hex") };
  } catch { throw new Error("windows_policy_unavailable"); }
}

// Native output uses canonical DOS paths. Windows rules never impersonate a bundle identifier.
export const pathKey = windowsPathKey;
export function isSystemSurface(executable: string): boolean {
  const name = path.win32.basename(pathKey(executable));
  return ["winlogon.exe", "logonui.exe", "lockapp.exe"].includes(name) || name.endsWith(".scr");
}
// Compatibility export: browser identification never denies generic capture.
export function isUnsupportedBrowser(executable: string): boolean { void executable; return false; }
export function authorizedRule(policy: NativePolicy, context: { pid: number; executable: string; processStart: string; hwnd: string }): NativeAppRule | null {
  const key = pathKey(context.executable);
  if (isSystemSurface(key) || isUnsupportedBrowser(key) || policy.deny?.pids?.includes(context.pid)
      || policy.deny?.executables?.some((item) => pathKey(item) === key)) return null;
  return policy.applications.find((rule) => rule.pid === context.pid && pathKey(rule.executable) === key
    && (!rule.processStart || rule.processStart === context.processStart) && (!rule.hwnd || rule.hwnd === context.hwnd)) ?? null;
}

export interface ApplicationBinding { pid: number; executable: string; processStart: string; hwnd?: string }
export type WindowsApplicationRule = Omit<NativeAppRule, "pid" | "processStart" | "hwnd" | "captureText"> & { captureText?: boolean };
// Compatibility hints for explicit captureText:false; generic capture needs no selectors.
export function defaultDocumentRegions(executable: string): NativeAppRule["documentRegions"] {
  switch (path.win32.basename(executable).toLowerCase()) {
    case "winword.exe": return [{ controlType: "Edit", automationId: "Body" },
      { controlType: "Document", automationId: "", scope: "word.document" }];
    case "code.exe": return [{ controlType: "Edit", automationId: "", scope: "vscode.editor" }];
    default: return undefined;
  }
}
// Discovery binds the chosen application scope to actual process instances. A broad scope
// still supplies exact PID/path/creation-time bindings; the native collector has no wildcard.
export function compileWindowsPolicy(rules: WindowsApplicationRule[], bindings: ApplicationBinding[],
  options: Partial<Omit<NativePolicy, "applications" | "version">> = {}): NativePolicy {
  const applications = bindings.flatMap((binding) => {
    const key = pathKey(binding.executable);
    if (isSystemSurface(key) || isUnsupportedBrowser(key) || options.deny?.pids?.includes(binding.pid)
        || options.deny?.executables?.some((item) => pathKey(item) === key)) return [];
    const rule = rules.find((item) => pathKey(item.executable) === key)
      ?? (options.defaultApplicationBehavior === "observe" ? { executable: binding.executable } : null);
    const kind = browserKind(key);
    return rule ? [{ ...rule, captureText: rule.captureText ?? true,
      ...(rule.captureText === false && rule.documentRegions === undefined ? { documentRegions: defaultDocumentRegions(binding.executable) } : {}),
      ...(kind ? { browser: kind } : {}),
      pid: binding.pid, executable: binding.executable, processStart: binding.processStart,
      ...(binding.hwnd ? { hwnd: binding.hwnd } : {}) }] : [];
  });
  return parseNativePolicy({ ...options, version: 1, applications });
}

// Call only after the collector's pause acknowledgement. Its emission-time read lease denies
// replacement while content is being written; failures leave the caller paused.
export function replaceNativePolicy(file: string, policy: NativePolicy): void {
  const validated = parseNativePolicy(policy);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const bytes = JSON.stringify(validated);
  fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  try { fs.renameSync(temporary, file); }
  catch { fs.unlinkSync(temporary); throw new Error("windows_policy_update_failed"); }
}
