import type { DatabaseSync } from "node:sqlite";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { Session } from "./contracts.js";

function canonical(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync.native(absolute); } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonical(parent), basename(absolute));
  }
}

function contains(folder: string, cwd: string) {
  const path = relative(folder, cwd);
  return !isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep);
}

// The desktop workspace picker uses the built-in agent's WebUI project registry.
function workspaceFolders() {
  const homePath = (path: string) => path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  const dir = process.env.MEMMY_AGENT_DATA_DIR || dirname(process.env.MEMMY_CONFIG || "~/.memmy/config.yaml");
  const file = join(homePath(dir), "webui", "projects.json");
  const result = new Map<string, string>();
  try {
    if (statSync(file).size > 8 * 1024 * 1024) return result;
    const registry = JSON.parse(readFileSync(file, "utf8"));
    for (const p of registry.projects) {
      if (p?.state === "active" && typeof p.id === "string" && typeof p.root_path === "string" && isAbsolute(p.root_path)) {
        result.set(p.id, canonical(p.root_path));
      }
    }
  } catch { /* A standalone installation may have no workspace registry. */ }
  return result;
}

export class ProjectMemoryScope {
  constructor(private db: DatabaseSync) {}

  bindings(account: string, project: string) {
    const rows = this.db.prepare("SELECT kind, location FROM project_memory_bindings WHERE account=? AND project=? ORDER BY location").all(account, project);
    const locations = (kind: string) => rows.filter(row => row.kind === kind).map(row => String(row.location));
    return { project_id: project, workspace_ids: locations("workspace"), folder_paths: locations("folder") };
  }

  replace(account: string, project: string, workspaces: string[], folders: string[]) {
    const requested = { workspace: new Set(workspaces), folder: new Set(folders.map(canonical)) };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare("SELECT binding_id, kind, location FROM project_memory_bindings WHERE account=? AND project=?").all(account, project);
      for (const row of rows) {
        if (!requested[row.kind as keyof typeof requested].has(String(row.location))) {
          this.db.prepare("DELETE FROM project_memory_bindings WHERE binding_id=?").run(Number(row.binding_id));
        }
      }
      const insert = this.db.prepare("INSERT OR IGNORE INTO project_memory_bindings(account,project,kind,location) VALUES(?,?,?,?)");
      for (const [kind, values] of Object.entries(requested)) for (const value of values) insert.run(account, project, kind, value);
      if (!workspaces.length && !folders.length) this.db.prepare("DELETE FROM project_memory_cache WHERE account=? AND project=?").run(account, project);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.bindings(account, project);
  }

  open(account: string, s: Session, firstTurn = false) {
    // Some hosts report their workspace on the first prompt, after session_start.
    if (!firstTurn && !s.cwd && !s.workspace_id && !s.workspace_roots?.length) return;
    const roots = !s.cwd && s.workspace_roots?.length ? [...new Set(s.workspace_roots.map(canonical))] : null;
    this.db.prepare("INSERT OR IGNORE INTO project_memory_sessions(account,source,conversation,workspace,folder,workspace_roots) VALUES(?,?,?,?,?,?)")
      .run(account, s.source, s.conversation_id, s.workspace_id ?? null, s.cwd ? canonical(s.cwd) : null, roots ? JSON.stringify(roots) : null);
  }

  private matches(account: string, s: Session) {
    const session = this.db.prepare("SELECT workspace,folder,workspace_roots FROM project_memory_sessions WHERE account=? AND source=? AND conversation=?")
      .get(account, s.source, s.conversation_id);
    if (!session) return [];
    const bindings = this.db.prepare("SELECT binding_id, project, kind, location FROM project_memory_bindings WHERE account=? ORDER BY project,binding_id").all(account);
    if (!bindings.length) return [];
    const folders: string[] = session.folder ? [String(session.folder)] : JSON.parse(String(session.workspace_roots ?? "[]"));
    const workspaceOnly = !folders.length && !!session.workspace;
    const registry = workspaceOnly || bindings.some(row => row.kind === "workspace") ? workspaceFolders() : undefined;
    if (workspaceOnly) {
      const root = registry?.get(String(session.workspace));
      if (root) folders.push(root);
    }
    return bindings.filter(row => {
      if (row.kind === "workspace" && session.workspace === row.location) return true;
      const folder = row.kind === "workspace" ? registry?.get(String(row.location)) : String(row.location);
      return folder && folders.some(cwd => contains(folder, cwd));
    });
  }

  projects(account: string, s: Session, turn?: string, start = false) {
    const matches = this.matches(account, s);
    if (!turn) return [...new Set(matches.map(row => String(row.project)))];
    const key = [account, s.source, s.conversation_id, turn];
    if (start) this.db.prepare("INSERT OR IGNORE INTO project_memory_turns(account,source,conversation,turn,bindings,started) VALUES(?,?,?,?,?,?)")
      .run(...key, JSON.stringify(matches.map(row => row.binding_id)), new Date().toISOString());
    const row = this.db.prepare("SELECT bindings FROM project_memory_turns WHERE account=? AND source=? AND conversation=? AND turn=?").get(...key);
    const snapshot = new Set<number>(row ? JSON.parse(String(row.bindings)) : []);
    return [...new Set(matches.filter(row => snapshot.has(Number(row.binding_id))).map(row => String(row.project)))];
  }

  markIndex(account: string, s: Session, needed: boolean) {
    this.db.prepare("UPDATE project_memory_sessions SET needs_index=? WHERE account=? AND source=? AND conversation=?")
      .run(Number(needed), account, s.source, s.conversation_id);
  }

  needsIndex(account: string, s: Session) {
    return !!this.db.prepare("SELECT needs_index FROM project_memory_sessions WHERE account=? AND source=? AND conversation=?")
      .get(account, s.source, s.conversation_id)?.needs_index;
  }
}
