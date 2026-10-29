import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  MEMMY_RESUME_SKILL_DIRECTORY_NAME,
  MEMMY_SKILL_DIRECTORY_NAME,
  renderMemmyResumeSkillFile,
  renderMemmySkillDirectoryFiles
} from "./templates/memmy-skill-directory.js";
import { MEMMY_PROJECT_SKILL_DIRECTORY_NAME, renderMemmyProjectSkillFile } from "./templates/memmy-project-skill.js";
import type { SkillManifest } from "./types.js";

export async function replaceMemmySkillDirectory(rootDirectory: string, manifest: SkillManifest): Promise<void> {
  const targetPath = join(rootDirectory, "skills", MEMMY_SKILL_DIRECTORY_NAME);
  await replaceDirectory(targetPath, renderMemmySkillDirectoryFiles(manifest));
}

export async function replaceMemmyResumeSkillDirectory(rootDirectory: string, source: string): Promise<void> {
  const targetPath = join(rootDirectory, "skills", MEMMY_RESUME_SKILL_DIRECTORY_NAME);
  await replaceDirectory(targetPath, [{ relativePath: "SKILL.md", content: renderMemmyResumeSkillFile(source) }]);
}

async function replaceDirectory(
  targetPath: string,
  files: Array<{ relativePath: string; content: string }>
): Promise<void> {
  const tempPath = temporarySiblingPath(targetPath);
  const backupPath = temporarySiblingPath(`${targetPath}.old`);

  await rm(tempPath, { recursive: true, force: true });
  await rm(backupPath, { recursive: true, force: true });
  await mkdir(tempPath, { recursive: true });
  for (const file of files) {
    const filePath = join(tempPath, file.relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, file.content, "utf8");
  }

  const hadExistingTarget = await pathExists(targetPath);
  try {
    if (hadExistingTarget) {
      await rename(targetPath, backupPath);
    }
    await rename(tempPath, targetPath);
    await rm(backupPath, { recursive: true, force: true });
  } catch (error) {
    await rm(tempPath, { recursive: true, force: true });
    if (hadExistingTarget && !(await pathExists(targetPath)) && await pathExists(backupPath)) {
      await rename(backupPath, targetPath);
    }
    throw error;
  }
}

export async function removeMemmySkillDirectory(rootDirectory: string): Promise<void> {
  await rm(join(rootDirectory, "skills", MEMMY_SKILL_DIRECTORY_NAME), { recursive: true, force: true });
}

/**
 * Whether the installed skill already matches this build's content. Lets a connected agent pick up new skill
 * instructions without being uninstalled and installed again.
 */
export async function isMemmySkillDirectoryCurrent(rootDirectory: string, manifest: SkillManifest): Promise<boolean> {
  const directory = join(rootDirectory, "skills", MEMMY_SKILL_DIRECTORY_NAME);
  for (const file of renderMemmySkillDirectoryFiles(manifest)) {
    const actual = await readFile(join(directory, file.relativePath), "utf8").catch(() => null);
    if (actual !== file.content) return false;
  }
  return true;
}

export async function removeMemmyResumeSkillDirectory(rootDirectory: string): Promise<void> {
  await rm(join(rootDirectory, "skills", MEMMY_RESUME_SKILL_DIRECTORY_NAME), { recursive: true, force: true });
}

/** Installs the `memmy-project` skill next to `memmy-memory`, as a skill of its own. */
export async function replaceMemmyProjectSkillDirectory(rootDirectory: string, source?: string): Promise<void> {
  const targetPath = join(rootDirectory, "skills", MEMMY_PROJECT_SKILL_DIRECTORY_NAME);
  await replaceDirectory(targetPath, [{ relativePath: "SKILL.md", content: renderMemmyProjectSkillFile(source) }]);
}

export async function removeMemmyProjectSkillDirectory(rootDirectory: string): Promise<void> {
  await rm(join(rootDirectory, "skills", MEMMY_PROJECT_SKILL_DIRECTORY_NAME), { recursive: true, force: true });
}

/** Whether the installed `memmy-project` skill matches this build; a missing one does not. */
export async function isMemmyProjectSkillDirectoryCurrent(rootDirectory: string, source?: string): Promise<boolean> {
  const actual = await readFile(join(rootDirectory, "skills", MEMMY_PROJECT_SKILL_DIRECTORY_NAME, "SKILL.md"), "utf8").catch(() => null);
  return actual === renderMemmyProjectSkillFile(source);
}

function temporarySiblingPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/**
 * Which kind of Memmy skill is installed, judged by its own text, so a refresh keeps the variant the agent was
 * set up with. `plugin` agents are driven by a hook; `skill` agents call the CLI themselves.
 */
export async function readInstalledSkillKind(rootDirectory: string): Promise<"skill" | "plugin" | null> {
  const content = await readFile(join(rootDirectory, "skills", MEMMY_SKILL_DIRECTORY_NAME, "SKILL.md"), "utf8").catch(() => null);
  if (content === null) return null;
  if (content.includes("## Automatic Memory")) return "plugin";
  if (content.includes("## Agent Loop")) return "skill";
  return null;
}
