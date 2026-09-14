import { constants as fsConstants } from "node:fs";
import {
  access,
  appendFile,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ViewerCliOptions {
  home?: string;
  cliEntrypoint?: string;
  executable?: string;
  platform?: NodeJS.Platform;
}

export interface ViewerCliStatus {
  installed: boolean;
  path: string;
}

export interface ViewerCliInstallResult extends ViewerCliStatus {
  pathUpdated: boolean;
  profilePaths: string[];
}

const PROFILE_MARKER = "# Memmy CLI PATH";
const PROFILE_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

export async function viewerCliStatus(options: ViewerCliOptions = {}): Promise<ViewerCliStatus> {
  const paths = resolveViewerCliPaths(options);
  try {
    await access(paths.target, fsConstants.R_OK);
    return { installed: true, path: paths.displayPath };
  } catch {
    return { installed: false, path: paths.displayPath };
  }
}

export async function installViewerCli(options: ViewerCliOptions = {}): Promise<ViewerCliInstallResult> {
  const paths = resolveViewerCliPaths(options);
  await access(paths.cliEntrypoint, fsConstants.R_OK);
  await mkdir(dirname(paths.target), { recursive: true });
  await writeAtomic(paths.target, launcher(paths));
  if (paths.platform !== "win32") await chmod(paths.target, 0o755);

  const profilePaths = paths.platform === "win32"
    ? []
    : await updateShellProfiles(paths.home);
  return {
    installed: true,
    path: paths.displayPath,
    pathUpdated: profilePaths.length > 0,
    profilePaths,
  };
}

interface ViewerCliPaths {
  home: string;
  target: string;
  displayPath: string;
  cliEntrypoint: string;
  executable: string;
  platform: NodeJS.Platform;
}

function resolveViewerCliPaths(options: ViewerCliOptions): ViewerCliPaths {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const name = platform === "win32" ? "memmy-memory.cmd" : "memmy-memory";
  return {
    home,
    platform,
    target: join(home, ".local", "bin", name),
    displayPath: `~/.local/bin/${name}`,
    cliEntrypoint: options.cliEntrypoint
      ?? fileURLToPath(new URL("../cli/index.js", import.meta.url)),
    executable: options.executable ?? process.execPath,
  };
}

function launcher(paths: ViewerCliPaths): string {
  if (paths.platform === "win32") {
    return [
      "@echo off",
      "set ELECTRON_RUN_AS_NODE=1",
      `"${paths.executable}" "${paths.cliEntrypoint}" %*`,
      "",
    ].join("\r\n");
  }
  return [
    "#!/bin/sh",
    `exec env ELECTRON_RUN_AS_NODE=1 ${shellQuote(paths.executable)} ${shellQuote(paths.cliEntrypoint)} "$@"`,
    "",
  ].join("\n");
}

async function updateShellProfiles(home: string): Promise<string[]> {
  const profilePaths = [join(home, ".zshrc"), join(home, ".bash_profile")];
  const changed = await Promise.all(profilePaths.map(async (profilePath) => ({
    profilePath,
    changed: await ensureProfilePath(profilePath),
  })));
  return changed.filter((item) => item.changed).map((item) => item.profilePath);
}

async function ensureProfilePath(path: string): Promise<boolean> {
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  if (content.includes(PROFILE_MARKER) || content.includes(PROFILE_LINE)) return false;
  await appendFile(
    path,
    `${content.length > 0 && !content.endsWith("\n") ? "\n" : ""}\n${PROFILE_MARKER}\n${PROFILE_LINE}\n`,
    "utf8",
  );
  return true;
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o700 });
  try {
    await rename(temporary, path);
  } catch (error) {
    if (!isReplaceError(error)) throw error;
    await rm(path, { force: true });
    await rename(temporary, path);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isReplaceError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "EPERM" || code === "EACCES";
}
