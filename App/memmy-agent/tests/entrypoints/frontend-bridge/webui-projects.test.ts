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
