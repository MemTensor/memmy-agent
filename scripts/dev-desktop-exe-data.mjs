/** Launches the desktop dev stack against the installed exe data home. */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Installed Windows builds keep runtime data next to the install drive
 * (`<drive>\MemmyData\.memmy`), recorded by the installer in
 * `%LOCALAPPDATA%\Memmy\data-layout\last-install.json`. Unpackaged desktop
 * normally falls back to `~/.memmy`; this launcher overrides that so the dev
 * UI, Memory service, config, and workspace match the installed exe.
 */
function resolveExeHome() {
  if (process.env.MEMMY_EXE_HOME?.trim()) {
    return process.env.MEMMY_EXE_HOME.trim();
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim()
      || join(homedir(), "AppData", "Local");
    const recordPath = join(localAppData, "Memmy", "data-layout", "last-install.json");
    if (existsSync(recordPath)) {
      try {
        const record = JSON.parse(readFileSync(recordPath, "utf8"));
        if (typeof record.runtimeHomePath === "string" && record.runtimeHomePath.trim()) {
          return record.runtimeHomePath.trim();
        }
      } catch {
        // Fall through to the conventional non-C: install layout.
      }
    }

    for (const candidate of ["D:\\MemmyData\\.memmy", "C:\\MemmyData\\.memmy"]) {
      if (existsSync(join(candidate, "config.yaml"))) {
        return candidate;
      }
    }
  }

  return join(homedir(), ".memmy");
}

const exeHome = resolveExeHome();
const exeConfig = join(exeHome, "config.yaml");
if (!existsSync(exeConfig)) {
  console.error(`[dev-desktop-exe] Memmy config not found: ${exeConfig}`);
  console.error("Set MEMMY_EXE_HOME to the installed exe data home (e.g. D:\\MemmyData\\.memmy).");
  process.exit(1);
}

const env = {
  ...process.env,
  MEMMY_HOME: exeHome,
  MEMMY_CONFIG: exeConfig,
  // Vite's runtime-config middleware reads this to reach the local API.
  MEMMY_RUNTIME_CONFIG_PATH: join(exeHome, "runtime.json")
};

console.log(`[dev-desktop-exe] MEMMY_HOME=${exeHome}`);
console.log(`[dev-desktop-exe] MEMMY_CONFIG=${exeConfig}`);
console.log(`[dev-desktop-exe] MEMMY_RUNTIME_CONFIG_PATH=${env.MEMMY_RUNTIME_CONFIG_PATH}`);
console.log("[dev-desktop-exe] Starting npm run dev:desktop …");

const child = spawn("npm", ["run", "dev:desktop"], {
  env,
  stdio: "inherit",
  shell: process.platform === "win32"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
