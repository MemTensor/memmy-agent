import fs from "node:fs";
import path from "node:path";

const MAX_NAME_ATTEMPTS = 1000;

export function standaloneTaskWorkspaceName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("-");
}

export function createStandaloneTaskWorkspace(root: string, now: Date = new Date()): string {
  fs.mkdirSync(root, { recursive: true });
  const baseName = standaloneTaskWorkspaceName(now);
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = path.join(root, attempt === 1 ? baseName : `${baseName}-${attempt}`);
    try {
      fs.mkdirSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    return fs.realpathSync(candidate);
  }
  throw new Error(`no free task workspace name under ${root}`);
}
