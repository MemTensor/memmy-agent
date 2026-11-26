import path from "node:path";
import { z } from "zod";
import { windowsPathKey } from "./teaching-application-identity.js";
export { windowsApplicationId } from "./teaching-application-identity.js";

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
  z.object({ controlType: z.literal("Document"), automationId: z.literal(""), scope: z.enum(["word.document", "notepad.document"]) }).strict()]);
const app = z.object({ pid: z.number().int().min(1).max(0xffffffff), executable,
  captureText: z.boolean().default(true),
  browser: z.enum(["chrome", "edge"]).optional(),
  processStart: decimal.optional(), hwnd: decimal.optional(),
  searchFields: z.array(selector.refine((value) => value.controlType === "Edit")).max(32).optional(),
  documentRegions: z.array(documentSelector).max(32).optional(),
  sensitiveAutomationIds: z.array(z.string().min(1).max(256)).max(128).optional(),
}).strict().refine(value => !value.browser || browserKind(value.executable) === value.browser)
  .refine(value => value.captureText || (value.documentRegions?.every(item => !("scope" in item)
  || path.win32.basename(value.executable).toLowerCase() === ({ "vscode.editor": "code.exe", "word.document": "winword.exe", "notepad.document": "notepad.exe" }[item.scope])) ?? true));
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

export const pathKey = windowsPathKey;
export type WindowsApplicationRule = Omit<NativeAppRule, "pid" | "processStart" | "hwnd" | "captureText"> & { captureText?: boolean };
