import { z } from "zod";
import { documentSelector, parseNativePolicy, pathKey, type WindowsApplicationRule } from "./teaching-windows-policy.js";
const rule = z.object({ executable: z.string().min(1), captureText: z.boolean().optional(), searchFields: z.array(z.object({ controlType: z.literal("Edit"), automationId: z.string() }).strict()).optional(),
  documentRegions: z.array(documentSelector).optional(), sensitiveAutomationIds: z.array(z.string()).optional() }).strict();
const settingsSchema = z.object({ version: z.literal(1), applications: z.array(rule).max(32),
  observationSettingsVersion: z.literal(1).optional(),
  defaultApplicationBehavior: z.enum(["observe", "do_not_observe"]).optional(),
  sensitiveAutomationIds: z.array(z.string()).optional(), deny: z.object({ executables: z.array(z.string()).optional() }).strict().optional(),
  limits: z.unknown().optional() }).strict();
export interface WindowsHistorySettings { version: 1; applications: WindowsApplicationRule[];
  observationSettingsVersion?: 1;
  defaultApplicationBehavior?: "observe" | "do_not_observe";
  sensitiveAutomationIds?: string[]; deny?: { executables?: string[] }; limits?: ReturnType<typeof parseNativePolicy>["limits"] }
export function parseWindowsSettings(input: unknown): WindowsHistorySettings {
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) throw new Error("windows_settings_invalid");
  const source = parsed.data;
  const { observationSettingsVersion: _migration, ...nativeSource } = source;
  void _migration;
  // Native validation is authoritative for selector/path/budget constraints; a persistent
  // document may be empty, while an actual capture policy must contain an explicit binding.
  const validated = parseNativePolicy({ ...nativeSource, applications: (source.applications.length ? source.applications : [{ executable: "C:\\unused.exe" }]).map((item) => ({ ...item, pid: 1 })) });
  if (new Set(source.applications.map((item) => pathKey(item.executable))).size !== source.applications.length) throw new Error("windows_settings_invalid");
  return { version: 1, applications: validated.applications.slice(0, source.applications.length).map(({ pid: _pid, ...item }) => { void _pid; return item; }),
    ...(source.observationSettingsVersion ? { observationSettingsVersion: source.observationSettingsVersion } : {}),
    ...(source.defaultApplicationBehavior ? { defaultApplicationBehavior: source.defaultApplicationBehavior } : {}),
    ...(validated.sensitiveAutomationIds ? { sensitiveAutomationIds: validated.sensitiveAutomationIds } : {}),
    ...(source.deny ? { deny: source.deny } : {}), limits: validated.limits };
}
