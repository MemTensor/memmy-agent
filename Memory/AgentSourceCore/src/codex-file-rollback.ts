import { lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

type Snapshot =
  | { path: string; kind: "missing" }
  | { path: string; kind: "file"; content: Buffer; mode: number }
  | { path: string; kind: "symlink"; target: string; directory: boolean }
  | { path: string; kind: "directory"; mode: number; children: Snapshot[] };

/** Record each successful mutation before awaiting external work. Never adopt later edits as our own. */
export async function withCodexFileRollback<T>(paths: string[], operation: (record: (path: string) => Promise<void>) => Promise<T>): Promise<T> {
  const before = new Map((await Promise.all(paths.map(snapshot))).map(value => [value.path, value]));
  const written = new Map<string, Snapshot>();
  try {
    return await operation(async path => {
      if (!before.has(path)) throw new Error(`Untracked Codex installation path: ${path}`);
      written.set(path, await snapshot(path));
    });
  } catch (error) {
    const conflicts: unknown[] = [];
    for (const [path, owned] of [...written].reverse()) {
      try {
        const original = before.get(path)!;
        const current = await snapshot(path);
        if (equal(current, owned)) {
          await restore(original);
        } else if (basename(path) === "AGENTS.md" && current.kind === "file" && owned.kind === "file" && (original.kind === "file" || original.kind === "missing")) {
          const pattern = /<!-- memmy:start v=1 -->\r?\n[\s\S]*?<!-- memmy:end v=1 -->(?:\r?\n)?/m;
          const text = current.content.toString();
          const installedBlock = owned.content.toString().match(pattern)?.[0];
          if (installedBlock && text.match(pattern)?.[0] === installedBlock) {
            const oldBlock = original.kind === "file" ? original.content.toString().match(pattern)?.[0] ?? "" : "";
            await atomicWrite(path, text.replace(pattern, () => oldBlock), current.mode);
          } else {
            throw new Error(`Rollback conflict; preserved later edits: ${path}`);
          }
        } else {
          throw new Error(`Rollback conflict; preserved later edits: ${path}`);
        }
      } catch (failure) { conflicts.push(failure); }
    }
    if (conflicts.length) throw new AggregateError([error, ...conflicts], "Codex installation failed; rollback preserved conflicting user edits", { cause: error });
    throw error;
  }
}

function equal(a: Snapshot, b: Snapshot): boolean {
  if (a.kind !== b.kind) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

async function snapshot(path: string): Promise<Snapshot> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return { path, kind: "symlink", target: await readlink(path), directory: await stat(path).then(v => v.isDirectory(), () => false) };
    if (info.isDirectory()) return { path, kind: "directory", mode: info.mode & 0o777, children: await Promise.all((await readdir(path)).sort().map(name => snapshot(join(path, name)))) };
    if (!info.isFile()) throw new Error(`Unsupported Codex installation path: ${path}`);
    return { path, kind: "file", mode: info.mode & 0o777, content: await readFile(path) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, kind: "missing" };
    throw error;
  }
}

async function restore(value: Snapshot): Promise<void> {
  // Called only after verifying the entire current entry still matches our recorded write.
  if (value.kind === "file") {
    const current = await lstat(value.path).catch(() => null);
    if (current && !current.isFile()) await rm(value.path, { recursive: true, force: true });
    await atomicWrite(value.path, value.content, value.mode); return;
  }
  await rm(value.path, { recursive: true, force: true });
  if (value.kind === "missing") return;
  await mkdir(dirname(value.path), { recursive: true });
  if (value.kind === "symlink") {
    const target = process.platform === "win32" && value.directory ? resolve(dirname(value.path), value.target) : value.target;
    await symlink(target, value.path, value.directory ? (process.platform === "win32" ? "junction" : "dir") : "file");
  } else {
    await mkdir(value.path, { mode: value.mode });
    for (const child of value.children) await restore(child);
  }
}

async function atomicWrite(path: string, content: string | Buffer, mode: number): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try { await writeFile(temporary, content, { mode }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
