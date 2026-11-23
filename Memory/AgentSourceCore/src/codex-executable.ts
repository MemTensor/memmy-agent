import { accessSync, constants, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface ResolveCodexExecutableOptions {
  codexHomeDirectory: string;
  executable?: string;
  platform?: NodeJS.Platform;
  architecture?: string;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}

/** Resolve an absolute CLI path without relying on a desktop process's shell. */
export function resolveCodexExecutable(options: ResolveCodexExecutableOptions): string {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const paths = platform === "win32" ? win32 : posix;
  const home = options.homeDirectory ?? homedir();
  const environment = options.environment ?? process.env;
  const env = (name: string): string | undefined => {
    const key = platform === "win32"
      ? Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
      : name;
    return key ? environment[key]?.trim() : undefined;
  };
  const executableName = platform === "win32" ? "codex.exe" : "codex";
  const isFile = (file: string): boolean => {
    try {
      accessSync(file, platform === "win32" ? constants.F_OK : constants.X_OK);
      return statSync(file).isFile();
    } catch { return false; }
  };
  const canonical = (file: string): string => {
    try { return realpathSync(file); } catch { return file; }
  };

  // npm's Windows entry point is a .cmd shim, and Unix shims may need a Node
  // executable absent from a GUI PATH. Launch the package's native CLI instead.
  const fromPackage = (packageRoot: string): string | undefined => {
    const cpu = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : undefined;
    const target = platform === "win32" ? "pc-windows-msvc" : platform === "darwin" ? "apple-darwin" : "unknown-linux-musl";
    if (!cpu) return undefined;
    const root = canonical(packageRoot);
    const packageName = `codex-${platform}-${architecture}`;
    const roots = [
      paths.join(root, "node_modules", "@openai", packageName),
      paths.join(paths.dirname(root), packageName),
      root
    ];
    for (const candidateRoot of roots) {
      for (const binDirectory of ["bin", "codex"]) {
        const candidate = paths.join(candidateRoot, "vendor", `${cpu}-${target}`, binDirectory, executableName);
        if (isFile(candidate)) return canonical(candidate);
      }
    }
    return undefined;
  };
  const fromFile = (file: string): string | undefined => {
    if (!paths.isAbsolute(file)) return undefined;
    const resolved = canonical(file);
    if (/\.(cmd|bat|ps1)$/i.test(file)) {
      return fromPackage(paths.join(paths.dirname(file), "node_modules", "@openai", "codex"));
    }
    if (/\.[cm]?js$/i.test(resolved)) {
      return paths.basename(resolved) === "codex.js"
        ? fromPackage(paths.dirname(paths.dirname(resolved))) : undefined;
    }
    return isFile(resolved) ? resolved : undefined;
  };
  const fromBin = (directory: string): string | undefined => {
    if (!paths.isAbsolute(directory)) return undefined;
    return fromFile(paths.join(directory, executableName))
      ?? fromPackage(paths.join(directory, "node_modules", "@openai", "codex"))
      ?? fromPackage(paths.join(directory, "..", "lib", "node_modules", "@openai", "codex"));
  };
  const unquote = (value: string) => value.replace(/^"(.*)"$/, "$1");
  const explicit = options.executable?.trim() || env("MEMMY_CODEX_EXECUTABLE") || env("CODEX_CLI_PATH");
  if (explicit) {
    const executable = fromFile(unquote(explicit));
    if (executable) return executable;
    throw new Error("The configured Codex executable is unavailable. Set MEMMY_CODEX_EXECUTABLE to an absolute Codex CLI path (not the desktop application).");
  }

  const plugin = fromFile(paths.join(options.codexHomeDirectory, "plugins", ".plugin-appserver", executableName));
  if (plugin) return plugin;
  for (const directory of (env("PATH") ?? "").split(paths.delimiter)) {
    const executable = fromBin(unquote(directory.trim()));
    if (executable) return executable;
  }
  if (platform === "darwin") {
    for (const directory of ["/Applications", paths.join(home, "Applications")]) {
      for (const app of ["ChatGPT.app", "Codex.app"]) {
        const resources = paths.join(directory, app, "Contents", "Resources");
        for (const relative of [
          "codex-cli/CodexCLI.app/Contents/MacOS/codex",
          "codex-cli/bin/codex", "codex", "bin/codex"
        ]) {
          const executable = fromFile(paths.join(resources, relative));
          if (executable) return executable;
        }
      }
    }
  }
  if (platform === "win32") {
    const localAppData = env("LOCALAPPDATA") || paths.join(home, "AppData", "Local");
    // Store installations materialize runnable binaries here; WindowsApps
    // binaries can be application-protected and cannot be spawned directly.
    const cache = paths.join(localAppData, "OpenAI", "Codex", "bin");
    for (const directory of [cache, ...newestSubdirectories(cache, paths.join)]) {
      const executable = fromBin(directory);
      if (executable) return executable;
    }
    for (const directory of [paths.join(localAppData, "Programs"), env("ProgramFiles")].filter((value): value is string => Boolean(value))) {
      for (const app of ["Codex", "ChatGPT"]) {
        for (const resources of ["resources", "app/resources"]) {
          const executable = fromFile(paths.join(directory, app, resources, executableName));
          if (executable) return executable;
        }
      }
    }
  }
  const commonBins = platform === "win32"
    ? [paths.join(env("APPDATA") || paths.join(home, "AppData", "Roaming"), "npm")]
    : [paths.join(home, ".local", "bin"), paths.join(home, ".npm-global", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const directory of commonBins) {
    const executable = fromBin(directory);
    if (executable) return executable;
  }
  throw new Error("Codex sessions were found, but the Codex CLI executable could not be located. Start Codex once, or set MEMMY_CODEX_EXECUTABLE to its absolute CLI path and restart Memmy.");
}

/** Inspect only the runtime cache's immediate children, never the whole disk. */
function newestSubdirectories(root: string, join: (...parts: string[]) => string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const directory = join(root, entry.name);
        try { return { directory, modified: statSync(directory).mtimeMs }; }
        catch { return { directory, modified: 0 }; }
      })
      .sort((left, right) => right.modified - left.modified || left.directory.localeCompare(right.directory))
      .slice(0, 64)
      .map((entry) => entry.directory);
  } catch { return []; }
}
