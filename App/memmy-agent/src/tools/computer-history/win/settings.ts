import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { resolveNativeCollector } from "./native-helper.js";
import { z } from "zod";
import type { CatalogApplication } from "./application-catalog.js";
import { documentSelector, isSystemSurface, parseNativePolicy, pathKey, windowsApplicationId, type ApplicationBinding, type WindowsApplicationRule } from "./policy.js";

const rule = z.object({ executable: z.string().min(1), searchFields: z.array(z.object({ controlType: z.literal("Edit"), automationId: z.string() }).strict()).optional(),
  documentRegions: z.array(documentSelector).optional(), sensitiveAutomationIds: z.array(z.string()).optional() }).strict();
const settingsSchema = z.object({ version: z.literal(1), applications: z.array(rule).max(32),
  defaultApplicationBehavior: z.enum(["observe", "do_not_observe"]).optional(),
  sensitiveAutomationIds: z.array(z.string()).optional(), deny: z.object({ executables: z.array(z.string()).optional() }).strict().optional(),
  limits: z.unknown().optional() }).strict();
export interface WindowsHistorySettings { version: 1; applications: WindowsApplicationRule[];
  defaultApplicationBehavior?: "observe" | "do_not_observe";
  sensitiveAutomationIds?: string[]; deny?: { executables?: string[] }; limits?: ReturnType<typeof parseNativePolicy>["limits"] }
export function parseWindowsSettings(input: unknown): WindowsHistorySettings {
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) throw new Error("windows_settings_invalid");
  const source = parsed.data;
  // Native validation is authoritative for selector/path/budget constraints; a persistent
  // document may be empty, while an actual capture policy must contain an explicit binding.
  const validated = parseNativePolicy({ ...source, applications: (source.applications.length ? source.applications : [{ executable: "C:\\unused.exe" }]).map((item) => ({ ...item, pid: 1 })) });
  if (new Set(source.applications.map((item) => pathKey(item.executable))).size !== source.applications.length) throw new Error("windows_settings_invalid");
  return { version: 1, applications: validated.applications.slice(0, source.applications.length).map(({ pid: _pid, ...item }) => { void _pid; return item; }),
    ...(source.defaultApplicationBehavior ? { defaultApplicationBehavior: source.defaultApplicationBehavior } : {}),
    ...(validated.sensitiveAutomationIds ? { sensitiveAutomationIds: validated.sensitiveAutomationIds } : {}),
    ...(source.deny ? { deny: source.deny } : {}), limits: validated.limits };
}
export class WindowsSettingsStore {
  readonly filePath: string;
  constructor(file = path.join(os.homedir(), ".memmy", "computer-history", "windows-settings.json")) { this.filePath = path.resolve(file); }
  read(): WindowsHistorySettings {
    if (!fs.existsSync(this.filePath)) return parseWindowsSettings({ version: 1, defaultApplicationBehavior: "observe", applications: [] });
    try {
      if (fs.statSync(this.filePath).size > 256 * 1024) throw new Error();
      return parseWindowsSettings(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    } catch { throw new Error("windows_settings_invalid"); }
  }
  write(input: unknown): WindowsHistorySettings {
    const settings = parseWindowsSettings(input);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(settings), { flag: "wx", mode: 0o600 });
    try { fs.renameSync(temporary, this.filePath); }
    catch { fs.unlinkSync(temporary); throw new Error("windows_settings_write_failed"); }
    return settings;
  }
}
export function resolveWindowsCollector(binary?: string): string {
  return resolveNativeCollector(import.meta.url, binary);
}
const discoverySchema = z.object({ protocol: z.literal("memmy.windows.computer-history"), version: z.literal(1), platform: z.literal("windows"), kind: z.literal("applications"),
  applications: z.array(z.object({ pid: z.number().int().positive().max(0xffffffff), executable: z.string(),
    processStart: z.string().regex(/^[1-9][0-9]*$/u).max(20) }).strict()).max(512) }).strict();
export async function discoverApplications(binary: string): Promise<ApplicationBinding[]> {
  const output = await new Promise<Buffer>((resolve, reject) => execFile(binary, ["applications"],
    { encoding: "buffer", timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => error ? reject(new Error("windows_discovery_failed")) : resolve(stdout)));
  try {
    const parsed = discoverySchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(output)));
    // Revalidate identities using the same native policy ranges rather than coercing uint64.
    for (const binding of parsed.applications) parseNativePolicy({ version: 1, applications: [binding] });
    return parsed.applications;
  } catch { throw new Error("windows_discovery_invalid"); }
}
export const browserNames = new Set(["msedge.exe", "chrome.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe", "iexplore.exe", "chromium.exe", "arc.exe", "librewolf.exe", "waterfox.exe", "thorium.exe", "floorp.exe", "zen.exe", "360se.exe", "360chrome.exe", "qqbrowser.exe", "sogouexplorer.exe", "2345explorer.exe", "liebao.exe", "msedgewebview2.exe", "tor.exe"]);
export function applicationCatalog(bindings: ApplicationBinding[], settings: WindowsHistorySettings, installed: CatalogApplication[] = []) {
  const friendlyNames = new Map(installed.map((entry) => [pathKey(entry.executable), entry.name]));
  const names = new Map<string, { id: string; name: string; executable: string; running: boolean; supported: boolean; allowed: boolean; rule?: WindowsApplicationRule }>();
  for (const binding of [...installed.map((item) => ({ ...item, running: false })),
    ...settings.applications.map((item) => ({ ...item, running: false })),
    ...(settings.deny?.executables ?? []).map((executable) => ({ executable, running: false })),
    ...bindings.map((item) => ({ ...item, running: true }))]) {
    const key = pathKey(binding.executable);
    if (isSystemSurface(key)) continue;
    const rule = settings.applications.find((item) => pathKey(item.executable) === key);
    const supported = !browserNames.has(path.win32.basename(key));
    const denied = settings.deny?.executables?.some((exe) => pathKey(exe) === key);
    names.set(key, { id: windowsApplicationId(key), name: friendlyNames.get(key) ?? path.win32.basename(binding.executable), executable: binding.executable,
      running: binding.running, supported, allowed: supported && !denied && (settings.defaultApplicationBehavior === "observe" || !!rule), ...(rule ? { rule } : {}) });
  }
  return [...names.values()].sort((left, right) => left.name.localeCompare(right.name));
}
