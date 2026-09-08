import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { applyEdits, modify } from "jsonc-parser";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { InstalledRuntimePointer } from "./runtime-installer.js";
import { normalizeAgentIds, type MemmyAgentId } from "./skill-writer/index.js";

export interface AdapterInstallOptions {
  agents: string[];
  runtime: InstalledRuntimePointer;
  userHome?: string;
  dshProfile?: string;
  dryRun?: boolean;
  explicit?: boolean;
  restartHosts?: boolean;
}

export interface AdapterInstallResult {
  agent: MemmyAgentId;
  target: string;
  installed: boolean;
  configured: boolean;
  dryRun: boolean;
}

export async function installAgentAdapters(options: AdapterInstallOptions): Promise<AdapterInstallResult[]> {
  const root = resolve(options.userHome ?? homedir());
  const agents = normalizeAgentIds(options.agents).filter((agent) => agent === "openclaw" || agent === "hermes" || agent === "dsh");
  const results: AdapterInstallResult[] = [];
  for (const agent of agents) {
    const source = join(options.runtime.runtimeDir, "adapters", agent);
    if (!options.dryRun && !existsSync(source)) throw new Error(`Memory ${options.runtime.version} is missing its ${agent} adapter`);
    if (agent === "openclaw") results.push(await installOpenClaw(source, root, options));
    if (agent === "hermes") results.push(await installHermes(source, root, options));
    if (agent === "dsh") results.push(await installDsh(source, root, options));
  }
  return results;
}

async function installOpenClaw(source: string, root: string, options: AdapterInstallOptions): Promise<AdapterInstallResult> {
  const openClawRoot = process.env.OPENCLAW_STATE_DIR?.trim() || join(root, ".openclaw");
  const target = join(openClawRoot, "plugins", "memmy-memory");
  if (!existsSync(openClawRoot) && !options.explicit) return result("openclaw", target, false, false, options);
  if (!existsSync(openClawRoot) && options.explicit) throw new Error(`openclaw is not installed: ${openClawRoot}`);
  if (!options.dryRun) {
    await replaceDirectory(source, target);
    const configPath = join(openClawRoot, "openclaw.json");
    const current = existsSync(configPath) ? await readFile(configPath, "utf8") : "{}\n";
    let next = applyEdits(current, modify(current, ["plugins", "slots", "memory"], "memmy-memory", { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    next = applyEdits(next, modify(next, ["plugins", "entries", "memmy-memory", "enabled"], true, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    await writeAtomic(configPath, next.endsWith("\n") ? next : `${next}\n`);
    if (options.restartHosts !== false) runOptional("openclaw", ["gateway", "restart"]);
  }
  return result("openclaw", target, true, true, options);
}

async function installHermes(source: string, root: string, options: AdapterInstallOptions): Promise<AdapterInstallResult> {
  const hermesRoot = process.env.HERMES_HOME?.trim() || join(root, ".hermes");
  const target = join(hermesRoot, "plugins", "memmy");
  if (!existsSync(hermesRoot) && !options.explicit) return result("hermes", target, false, false, options);
  if (!existsSync(hermesRoot) && options.explicit) throw new Error(`hermes is not installed: ${hermesRoot}`);
  if (!options.dryRun) {
    await replaceDirectory(source, target);
    const configPath = join(hermesRoot, "config.yaml");
    const parsed = existsSync(configPath) ? parseYaml(await readFile(configPath, "utf8")) : {};
    const config = record(parsed);
    config.memory = { ...record(config.memory), provider: "memmy" };
    await writeAtomic(configPath, stringifyYaml(config, { lineWidth: 0 }));
  }
  return result("hermes", target, true, true, options);
}

async function installDsh(source: string, root: string, options: AdapterInstallOptions): Promise<AdapterInstallResult> {
  const dshRoot = process.env.DSH_HOME?.trim() || join(root, ".dsh");
  const target = join(dshRoot, "profiles", options.dshProfile ?? "web");
  if (!existsSync(dshRoot) && !options.explicit) return result("dsh", target, false, false, options);
  if (!existsSync(dshRoot) && options.explicit) throw new Error(`dsh is not installed: ${dshRoot}`);
  if (!options.dryRun) {
    const installed = spawnSync("dsh", ["plugin", "--profile", options.dshProfile ?? "web", "add", source], { encoding: "utf8", windowsHide: true });
    if (installed.status !== 0) throw new Error(`failed to install DSH adapter: ${installed.stderr?.trim() || installed.stdout?.trim() || installed.error?.message}`);
  }
  return result("dsh", target, true, true, options);
}

async function replaceDirectory(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const staged = `${target}.staging-${process.pid}-${Date.now()}`;
  await cp(source, staged, { recursive: true });
  const previous = `${target}.previous-${process.pid}-${Date.now()}`;
  if (existsSync(target)) await rename(target, previous);
  try {
    await rename(staged, target);
    await rm(previous, { recursive: true, force: true });
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    if (existsSync(previous)) await rename(previous, target);
    throw error;
  }
}

async function writeAtomic(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function runOptional(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 5_000 });
  if (result.error && (result.error as NodeJS.ErrnoException).code !== "ENOENT") throw result.error;
}

function result(agent: MemmyAgentId, target: string, installed: boolean, configured: boolean, options: AdapterInstallOptions): AdapterInstallResult {
  return { agent, target, installed, configured, dryRun: options.dryRun ?? false };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
