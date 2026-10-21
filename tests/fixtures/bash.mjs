import { existsSync } from "node:fs";
import { join } from "node:path";

// WindowsApps may resolve "bash" to WSL, which cannot consume Windows fixture paths.
const gitBash = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
export const bash = process.platform === "win32" && existsSync(gitBash) ? gitBash : "bash";
