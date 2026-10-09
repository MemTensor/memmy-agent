import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  MEMMY_RESUME_SKILL_DIRECTORY_NAME,
  MEMMY_SKILL_DIRECTORY_NAME,
  renderMemmyResumeSkillFile,
  renderMemmySkillDirectoryFiles
} from "./templates/memmy-skill-directory.js";
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

export async function removeMemmyResumeSkillDirectory(rootDirectory: string): Promise<void> {
  await rm(join(rootDirectory, "skills", MEMMY_RESUME_SKILL_DIRECTORY_NAME), { recursive: true, force: true });
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
