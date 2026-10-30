import { existsSync } from "node:fs";
import { join } from "node:path";

/** Windows shell tests need Git Bash, not the WSL bash shim or the caller's shell. */
export function resolveTestBash(): string {
  if (process.env.MEMMY_TEST_BASH) {
    if (!existsSync(process.env.MEMMY_TEST_BASH)) throw new Error("MEMMY_TEST_BASH does not exist");
    return process.env.MEMMY_TEST_BASH;
  }
  if (process.platform !== "win32") return "bash";
  const candidates = [
    join(process.env.ProgramW6432 ?? "C:/Program Files", "Git/bin/bash.exe"),
    join(process.env.ProgramFiles ?? "C:/Program Files", "Git/bin/bash.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Programs/Git/bin/bash.exe")
  ];
  const bash = candidates.find(existsSync);
  if (!bash) throw new Error("Install Git for Windows or set MEMMY_TEST_BASH to its bash.exe");
  return bash;
}
