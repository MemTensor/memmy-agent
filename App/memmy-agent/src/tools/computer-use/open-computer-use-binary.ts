import { constants, accessSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

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
  if (!["arm64", "x64"].includes(arch)) return command;
  const cpu = arch === "x64" ? "amd64" : "arm64";
  const relative = platform === "darwin"
    ? ["dist", "Open Computer Use.app", "Contents", "MacOS", "OpenComputerUse"]
    : platform === "linux"
      ? ["dist", "linux", cpu, "open-computer-use"]
      : platform === "win32"
        ? ["dist", "windows", cpu, "open-computer-use.exe"]
        : null;
  if (!relative) return command;
  let root: string;
  try {
    root = options.packageRoot ?? path.dirname(require.resolve("open-computer-use/package.json"));
  } catch {
    return command;
  }
  const devBinary = (options.environment ?? process.env).MEMMY_DEV_COMPUTER_USE_BINARY;
  if (platform === "darwin" && devBinary && !/([\\/])app\.asar(?:\.unpacked)?([\\/])/.test(root)) {
    // dev-start installs the helper outside temporary worktrees so macOS can
    // resolve its permission identity. Never silently use the broken temp copy.
    if (!path.isAbsolute(devBinary)) throw new Error("MEMMY_DEV_COMPUTER_USE_BINARY must be an absolute path");
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
    return binary;
  } catch {
    // Source/CLI installs may still provide the command through PATH.
    return command;
  }
}
