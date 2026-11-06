/** Persistent generated contributions; the active index contains no executable code. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, lstat, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { z } from "zod";

const Entry = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  directory: z.string().min(1), files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  checks: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).optional() });
type Entry = z.infer<typeof Entry>;
export interface GeneratedPluginSkills {
  publish(pluginId: string, input: unknown): Promise<void>;
  assertStaticNames(pluginId: string, names: readonly string[]): Promise<void>;
  remove(pluginId: string, name: string): Promise<void>;
  activate(pluginId: string): Promise<void>;
  deactivate(pluginId: string): Promise<void>;
  reset(): Promise<void>;
}

export function createGeneratedPluginSkills(dataRoot: string, indexPath: string, staticSkillsRoot?: string): GeneratedPluginSkills {
  const active = new Set<string>();
  const entries = new Map<string, Entry[]>();
  let pending: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>) => {
    const next = pending.catch(() => undefined).then(operation); pending = next; return next;
  };
  const file = (id: string) => join(dataRoot, id, ".generated-skills.json");
  const assertWorkspaceName = async (name: string) => {
    if (!staticSkillsRoot) return;
    try { await lstat(join(staticSkillsRoot, name, "SKILL.md")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    throw new Error("Generated skill name conflicts with an existing static or workspace skill");
  };
  const flush = async () => atomic(indexPath, [...active].flatMap(pluginId =>
    (entries.get(pluginId) ?? []).map(entry => ({ pluginId, ...entry }))));
  return {
    assertStaticNames: (id, names) => serial(async () => {
      const own = entries.get(id) ?? z.array(Entry).parse(await readJson(file(id), []));
      if (own.some(entry => names.includes(entry.name)) || [...active].some(owner => owner !== id && entries.get(owner)?.some(entry => names.includes(entry.name)))) {
        throw new Error("Static skill name conflicts with a retained generated skill");
      }
    }),
    publish: (id, raw) => serial(async () => {
      const entry = Entry.parse(raw), root = await realpath(join(dataRoot, id));
      await assertWorkspaceName(entry.name);
      entry.directory = await realpath(entry.directory);
      descendant(root, entry.directory);
      if (!Object.hasOwn(entry.files, "SKILL.md") || Object.keys(entry.files).length > 100) throw new Error("Invalid generated skill bundle");
      let bytes = 0;
      for (const [name, hash] of Object.entries(entry.files)) {
        const target = resolve(entry.directory, name); descendant(entry.directory, target);
        if (name.includes("\\") || await realpath(target) !== target) throw new Error("Unsafe generated skill path");
        const stat = await lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink() || (bytes += stat.size) > 20_000_000) throw new Error("Invalid generated skill file");
        if (createHash("sha256").update(await readFile(target)).digest("hex") !== hash) throw new Error("Generated skill hash mismatch");
      }
      const all = entries.get(id) ?? z.array(Entry).parse(await readJson(file(id), []));
      if ([...active].some(owner => owner !== id && entries.get(owner)?.some(other => other.name === entry.name))) throw new Error("Generated skill name is already used by another active plugin");
      for (const [name, hash] of Object.entries(entry.checks ?? {})) {
        const target = resolve(root, name); descendant(root, target);
        if (await realpath(target) !== target || !(await lstat(target)).isFile()
          || createHash("sha256").update(await readFile(target)).digest("hex") !== hash) throw new Error("Generated skill evidence mismatch");
      }
      if (all.length >= 10_000 && !all.some(e => e.name === entry.name)) throw new Error("Generated skill limit reached");
      const next = [...all.filter(e => e.name !== entry.name), entry]; entries.set(id, next);
      await atomic(file(id), next); await flush();
    }),
    remove: (id, name) => serial(async () => {
      const all = entries.get(id) ?? z.array(Entry).parse(await readJson(file(id), []));
      const next = all.filter(e => e.name !== name); entries.set(id, next);
      await atomic(file(id), next); await flush();
    }),
    activate: id => serial(async () => {
      const restored = z.array(Entry).parse(await readJson(file(id), []));
      for (const entry of restored) await assertWorkspaceName(entry.name);
      if ([...active].some(owner => owner !== id && entries.get(owner)?.some(other => restored.some(entry => entry.name === other.name)))) throw new Error("Generated skill name conflicts with another active plugin");
      entries.set(id, restored);
      active.add(id); await flush();
    }),
    deactivate: id => serial(async () => { active.delete(id); await flush(); }),
    reset: () => serial(async () => { active.clear(); await flush(); })
  };
}
function descendant(root: string, target: string) {
  const value = relative(root, target);
  if (!value || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) throw new Error("Generated skill escapes plugin data directory");
}
async function readJson(file: string, fallback: unknown) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw e; }
}
async function atomic(file: string, value: unknown) {
  await mkdir(resolve(file, ".."), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, file);
}
