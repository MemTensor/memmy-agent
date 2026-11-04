import { execFile } from "node:child_process";
import { arch, platform, release, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sha256Hex } from "../../contracts/index.js";

const execFileAsync = promisify(execFile);

/** Always listed in the profile, as installed or not found. */
export const MACHINE_TOOLS = ["node", "python3", "git", "npm", "brew"] as const;
/** Listed only when installed. */
export const OPTIONAL_MACHINE_TOOLS = ["pnpm", "yarn", "uv", "conda", "docker", "java", "go", "rustc"] as const;
export type MachineTool = typeof MACHINE_TOOLS[number] | typeof OPTIONAL_MACHINE_TOOLS[number];
const ALL_TOOLS: readonly MachineTool[] = [...MACHINE_TOOLS, ...OPTIONAL_MACHINE_TOOLS];

const TOOL_ARGS: Record<MachineTool, string[]> = {
  node: ["--version"],
  python3: ["--version"],
  git: ["--version"],
  npm: ["--version"],
  brew: ["--version"],
  pnpm: ["--version"],
  yarn: ["--version"],
  uv: ["--version"],
  conda: ["--version"],
  docker: ["--version"],
  java: ["-version"],
  go: ["version"],
  rustc: ["--version"]
};
const PROBE_TIMEOUT_MS = 2_000;
// One login shell runs every probe; shell start-up files (nvm, conda, pyenv) can take a few seconds.
const LOGIN_SHELL_TIMEOUT_MS = 8_000;
const SECTION_MARKER = "__memmy_probe__";

export interface MachineProbe {
  os: string;
  osVersion: string;
  arch: string;
  shell: string | null;
  tools: Record<MachineTool, string | null>;
}

export type VersionRunner = (executable: string, args: string[]) => Promise<string | null>;
/** Runs a script in the user's login shell and returns its stdout, or null. */
export type LoginShellRunner = (shell: string, script: string) => Promise<string | null>;

/**
 * Probes this computer only by running `--version` style commands; never reads conversation content.
 * Versions are read through the user's login shell first, because an app started from the Dock does not
 * see the PATH set up in shell start-up files (nvm, conda, pyenv); tools it cannot see are run directly.
 */
export async function probeMachine(options: {
  runVersion?: VersionRunner;
  runLoginShell?: LoginShellRunner;
  env?: NodeJS.ProcessEnv;
  os?: NodeJS.Platform;
} = {}): Promise<MachineProbe> {
  const runVersion = options.runVersion ?? defaultVersionRunner;
  const runLoginShell = options.runLoginShell ?? defaultLoginShellRunner;
  const env = options.env ?? process.env;
  const os = options.os ?? platform();
  const fromShell = env.SHELL && os !== "win32"
    ? parseShellProbe(await runLoginShell(env.SHELL, shellProbeScript()).catch(() => null))
    : new Map<MachineTool, string>();
  const entries = await Promise.all(ALL_TOOLS.map(async (tool) => {
    const viaShell = fromShell.get(tool);
    if (viaShell) return [tool, viaShell] as const;
    const output = await runVersion(tool, TOOL_ARGS[tool]).catch(() => null);
    return [tool, output ? versionNumber(output) : null] as const;
  }));
  // os.release() is the Darwin kernel version on macOS; the product version is what users recognize.
  const productVersion = os === "darwin"
    ? await runVersion("sw_vers", ["-productVersion"]).catch(() => null)
    : null;
  return {
    os,
    osVersion: (productVersion ? versionNumber(productVersion) : null) ?? release(),
    arch: arch(),
    shell: env.SHELL ? path.basename(env.SHELL) : null,
    tools: Object.fromEntries(entries) as Record<MachineTool, string | null>
  };
}

/** Fixed-format machine profile text; the same probe always renders the same text. */
export function renderMachineProfile(probe: MachineProbe): string {
  const lines = [
    `- 系统：${osLabel(probe.os)} ${probe.osVersion}（${probe.arch}）`,
    ...(probe.shell ? [`- shell：${probe.shell}`] : [])
  ];
  const installed = ALL_TOOLS
    .filter((tool) => probe.tools[tool])
    .map((tool) => `${tool} ${probe.tools[tool]}`);
  if (installed.length) lines.push(`- 已安装：${installed.join("，")}`);
  const missing = MACHINE_TOOLS.filter((tool) => !probe.tools[tool]);
  if (missing.length) lines.push(`- 未检测到：${missing.join("，")}`);
  return lines.join("\n");
}

export function machineProfileFingerprint(probe: MachineProbe): string {
  return sha256Hex(renderMachineProfile(probe));
}

function osLabel(os: string): string {
  if (os === "darwin") return "macOS";
  if (os === "win32") return "Windows";
  if (os === "linux") return "Linux";
  return os;
}

/** Keeps the version number only, e.g. `git version 2.39.5 (Apple Git-154)` -> `2.39.5`; output without one is not a version. */
function versionNumber(output: string): string | null {
  const version = /v?(\d+(?:\.\d+)+)/.exec(output);
  return version ? version[1]! : null;
}

/** Prints a marker line per tool, then its version; tools the shell cannot find print nothing. */
function shellProbeScript(): string {
  return ALL_TOOLS.map((tool) =>
    `printf '\\n${SECTION_MARKER}${tool}\\n'; command -v ${tool} >/dev/null 2>&1 && ${tool} ${TOOL_ARGS[tool].join(" ")} 2>&1 | head -n 3`
  ).join("; ");
}

function parseShellProbe(output: string | null): Map<MachineTool, string> {
  const found = new Map<MachineTool, string>();
  if (!output) return found;
  // Anything a start-up file prints before the first marker is ignored.
  for (const section of output.split(SECTION_MARKER).slice(1)) {
    const newline = section.indexOf("\n");
    const tool = (newline < 0 ? section : section.slice(0, newline)).trim() as MachineTool;
    const version = newline < 0 ? null : versionNumber(section.slice(newline + 1));
    if (ALL_TOOLS.includes(tool) && version) found.set(tool, version);
  }
  return found;
}

async function defaultLoginShellRunner(shell: string, script: string): Promise<string | null> {
  try {
    const result = await execFileAsync(shell, ["-ilc", script], {
      cwd: tmpdir(),
      timeout: LOGIN_SHELL_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      windowsHide: true
    });
    return result.stdout || null;
  } catch {
    return null;
  }
}

async function defaultVersionRunner(executable: string, args: string[]): Promise<string | null> {
  try {
    const result = await execFileAsync(executable, args, {
      cwd: tmpdir(),
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 4096,
      shell: false,
      windowsHide: true
    });
    return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim() || null;
  } catch {
    return null;
  }
}
