import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createAntigravitySkillTarget } from "../adapters/outbound/skill-writer/antigravity/target.js";
import { createSkillTargetRegistry } from "../adapters/outbound/skill-writer/target-registry.js";
import { createSkillDistributionService } from "../services/skill-distribution-service.js";

const source = "antigravity";
let root: string;
let config: string;
let target: ReturnType<typeof createAntigravitySkillTarget>;
let service: ReturnType<typeof createSkillDistributionService>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "antigravity-lifecycle-"));
  config = join(root, "config");
  const appDirectory = join(root, "app");
  await mkdir(appDirectory);
  const memmyConfigPath = join(root, "memmy.yaml");
  await writeFile(memmyConfigPath, "{}");
  target = createAntigravitySkillTarget({ appDirectory, rootDirectory: config, memmyConfigPath });
  service = createSkillDistributionService({ targetRegistry: createSkillTargetRegistry([target]) });
});
afterEach(async () => rm(root, { recursive: true, force: true }));

it("removes the standalone memory skill and plugin on disconnect, preserving other files", async () => {
  const skillDirectory = join(config, "skills", "memmy-memory");
  const userSkill = join(config, "skills", "my-skill");
  const userHook = join(config, "plugins", "my-plugin");
  for (const directory of [userSkill, userHook]) await mkdir(directory, { recursive: true });
  await writeFile(join(userSkill, "SKILL.md"), "my skill");
  await writeFile(join(userHook, "hooks.json"), "{}");
  await service.install(source);
  await writeFile(join(skillDirectory, "notes.txt"), "my notes");
  await service.installPlugin(source);
  expect(await target.isPluginInstalled!()).toBe(true);
  await service.uninstallPlugin(source);
  await service.uninstallPlugin(source);
  expect(await service.readInstallationState!(source)).toEqual({ skillInstalled: false, pluginInstalled: false });
  expect(await readdir(skillDirectory)).toEqual(["notes.txt"]);
  expect(await readFile(join(userSkill, "SKILL.md"), "utf8")).toBe("my skill");
  expect(await readFile(join(userHook, "hooks.json"), "utf8")).toBe("{}");
});

it("rolls a failed conversion back to the exact prior standalone skill", async () => {
  await service.install(source);
  const skillFile = join(config, "skills", "memmy-memory", "SKILL.md");
  const previous = await readFile(skillFile, "utf8") + "\nLocal instructions.\n";
  await writeFile(skillFile, previous);
  const before = await service.readInstallationState!(source);
  await service.installPlugin(source);
  await service.rollbackInstallation!(source, "plugin", before);
  expect(await service.readInstallationState!(source)).toEqual({ skillInstalled: true, pluginInstalled: false });
  expect(await readFile(skillFile, "utf8")).toBe(previous);
});

it("leaves a different skill using the same directory name under user management", async () => {
  const directory = join(config, "skills", "memmy-memory");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), "A personal skill.");
  await service.installPlugin(source);
  await service.uninstallPlugin(source);
  expect(await readFile(join(directory, "SKILL.md"), "utf8")).toBe("A personal skill.");
  expect(await service.readInstallationState!(source)).toEqual({ skillInstalled: false, pluginInstalled: false });
});

it("refreshes only the owned standalone file and skips externally managed skills", async () => {
  const directory = join(config, "skills", "memmy-memory");
  const skillFile = join(directory, "SKILL.md");
  await service.install(source);
  const current = await readFile(skillFile, "utf8");
  const stale = current + "\nStale managed instructions.\n";
  await writeFile(skillFile, stale);
  await writeFile(join(directory, "notes.txt"), "personal notes");

  expect(await service.refreshInstalledSkill(source)).toBe(true);
  expect(await readFile(skillFile, "utf8")).toBe(current);
  expect(await readFile(join(directory, "notes.txt"), "utf8")).toBe("personal notes");
  expect(await target.isPluginInstalled!()).toBe(false);

  const managed = join(root, "managed-skills");
  await rename(join(config, "skills"), managed);
  await symlink(managed, join(config, "skills"), "junction");
  await writeFile(join(managed, "memmy-memory", "SKILL.md"), stale);
  expect(await service.refreshInstalledSkill(source)).toBe(false);
  expect(await readFile(skillFile, "utf8")).toBe(stale);
});

it.each(["plugins", "memmy-project-context"])("leaves externally managed %s linked and removes a locally owned project hook", async link => {
  const directory = join(config, "plugins", "memmy-project-context");
  const managed = join(root, "managed-project-plugin");
  await target.installProjectHook!();
  expect(await target.isProjectHookInstalled!()).toBe(true);
  expect(await target.isProjectHookCurrent!()).toBe(true);
  const entry = link === "plugins" ? join(config, "plugins") : directory;
  await rename(entry, managed);
  await symlink(managed, entry, "junction");
  expect(await target.isProjectHookInstalled!()).toBe(false);
  expect(await target.isProjectHookCurrent!()).toBe(false);
  await expect(target.installProjectHook!()).rejects.toThrow("already in use");
  const revoked = createSkillDistributionService({
    targetRegistry: createSkillTargetRegistry([target]),
    projectSkillPermission: async () => ({ granted: false, disabledAgents: [] })
  });
  const before = await readdir(directory);
  expect(await revoked.syncProjectHooks!()).toEqual([]);
  await target.uninstallProjectHook!();
  expect((await lstat(entry)).isSymbolicLink()).toBe(true);
  expect(await readdir(directory)).toEqual(before);
  await rm(entry);
  await rename(managed, entry);
  expect(await revoked.syncProjectHooks!()).toEqual([source]);
  expect(await target.isProjectHookInstalled!()).toBe(false);
  await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("leaves externally managed skill and plugin collections to their owner", async () => {
  await service.install(source);
  await service.installPlugin(source);
  for (const collection of ["skills", "plugins"]) {
    const directory = join(config, collection);
    const managed = join(root, collection);
    await rename(directory, managed);
    await symlink(managed, directory, "junction");
  }
  expect(await service.readInstallationState!(source)).toEqual({ skillInstalled: false, pluginInstalled: false });
  await service.uninstallPlugin(source);
  expect(await readFile(join(root, "skills", "memmy-memory", "SKILL.md"), "utf8")).toContain("Memmy Memory CLI Skill");
  expect(await readFile(join(root, "plugins", "memmy-memory", "plugin.json"), "utf8")).toContain("MemTensor");
  await expect(service.install(source)).rejects.toThrow("already in use");
  await expect(service.installPlugin(source)).rejects.toThrow("already in use");
});
