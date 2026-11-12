/** Read-only discovery of Host-owned active plugin contributions. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

const appDataRoot = process.env.MEMMY_APP_DB_PATH ? path.dirname(process.env.MEMMY_APP_DB_PATH)
  : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "Memmy")
  : process.platform === "win32" ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Memmy")
  : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "Memmy");
export const PLUGIN_SKILLS_ROOT = path.join(appDataRoot, "plugin-skills");
const pluginDataRoot = path.join(appDataRoot, "plugin-data");
export function listPluginSkills(root = PLUGIN_SKILLS_ROOT, dataRoot = pluginDataRoot): Array<{ name: string; path: string; source: string }> {
  const result: Array<{ name: string; path: string; source: string }> = [];
  try {
    const index = path.join(root, "active.json");
    if (fs.lstatSync(index).isSymbolicLink() || fs.statSync(index).size > 8_000_000) return result;
    const entries: unknown = JSON.parse(fs.readFileSync(index, "utf8"));
    if (!Array.isArray(entries)) return result;
    for (const entry of entries) {
      try {
        if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(entry.pluginId) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.name)) continue;
        // Match the native canonical paths written by Backend fs.promises.realpath, including Windows 8.3 aliases.
        const ownerRoot = fs.realpathSync.native(path.join(dataRoot, entry.pluginId));
        const directory = fs.realpathSync.native(entry.directory);
        if (!within(ownerRoot, directory) || typeof entry.files !== "object" || !entry.files["SKILL.md"]) continue;
        const files = Object.entries(entry.files);
        if (files.length > 100) continue;
        let bytes = 0;
        if (!files.every(([name, hash]) => {
          const file = path.resolve(directory, name), stat = fs.lstatSync(file);
          return within(directory, file) && fs.realpathSync.native(file) === file && stat.isFile() && !stat.isSymbolicLink()
            && (bytes += stat.size) <= 20_000_000 && createHash("sha256").update(fs.readFileSync(file)).digest("hex") === hash;
        })) continue;
        if (!Object.entries(entry.checks ?? {}).every(([name, hash]) => {
          const file = path.resolve(ownerRoot, name), stat = fs.lstatSync(file);
          return within(ownerRoot, file) && fs.realpathSync.native(file) === file && stat.isFile() && !stat.isSymbolicLink()
            && stat.size <= 2_000_000 && createHash("sha256").update(fs.readFileSync(file)).digest("hex") === hash;
        })) continue;
        result.push({ name: entry.name, path: path.join(directory, "SKILL.md"), source: "plugin" });
      } catch { /* Invalid/missing bundles disappear immediately. */ }
    }
  } catch { /* No active generated contributions. */ }
  return result;
}
export function loadPluginSkill(name: string, root = PLUGIN_SKILLS_ROOT, dataRoot = pluginDataRoot): string | null {
  const entry = listPluginSkills(root, dataRoot).find(skill => skill.name === name);
  return entry ? fs.readFileSync(entry.path, "utf8") : null;
}
function within(root: string, file: string) {
  const value = path.relative(root, file);
  return !!value && value !== ".." && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value);
}
