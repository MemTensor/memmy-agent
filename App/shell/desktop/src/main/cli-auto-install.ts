import { posix } from "node:path";

/**
 * Where a packaged app may install its CLI.
 *
 * A disk image and App Translocation both vanish after the first look, so a symlink made there
 * would point nowhere once the person ejects the image or launches the real copy.
 */
export type BundledCliInstallDecision = "install" | "disk-image" | "translocated";

export function bundledCliInstallDecision(bundlePath: string): BundledCliInstallDecision {
  const normalized = bundlePath.replaceAll("\\", "/");
  if (normalized === "/Volumes" || normalized.startsWith("/Volumes/")) return "disk-image";
  if (normalized.includes("/AppTranslocation/")) return "translocated";
  return "install";
}

/** Commands a packaged Mac app puts on the user's PATH. */
export const PACKAGED_MAC_CLI_COMMANDS = ["memmy-memory", "memmy", "memmy-project"] as const;

/** Marker in the user-level launcher, so a later launch can replace its own script and nothing else. */
export const MEMMY_CLI_LAUNCHER_MARKER = "# Memmy CLI launcher";

/** Apple Silicon Homebrew's bin directory. It is already on the default PATH and is usually user-writable. */
export const HOMEBREW_CLI_BIN_DIRECTORY = "/opt/homebrew/bin";

/**
 * App bundles a user-level launcher may exec.
 *
 * The running bundle is first, including a disk image or a translocated copy, so the command works
 * during that launch. `/Applications` and `~/Applications` stay in the list: the script skips a
 * candidate that is not there, instead of leaving a symlink that breaks once the image is ejected.
 */
export function memmyCliAppCandidates(bundlePath: string, homeDirectory: string): string[] {
  const ordered = [
    bundlePath,
    "/Applications/Memmy.app",
    posix.join(homeDirectory, "Applications", "Memmy.app")
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of ordered) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const key = trimmed.replaceAll("\\", "/").replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

/** Renders the `~/.local/bin` launcher for one command. Paths are single-quoted for bash. */
export function renderMemmyCliLauncher(commandName: string, appPaths: string[]): string {
  if (!/^[a-z0-9-]+$/.test(commandName)) {
    throw new Error(`Invalid Memmy CLI name: ${commandName}`);
  }
  if (appPaths.length === 0) {
    throw new Error("Memmy CLI launcher needs at least one app path");
  }

  const searches = appPaths.map((appPath) => `search_app ${shellSingleQuote(appPath)} "$@"`).join("\n");
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    MEMMY_CLI_LAUNCHER_MARKER,
    "search_app() {",
    "  local app=\"$1\"",
    "  shift",
    "  local launcher=\"$app/Contents/Resources/cli/" + commandName + "\"",
    "  if [ -x \"$launcher\" ]; then",
    "    exec \"$launcher\" \"$@\"",
    "  fi",
    "}",
    searches,
    `echo ${shellSingleQuote(`${commandName}: 找不到 Memmy。请把 Memmy 放到「应用程序」后重新打开。`)} >&2`,
    "exit 127",
    ""
  ].join("\n");
}

export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Shell files that must mention ~/.local/bin. `.zshenv` is read by non-interactive zsh, which is
 * how an agent runs a command; `.zshrc` alone is only an interactive terminal.
 */
export const USER_CLI_SHELL_PROFILES = [".zshenv", ".zprofile", ".zshrc", ".bash_profile"] as const;

/** On the default macOS PATH, so a Dock-launched agent can run the command without a shell profile. */
export const SYSTEM_CLI_BIN_DIRECTORY = "/usr/local/bin";
