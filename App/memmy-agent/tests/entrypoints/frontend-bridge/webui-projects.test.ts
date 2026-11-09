import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProjectStore,
  WebuiProjectError,
} from "../../../src/entrypoints/frontend-bridge/projects.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-webui-projects-"));
  roots.push(root);
  return root;
}

function storeAt(root: string): ProjectStore {
  return new ProjectStore({ filePath: path.join(root, "webui", "projects.json") });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("ProjectStore", () => {
  it("gives a shared project its own record over a directory a local project already uses", () => {
    const root = tempRoot();
    const store = storeAt(root);
    const shared = path.join(root, "workspace");
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, "file.txt"), "x", "utf8");

    const local = store.add(shared, "existing", "本地项目");
    // Without the flag the folder resolves to the project that already owns it, which is what merges sessions.
    expect(store.add(shared, "existing", "协作项目")).toMatchObject({ id: local.id });

    const separate = store.add(shared, "existing", "协作项目", { allowShared: true });
    expect(separate.id).not.toBe(local.id);
    expect(separate.rootPath).toBe(local.rootPath);
    expect(separate.name).toBe("协作项目");
    // Both records survive, so each keeps its own sessions.
    expect(store.snapshot().projects.map((project) => project.id).sort()).toEqual([local.id, separate.id].sort());
  });

  it("loads a registry written by an earlier version without touching its projects", () => {
    const root = tempRoot();
    const filePath = path.join(root, "webui", "projects.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // The shape an earlier build wrote: one project per folder, every field present.
    const legacy = {
      projects: [
        { id: "11111111-1111-4111-8111-111111111111", name: "work", root_path: path.join(root, "work"), pinned: false, state: "active", created_at: "2026-01-01T00:00:00.000Z" },
        { id: "22222222-2222-4222-8222-222222222222", name: "notes", root_path: path.join(root, "notes"), pinned: true, state: "active", created_at: "2026-02-01T00:00:00.000Z" }
      ]
    };
    fs.writeFileSync(filePath, JSON.stringify(legacy), "utf8");

    const snapshot = new ProjectStore({ filePath }).snapshot();

    expect(snapshot.state).toBe("ready");
    // Nothing is dropped, renamed or re-pathed: an upgrade must not disturb existing projects.
    expect(snapshot.projects.map((project) => [project.id, project.name, project.rootPath, project.pinned])).toEqual([
      ["22222222-2222-4222-8222-222222222222", "notes", path.join(root, "notes"), true],
      ["11111111-1111-4111-8111-111111111111", "work", path.join(root, "work"), false]
    ]);
    expect(fs.readFileSync(filePath, "utf8")).toBe(JSON.stringify(legacy));
  });

  it("opens a registry that already repeats a folder instead of declaring it corrupt", () => {
    const root = tempRoot();
    const filePath = path.join(root, "webui", "projects.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const shared = path.join(root, "work");
    // An earlier build treated this as corruption and hid every project; it now loads, which only adds
    // tolerance: no existing project loses its sessions.
    fs.writeFileSync(filePath, JSON.stringify({
      projects: [
        { id: "33333333-3333-4333-8333-333333333333", name: "work", root_path: shared, pinned: false, state: "active", created_at: "2026-01-01T00:00:00.000Z" },
        { id: "44444444-4444-4444-8444-444444444444", name: "shared work", root_path: shared, pinned: false, state: "active", created_at: "2026-02-01T00:00:00.000Z" }
      ]
    }), "utf8");

    const snapshot = new ProjectStore({ filePath }).snapshot();

    expect(snapshot.state).toBe("ready");
    expect(snapshot.projects).toHaveLength(2);
  });

  it("resolves a shared folder to the project that already owned it, not the shared one", () => {
    const root = tempRoot();
    const store = storeAt(root);
    const shared = path.join(root, "workspace");
    fs.mkdirSync(shared, { recursive: true });

    const local = store.add(shared, "existing", "本地项目");
    store.add(shared, "existing", "协作项目", { allowShared: true });

    // Path-based callers (the CLI's --project, a folder opened by hand) must land on the local project: the
    // shared project owns only the sessions that were started from it.
    const resolved = store.resolveOrRegisterExisting(shared, (project) => project);
    expect(resolved.id).toBe(local.id);
  });

  it("registers existing directories and rejects non-empty blank directories", () => {
    const root = tempRoot();
    const existing = path.join(root, "existing");
    fs.mkdirSync(existing);
    fs.writeFileSync(path.join(existing, "README.md"), "present");
    const store = storeAt(root);

    expect(store.add(existing, "existing")).toMatchObject({
      name: "existing",
      rootPath: fs.realpathSync(existing),
      pinned: false,
    });
    expect(() => store.add(existing, "blank")).not.toThrow();

    const nonEmpty = path.join(root, "non-empty");
    fs.mkdirSync(nonEmpty);
    fs.writeFileSync(path.join(nonEmpty, "file.txt"), "present");
    expect(() => store.add(nonEmpty, "blank")).toThrowError(
      expect.objectContaining({ code: "project_directory_not_empty" }),
    );
  });

  it("is idempotent by canonical root while allowing duplicate display names", () => {
    const root = tempRoot();
    const firstRoot = path.join(root, "a", "same");
    const secondRoot = path.join(root, "b", "same");
    fs.mkdirSync(firstRoot, { recursive: true });
    fs.mkdirSync(secondRoot, { recursive: true });
    const store = storeAt(root);

    const first = store.add(firstRoot, "existing");
    const firstAgain = store.add(path.join(firstRoot, "."), "existing");
    const second = store.add(secondRoot, "existing");

    expect(firstAgain.id).toBe(first.id);
    expect(second.id).not.toBe(first.id);
    expect(second.name).toBe(first.name);
    expect(store.snapshot().projects).toHaveLength(2);
  });

  it("reuses a project registered through another store instance", () => {
    const root = tempRoot();
    const projectRoot = path.join(root, "project");
    fs.mkdirSync(projectRoot);
    const filePath = path.join(root, "projects.json");
    const firstStore = new ProjectStore({ filePath });
    const secondStore = new ProjectStore({ filePath });

    const first = firstStore.resolveOrRegisterExisting(projectRoot, (project) => project);
    const second = secondStore.resolveOrRegisterExisting(projectRoot, (project) => project);

    expect(second.id).toBe(first.id);
    expect(secondStore.snapshot().projects).toHaveLength(1);
  });

  it("rolls back a new project when terminal Session creation fails", () => {
    const root = tempRoot();
    const projectRoot = path.join(root, "project");
    fs.mkdirSync(projectRoot);
    const store = storeAt(root);

    expect(() => store.resolveOrRegisterExisting(projectRoot, () => {
      throw new Error("session save failed");
    })).toThrow("session save failed");
    expect(store.snapshot()).toEqual({ state: "ready", projects: [] });
  });

  it("renames and pins without changing identity, root, or creation time", () => {
    const root = tempRoot();
    const projectRoot = path.join(root, "project");
    fs.mkdirSync(projectRoot);
    const store = storeAt(root);
    const created = store.add(projectRoot, "existing");

    const renamed = store.rename(created.id, "Renamed");
    const pinned = store.setPinned(created.id, true);

    expect(renamed).toMatchObject({
      id: created.id,
      rootPath: created.rootPath,
      createdAt: created.createdAt,
      name: "Renamed",
    });
    expect(pinned).toMatchObject({
      id: created.id,
      rootPath: created.rootPath,
      createdAt: created.createdAt,
      name: "Renamed",
      pinned: true,
    });
  });

  it("fails closed without rewriting a corrupt registry", () => {
    const root = tempRoot();
    const filePath = path.join(root, "projects.json");
    const corrupt = "{\"projects\":[";
    fs.writeFileSync(filePath, corrupt);

    const store = new ProjectStore({ filePath });

    expect(store.snapshot()).toEqual({ state: "corrupt", projects: [] });
    expect(() => store.listActive()).toThrowError(
      expect.objectContaining({ code: "project_registry_corrupt" }),
    );
    expect(fs.readFileSync(filePath, "utf8")).toBe(corrupt);
  });

  it("persists deleting before cleanup and resumes deletion after restart", async () => {
    const root = tempRoot();
    const projectRoot = path.join(root, "project");
    fs.mkdirSync(projectRoot);
    const filePath = path.join(root, "projects.json");
    const store = new ProjectStore({ filePath });
    const project = store.add(projectRoot, "existing");
    const beforeCommit = vi.fn();

    store.beginDeleting(project.id, beforeCommit);

    expect(beforeCommit).toHaveBeenCalledWith(project.id);
    expect(store.snapshot().projects).toEqual([]);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8")).projects[0].state).toBe("deleting");

    const restarted = new ProjectStore({ filePath });
    const removeSessions = vi.fn(async () => undefined);
    await restarted.continuePendingDeletes(removeSessions);

    expect(removeSessions).toHaveBeenCalledWith(project.id);
    expect(restarted.snapshot()).toEqual({ state: "ready", projects: [] });
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({ projects: [] });
    expect(fs.existsSync(projectRoot)).toBe(true);
  });

  it("does not commit deleting when the reservation barrier rejects", () => {
    const root = tempRoot();
    const projectRoot = path.join(root, "project");
    fs.mkdirSync(projectRoot);
    const store = storeAt(root);
    const project = store.add(projectRoot, "existing");

    expect(() => store.beginDeleting(project.id, () => {
      throw new WebuiProjectError("project_mutation_conflict", 409);
    })).toThrowError(expect.objectContaining({ code: "project_mutation_conflict" }));
    expect(store.getActive(project.id)).toMatchObject({ id: project.id });
  });
});
