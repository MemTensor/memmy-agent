import { constants, accessSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMemmyComputerUseServer } from "../../config/computer-use-server.js";
import { lockedMacUseEnabled } from "./locked-mac-use.js";

const retiredLegacyApps = new Set<string>();

/** A previous Memmy release left its LaunchServices app agent running after
 * the MCP client exited. Retire only agents launched from this very install.
 * An unrelated copy of Open Computer Use must remain untouched.
 */
function retireLegacyMacAppAgent(packageRoot: string): void {
  const legacyExecutable = legacyMacAppAgentExecutable(packageRoot);
  if (!legacyExecutable) return;
  if (retiredLegacyApps.has(legacyExecutable)) return;
  retiredLegacyApps.add(legacyExecutable);
  try {
    const processes = execFileSync('/bin/ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8', timeout: 3_000, maxBuffer: 4 * 1024 * 1024,
    });
    for (const pid of legacyMacAppAgentPids(processes, legacyExecutable)) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* Already exited. */ }
    }
  } catch { /* Cleanup must never block the new helper. */ }
}

export function legacyMacAppAgentExecutable(packageRoot: string): string | null {
  const resources = packageRoot.match(/^(.*\/Memmy\.app\/Contents\/Resources)\/app\.asar(?:\.unpacked)?\/dist\/runtime\/memmy-agent$/)?.[1];
  return resources ? path.join(resources, 'app.asar.unpacked', 'dist', 'runtime', 'memmy-agent',
    'node_modules', 'open-computer-use', 'dist', 'Open Computer Use.app', 'Contents', 'MacOS', 'OpenComputerUse') : null;
}

export function legacyMacAppAgentPids(processes: string, legacyExecutable: string): number[] {
  const commandPrefix = `${legacyExecutable} __open-computer-use-app-agent `;
  const pids: number[] = [];
  for (const line of processes.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (match && match[2].startsWith(commandPrefix) && /^\d+$/.test(match[1])) {
      const pid = Number(match[1]);
      if (Number.isSafeInteger(pid) && pid > 1) pids.push(pid);
    }
  }
  return pids;
}

/** Supply the OS desktop environment needed by the native backend. */
export function openComputerUseEnvironment(
  command: string,
  configured: Record<string, string> | null,
  platform = process.platform,
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> | null {
  if (command !== "open-computer-use") return configured;
  if (platform === "win32") {
    const systemRoot = inherited.SystemRoot ?? inherited.SYSTEMROOT ?? "C:\\Windows";
    const paths = configured?.PATH ?? configured?.Path ?? inherited.PATH ?? inherited.Path ?? "";
    const result = { ...configured };
    delete result.Path;
    result.PATH = [paths, path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0")].filter(Boolean).join(";");
    return result;
  }
  if (platform !== "linux") return configured;
  const session: Record<string, string> = {};
  for (const key of ["DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "AT_SPI_BUS_ADDRESS", "GDK_BACKEND"]) {
    const value = inherited[key];
    if (value !== undefined) session[key] = value;
  }
  return { ...session, ...configured };
}

/** Resolve only the default command; explicit user commands remain authoritative. */
export function resolveOpenComputerUseCommand(
  command: string,
  options: { platform?: string; arch?: string; packageRoot?: string; environment?: NodeJS.ProcessEnv } = {},
): string {
  if (command !== "open-computer-use") return command;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (!["arm64", "x64"].includes(arch)) {
    if (["darwin", "linux", "win32"].includes(platform)) throw new Error(`Memmy Computer Use does not support ${arch}`);
    return command;
  }
  const cpu = arch === "x64" ? "amd64" : "arm64";
  const relative = platform === "darwin"
    ? ["dist", "native-computer-use", "Memmy Computer Use.app", "Contents", "MacOS", "MemmyComputerUse"]
    : platform === "linux"
      ? ["dist", "native-computer-use", "linux", cpu, "memmy-computer-use"]
      : platform === "win32"
        ? ["dist", "native-computer-use", "windows", cpu, "memmy-computer-use.exe"]
        : null;
  if (!relative) return command;
  const root = options.packageRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const devBinary = (options.environment ?? process.env).MEMMY_DEV_COMPUTER_USE_BINARY;
  if (platform === "darwin" && devBinary && !/([\\/])app\.asar(?:\.unpacked)?([\\/])/.test(root)) {
    // dev-start installs the helper outside temporary worktrees so macOS can
    // resolve the shared Memmy permission identity. Never silently use the broken temp copy.
    if (!path.isAbsolute(devBinary)) throw new Error("MEMMY_DEV_COMPUTER_USE_BINARY must be an absolute path");
    const devApp = path.dirname(path.dirname(path.dirname(devBinary)));
    if (path.basename(devApp) !== 'Memmy Computer Use.app' || path.basename(devBinary) !== 'MemmyComputerUse')
      throw new Error('Development Computer Use binary must be inside Memmy Computer Use.app');
    try {
      accessSync(devBinary, constants.X_OK);
    } catch {
      throw new Error(`Development Computer Use helper is missing: ${devBinary}. Run scripts/dev-start.sh again.`);
    }
    return devBinary;
  }
  try {
    // child_process.spawn needs an actual disk path, including in Electron's Node mode.
    const binary = path.join(root, ...relative).replace(/([\\/])app\.asar([\\/])/g, "$1app.asar.unpacked$2");
    accessSync(binary, platform === "win32" ? constants.F_OK : constants.X_OK);
    if (platform === 'darwin') retireLegacyMacAppAgent(root);
    return binary;
  } catch {
    throw new Error("Memmy Computer Use native runtime is missing; reinstall Memmy");
  }
}

/** Only Memmy's bundled preset may use this native CLI and permission contract. */
export function isManagedOcuConfig(name: string, cfg: any, platform = process.platform): boolean {
  const env = cfg.env ?? {};
  return (platform === 'darwin' || platform === 'win32') && isMemmyComputerUseServer(name)
    && (!cfg.type || cfg.type === 'stdio') && (!cfg.transport || cfg.transport === 'stdio')
    && cfg.command === 'open-computer-use' && JSON.stringify(cfg.args) === '["mcp"]'
    && !('OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE' in env)
    && !('OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY' in env);
}
export function managedOcuEnvironment(binary: string, env: Record<string, string> | null,
  platform = process.platform): Record<string, string> {
  if (!(platform === 'win32' ? path.win32.isAbsolute(binary) : path.isAbsolute(binary)))
    throw new Error('Bundled Memmy Computer Use is missing; reinstall Memmy');
  // Windows launches the helper directly. The app-agent socket and macOS
  // pointer policy belong to the .app bundle and must not be applied here.
  if (platform === 'win32') return { ...env };
  const app = path.dirname(path.dirname(path.dirname(realpathSync(binary))));
  return {
    ...env,
    // The MCP stdio transport inherits only a small OS environment allowlist.
    // Start the lock-screen broker only after the user enables the settings
    // switch. macOS still performs its own signed-component checks.
    MEMMY_LOCKED_MAC_USE_ENABLED: process.env.MEMMY_DESKTOP_MANAGED_GATEWAY === '1'
      && lockedMacUseEnabled() ? '1' : '0',
    // The native helper's global fallback can move the real pointer and change foreground focus.
    // Keep it off unless the user explicitly opts in through this managed preset.
    OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS: env?.OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS ?? '0',
    OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE: `memmy:${app}`,
    OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY: '0',
  };
}
