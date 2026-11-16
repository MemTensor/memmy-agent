/** Folder names and directories a project's tasks run in, shared by the cloud and local project paths. */
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Creates `‹root›/<name>` for a project that did not choose a folder. When that name is taken it numbers the
 * folder the way a file manager names a new folder: `<name> 2`, `<name> 3`, and so on.
 *
 * <p>A name counts as taken when anything (a folder or a file) already uses it, compared without regard to case
 * or Unicode normalization: macOS volumes treat `MemOS` and `memos` as one name, and numbering the same way on
 * every platform keeps folder names predictable. The folder itself is created here, one level at a time, and a
 * name another caller created first moves on to the next number, so two projects created at once never share a
 * folder. Folders made before this rule (`<name>-<id>`) are left as they are; projects keep the path they stored.</p>
 */
export async function createProjectDirectory(root: string, name: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const taken = new Set((await readdir(root)).map(folded));
  // The cleaned name can end in a space where it was cut to length; the number goes after the visible name.
  const base = safeProjectDirectoryName(name);
  const stem = base.trimEnd();
  for (let number = 1; ; number += 1) {
    const candidate = number === 1 ? base : `${stem} ${number}`;
    if (taken.has(folded(candidate))) continue;
    const target = join(root, candidate);
    try {
      await mkdir(target);
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      taken.add(folded(candidate));
    }
  }
}

/**
 * A folder name people read in a task page and the project picker, so letters in any script survive; only
 * characters a filesystem or a shell would mind are replaced.
 */
export function safeProjectDirectoryName(value: string): string {
  const cleaned = value
    .replace(/[/\\:*?"<>|\u0000-\u001f]+/gu, "_")
    .replace(/^\.+/u, "")
    .trim()
    .slice(0, 60);
  return cleaned || "project";
}

/** Creates the folder when it is missing, and refuses a path that exists as a file. */
export async function ensureDirectory(target: string): Promise<string> {
  try {
    const info = await stat(target);
    if (!info.isDirectory()) throw new Error("not a directory");
  } catch {
    await mkdir(target, { recursive: true });
  }
  return target;
}

/** The form two folder names share when a case- and normalization-insensitive volume sees them as one. */
function folded(name: string): string {
  return name.normalize("NFC").toLowerCase();
}
