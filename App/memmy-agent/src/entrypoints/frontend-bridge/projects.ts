import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as lockfile from "proper-lockfile";
import { getWebuiDir } from "../../config/paths.js";

const MAX_PROJECTS_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PROJECTS = 100;
const MAX_PROJECT_NAME_LENGTH = 160;
const MAX_PROJECT_PATH_LENGTH = 4_096;
const PROJECT_STATES = new Set(["active", "deleting"]);
const PROJECT_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

export type WebuiProject = {
  id: string;
  name: string;
  rootPath: string;
  pinned: boolean;
  createdAt: string;
};

type StoredWebuiProject = {
  id: string;
  name: string;
  root_path: string;
  pinned: boolean;
  state: "active" | "deleting";
  created_at: string;
};

export type WebuiProjectRegistrySnapshot = {
  state: "ready" | "corrupt";
  projects: WebuiProject[];
};

export type WebuiProjectRegistrationMode = "blank" | "existing";

export type WebuiSessionTarget =
  | { kind: "standalone" }
  | { kind: "project"; projectId: string };

export class WebuiProjectError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message = code) {
    super(message);
    this.name = "WebuiProjectError";
    this.code = code;
    this.status = status;
  }
}

type ProjectStoreOptions = {
  filePath?: string;
};

function parseIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function normalizeStoredRoot(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_PROJECT_PATH_LENGTH) {
    return null;
  }
  if (!path.isAbsolute(value)) return null;
  const normalized = path.resolve(value);
  return normalized === value ? normalized : null;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length >= 1 && name.length <= MAX_PROJECT_NAME_LENGTH ? name : null;
}

function parseStoredProject(value: unknown): StoredWebuiProject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["id", "name", "root_path", "pinned", "state", "created_at"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return null;
  const id = isUuid(raw.id) ? raw.id : null;
  const name = normalizeName(raw.name);
  const rootPath = normalizeStoredRoot(raw.root_path);
  const pinned = typeof raw.pinned === "boolean" ? raw.pinned : null;
  const state = typeof raw.state === "string" && PROJECT_STATES.has(raw.state)
    ? raw.state as StoredWebuiProject["state"]
    : null;
  const createdAt = parseIsoDate(raw.created_at);
  if (!id || !name || !rootPath || pinned == null || !state || !createdAt) return null;
  return {
    id,
    name,
    root_path: rootPath,
    pinned,
    state,
    created_at: createdAt,
  };
}

function publicProject(project: StoredWebuiProject): WebuiProject {
  return {
    id: project.id,
    name: project.name,
    rootPath: project.root_path,
    pinned: project.pinned,
    createdAt: project.created_at,
  };
}

function compareStoredProjects(left: StoredWebuiProject, right: StoredWebuiProject): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  return left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id);
}

function fsyncDirectoryBestEffort(directory: string): void {
  if (process.platform === "win32") return;
  let fd: number | null = null;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch {
    // The payload file has already been fsynced. Some filesystems reject directory fsync.
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function canonicalDirectory(rawPath: string, { rejectRoot }: { rejectRoot: boolean }): string {
  if (typeof rawPath !== "string" || rawPath.length < 1 || rawPath.length > MAX_PROJECT_PATH_LENGTH) {
    throw new WebuiProjectError("project_path_invalid", 400);
  }
  const expanded = rawPath === "~" || rawPath.startsWith("~/")
    ? path.join(process.env.HOME ?? "", rawPath.slice(2))
    : rawPath;
  if (!path.isAbsolute(expanded)) {
    throw new WebuiProjectError("project_path_invalid", 400);
  }
  let canonical: string;
  let stat: fs.Stats;
  try {
    canonical = fs.realpathSync(path.resolve(expanded));
    stat = fs.statSync(canonical);
    fs.accessSync(canonical, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    throw new WebuiProjectError("project_directory_unavailable", 422);
  }
  if (!stat.isDirectory()) {
    throw new WebuiProjectError("project_directory_unavailable", 422);
  }
  if (rejectRoot && canonical === path.parse(canonical).root) {
    throw new WebuiProjectError("project_path_invalid", 400);
  }
  if (canonical.length > MAX_PROJECT_PATH_LENGTH) {
    throw new WebuiProjectError("project_path_invalid", 400);
  }
  return canonical;
}

export function assertWebuiWorkspaceAvailable(rawPath: string): string {
  return canonicalDirectory(rawPath, { rejectRoot: false });
}

export class ProjectStore {
  readonly filePath: string;
  private state: "ready" | "corrupt" = "ready";
  private projects: StoredWebuiProject[] = [];
  private mutating = false;
  private readonly lockTarget: string;

  constructor(options: ProjectStoreOptions = {}) {
    this.filePath = path.resolve(options.filePath ?? path.join(getWebuiDir(), "projects.json"));
    this.lockTarget = `${this.filePath}.target`;
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.state = "ready";
      this.projects = [];
      return;
    }
    try {
      const stat = fs.statSync(this.filePath);
      if (!stat.isFile() || stat.size > MAX_PROJECTS_FILE_BYTES) throw new Error("invalid projects file");
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid projects file");
      const keys = Object.keys(parsed as Record<string, unknown>);
      if (keys.length !== 1 || keys[0] !== "projects") throw new Error("invalid projects file");
      const rawProjects = (parsed as Record<string, unknown>).projects;
      if (!Array.isArray(rawProjects) || rawProjects.length > MAX_PROJECTS) throw new Error("invalid projects file");
      const projects = rawProjects.map(parseStoredProject);
      if (projects.some((project) => project == null)) throw new Error("invalid projects file");
      const typed = projects as StoredWebuiProject[];
      const ids = new Set(typed.map((project) => project.id));
      const roots = new Set(typed.map((project) => project.root_path));
      if (ids.size !== typed.length || roots.size !== typed.length) throw new Error("invalid projects file");
      this.projects = typed;
      this.state = "ready";
    } catch {
      this.projects = [];
      this.state = "corrupt";
    }
  }

  private assertReady(): void {
    if (this.state !== "ready") {
      throw new WebuiProjectError("project_registry_corrupt", 503);
    }
  }

  private runMutation<T>(operation: () => T): T {
    if (this.mutating) {
      throw new WebuiProjectError("project_mutation_conflict", 409);
    }
    fs.mkdirSync(path.dirname(this.lockTarget), { recursive: true });
    if (!fs.existsSync(this.lockTarget)) fs.closeSync(fs.openSync(this.lockTarget, "a"));
    let release: (() => void) | null = null;
    const deadline = Date.now() + 10_000;
    while (!release) {
      try {
        release = lockfile.lockSync(this.lockTarget, {
          realpath: false,
          stale: 10_000,
          update: 2_000,
        });
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException)?.code !== "ELOCKED"
          || Date.now() >= deadline
        ) {
          throw error;
        }
        Atomics.wait(PROJECT_LOCK_SLEEP, 0, 0, 20);
      }
    }
    this.mutating = true;
    try {
      this.load();
      this.assertReady();
      return operation();
    } finally {
      this.mutating = false;
      release();
    }
  }

  private write(projects: StoredWebuiProject[]): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const tempPath = `${this.filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    const encoded = `${JSON.stringify({ projects }, null, 2)}\n`;
    let fd: number | null = null;
    try {
      fd = fs.openSync(tempPath, "wx");
      fs.writeFileSync(fd, encoded, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tempPath, this.filePath);
      fsyncDirectoryBestEffort(directory);
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    }
  }

  snapshot(): WebuiProjectRegistrySnapshot {
    if (!this.mutating) this.load();
    if (this.state === "corrupt") return { state: "corrupt", projects: [] };
    return {
      state: "ready",
      projects: this.projects
        .filter((project) => project.state === "active")
        .sort(compareStoredProjects)
        .map(publicProject),
    };
  }

  listActive(): WebuiProject[] {
    this.assertReady();
    return this.snapshot().projects;
  }

  getActive(id: string): WebuiProject | null {
    if (!this.mutating) this.load();
    this.assertReady();
    const project = this.projects.find((item) => item.id === id && item.state === "active");
    return project ? publicProject(project) : null;
  }

  isDeleting(id: string): boolean {
    if (!this.mutating) this.load();
    this.assertReady();
    return this.projects.some((project) => project.id === id && project.state === "deleting");
  }

  add(rawPath: string, mode: WebuiProjectRegistrationMode, name?: string): WebuiProject {
    return this.runMutation(() => {
      if (mode !== "blank" && mode !== "existing") {
        throw new WebuiProjectError("project_request_invalid", 400);
      }
      const rootPath = canonicalDirectory(rawPath, { rejectRoot: true });
      const existing = this.projects.find((project) => project.root_path === rootPath);
      if (existing?.state === "deleting") {
        throw new WebuiProjectError("project_deleting", 409);
      }
      if (existing) return publicProject(existing);
      if (this.projects.length >= MAX_PROJECTS) {
        throw new WebuiProjectError("project_limit_reached", 409);
      }
      if (mode === "blank" && fs.readdirSync(rootPath).length > 0) {
        throw new WebuiProjectError("project_directory_not_empty", 409);
      }
      const projectName = name == null ? normalizeName(path.basename(rootPath)) : normalizeName(name);
      if (!projectName) {
        throw new WebuiProjectError("project_name_invalid", 400);
      }
      const project: StoredWebuiProject = {
        id: crypto.randomUUID(),
        name: projectName,
        root_path: rootPath,
        pinned: false,
        state: "active",
        created_at: new Date().toISOString(),
      };
      const next = [...this.projects, project];
      this.write(next);
      this.projects = next;
      return publicProject(project);
    });
  }

  resolveOrRegisterExisting<T>(
    rawPath: string,
    operation: (project: WebuiProject) => T,
  ): T {
    return this.runMutation(() => {
      const rootPath = canonicalDirectory(rawPath, { rejectRoot: true });
      const existing = this.projects.find((project) => project.root_path === rootPath);
      if (existing?.state === "deleting") {
        throw new WebuiProjectError("project_deleting", 409);
      }
      if (existing) return operation(publicProject(existing));
      if (this.projects.length >= MAX_PROJECTS) {
        throw new WebuiProjectError("project_limit_reached", 409);
      }
      const projectName = normalizeName(path.basename(rootPath));
      if (!projectName) throw new WebuiProjectError("project_name_invalid", 400);
      const project: StoredWebuiProject = {
        id: crypto.randomUUID(),
        name: projectName,
        root_path: rootPath,
        pinned: false,
        state: "active",
        created_at: new Date().toISOString(),
      };
      const before = [...this.projects];
      const next = [...before, project];
      this.write(next);
      this.projects = next;
      try {
        return operation(publicProject(project));
      } catch (error) {
        this.write(before);
        this.projects = before;
        throw error;
      }
    });
  }

  rename(id: string, rawName: string): WebuiProject {
    return this.runMutation(() => {
      const name = normalizeName(rawName);
      if (!name) throw new WebuiProjectError("project_name_invalid", 400);
      const index = this.projects.findIndex((project) => project.id === id);
      if (index < 0) throw new WebuiProjectError("project_not_found", 404);
      const current = this.projects[index];
      if (current.state === "deleting") throw new WebuiProjectError("project_deleting", 409);
      if (current.name === name) return publicProject(current);
      const updated = { ...current, name };
      const next = [...this.projects];
      next[index] = updated;
      this.write(next);
      this.projects = next;
      return publicProject(updated);
    });
  }

  setPinned(id: string, pinned: boolean): WebuiProject {
    return this.runMutation(() => {
      if (typeof pinned !== "boolean") throw new WebuiProjectError("project_request_invalid", 400);
      const index = this.projects.findIndex((project) => project.id === id);
      if (index < 0) throw new WebuiProjectError("project_not_found", 404);
      const current = this.projects[index];
      if (current.state === "deleting") throw new WebuiProjectError("project_deleting", 409);
      if (current.pinned === pinned) return publicProject(current);
      const updated = { ...current, pinned };
      const next = [...this.projects];
      next[index] = updated;
      this.write(next);
      this.projects = next;
      return publicProject(updated);
    });
  }

  beginDeleting(id: string, beforeCommit: (projectId: string) => void): void {
    this.runMutation(() => {
      const index = this.projects.findIndex((project) => project.id === id);
      if (index < 0) throw new WebuiProjectError("project_not_found", 404);
      if (this.projects[index].state === "deleting") return;
      const previous = this.projects;
      const deleting = [...previous];
      deleting[index] = { ...deleting[index], state: "deleting" };
      this.projects = deleting;
      try {
        beforeCommit(id);
        this.write(deleting);
      } catch (error) {
        this.projects = previous;
        throw error;
      }
    });
  }

  finishDeleting(id: string): void {
    this.runMutation(() => {
      const project = this.projects.find((item) => item.id === id);
      if (!project) return;
      if (project.state !== "deleting") {
        throw new WebuiProjectError("project_mutation_conflict", 409);
      }
      const next = this.projects.filter((item) => item.id !== id);
      this.write(next);
      this.projects = next;
    });
  }

  async continuePendingDeletes(
    removeProjectSessions: (projectId: string) => Promise<void>,
  ): Promise<void> {
    this.assertReady();
    const deletingIds = this.projects
      .filter((project) => project.state === "deleting")
      .map((project) => project.id);
    for (const projectId of deletingIds) {
      await removeProjectSessions(projectId);
      this.finishDeleting(projectId);
    }
  }
}
