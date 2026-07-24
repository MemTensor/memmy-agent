import fs from "node:fs";
import path from "node:path";
import which from "which";
import YAML from "yaml";

export const BUILTIN_SKILLS_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "skills");
export const SKILL_FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;

export type SkillEntry = { name: string; path: string; source: string };

export class SkillsLoader {
  workspace: string;
  workspaceSkills: string;
  builtinSkills: string | null;
  disabledSkills: Set<string>;
  roots: string[];

  constructor(
    workspaceOrRoots: string | string[],
    builtinSkillsDir: string | null = null,
    disabledSkills: Set<string> | string[] | null = null,
  ) {
    if (Array.isArray(workspaceOrRoots)) {
      this.workspace = "";
      this.roots = workspaceOrRoots.map((root) => path.resolve(root));
      this.workspaceSkills = this.roots[0] ?? "";
      this.builtinSkills = this.roots[1] ?? null;
    } else {
      this.workspace = path.resolve(workspaceOrRoots);
      this.workspaceSkills = path.join(this.workspace, "skills");
      this.builtinSkills = builtinSkillsDir ? path.resolve(builtinSkillsDir) : BUILTIN_SKILLS_DIR;
      this.roots = [this.workspaceSkills, this.builtinSkills].filter(Boolean) as string[];
    }
    this.disabledSkills = new Set(disabledSkills ?? []);
  }

  private skillEntriesFromDir(base: string, source: string, skipNames: Set<string> | null = null): SkillEntry[] {
    if (!base || !fs.existsSync(base)) return [];
    const entries: SkillEntry[] = [];
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(base, entry.name, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      if (skipNames?.has(entry.name)) continue;
      entries.push({ name: entry.name, path: skillFile, source });
    }
    return entries;
  }

  listSkills(filterUnavailable = true): SkillEntry[] {
    const skills = this.skillEntriesFromDir(this.workspaceSkills, "workspace");
    const workspaceNames = new Set(skills.map((entry) => entry.name));
    if (this.builtinSkills && fs.existsSync(this.builtinSkills)) {
      skills.push(...this.skillEntriesFromDir(this.builtinSkills, "builtin", workspaceNames));
    }
    let filtered = this.disabledSkills.size ? skills.filter((skill) => !this.disabledSkills.has(skill.name)) : skills;
    if (filterUnavailable) filtered = filtered.filter((skill) => this.checkRequirements(this.getSkillMeta(skill.name)));
    return filtered.sort((a, b) => a.name.localeCompare(b.name));
  }

  loadSkill(name: string): string | null {
    for (const root of this.roots) {
      const skillFile = path.join(root, name, "SKILL.md");
      if (fs.existsSync(skillFile)) return fs.readFileSync(skillFile, "utf8");
    }
    return null;
  }

  loadSkillsForContext(skillNames: string[]): string {
    const parts: string[] = [];
    for (const name of skillNames) {
      const markdown = this.loadSkill(name);
      if (markdown) parts.push(`### Skill: ${name}\n\n${this.stripFrontmatter(markdown)}`);
    }
    return parts.join("\n\n---\n\n");
  }

  buildSkillsSummary(exclude: Set<string> | string[] | null = null): string {
    const excluded = exclude == null ? new Set<string>() : new Set(exclude);
    const lines: string[] = [];
    for (const entry of this.listSkills(false)) {
      if (excluded.has(entry.name)) continue;
      const meta = this.getSkillMeta(entry.name);
      if (meta.manualOnly) continue;
      const available = this.checkRequirements(meta);
      const desc = this.getSkillDescription(entry.name);
      if (available) lines.push(`- **${entry.name}** - ${desc}  \`${entry.path}\``);
      else {
        const missing = this.getMissingRequirements(meta);
        lines.push(`- **${entry.name}** - ${desc}${missing ? ` (unavailable: ${missing})` : " (unavailable)"}  \`${entry.path}\``);
      }
    }
    return lines.join("\n");
  }

  getMissingRequirements(skillMeta: Record<string, any>): string {
    const requires = skillMeta.requires ?? {};
    const bins = Array.isArray(requires.bins) ? requires.bins : [];
    const env = Array.isArray(requires.env) ? requires.env : [];
    return [
      ...bins.filter((cmd: string) => !commandExists(cmd)).map((cmd: string) => `CLI: ${cmd}`),
      ...env.filter((name: string) => !process.env[name]).map((name: string) => `ENV: ${name}`),
    ].join(", ");
  }

  getSkillDescription(name: string): string {
    const meta = this.getSkillMetadata(name);
    return typeof meta?.description === "string" && meta.description ? meta.description : name;
  }

  stripFrontmatter(content: string): string {
    if (!content.startsWith("---")) return content;
    const match = content.match(SKILL_FRONTMATTER_RE);
    return match ? content.slice(match[0].length).trim() : content;
  }

  parseMemmyMetadata(raw: unknown): Record<string, any> {
    let data: any = raw;
    if (typeof raw === "string") {
      try {
        data = JSON.parse(raw);
      } catch {
        return {};
      }
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const payload = data.memmy ?? {};
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  }

  checkRequirements(skillMeta: Record<string, any>): boolean {
    return this.getMissingRequirements(skillMeta) === "";
  }

  getSkillMeta(name: string): Record<string, any> {
    const rawMeta = this.getSkillMetadata(name) ?? {};
    return this.parseMemmyMetadata(rawMeta.metadata);
  }

  getAlwaysSkills(): string[] {
    return this.listSkills(true)
      .filter((entry) => {
        const meta = this.getSkillMetadata(entry.name) ?? {};
        const memmy = this.parseMemmyMetadata(meta.metadata);
        return !memmy.manualOnly && Boolean(memmy.always || meta.always);
      })
      .map((entry) => entry.name);
  }

  findExplicitSkillNames(text: string): string[] {
    const available = new Set(this.listSkills(true).map((entry) => entry.name));
    const matches = new Set<string>();
    for (const match of text.matchAll(/\$([a-z0-9][a-z0-9-]{0,63})(?![a-z0-9-])/gu)) {
      const name = match[1];
      if (name && available.has(name)) matches.add(name);
    }
    return [...matches];
  }

  getSkillMetadata(name: string): Record<string, any> | null {
    const content = this.loadSkill(name);
    if (!content?.startsWith("---")) return null;
    const match = content.match(SKILL_FRONTMATTER_RE);
    if (!match) return null;
    try {
      const parsed = YAML.parse(match[1]);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [String(key), value]));
    } catch {
      return null;
    }
  }
}

function commandExists(command: string): boolean {
  return Boolean(which.sync(command, { nothrow: true }));
}
