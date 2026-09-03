import { mutateRuntimeConfig } from "@memmy/migrations";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync
} from "node:fs";
import crypto from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { asRecord, expandHome, optionalString } from "./config.js";
import {
  installMemmyMemorySkillForAgents,
  SUPPORTED_MEMMY_AGENT_IDS,
  type AgentSkillInstallResult
} from "./skill-writer/index.js";

export interface MemoryCliSetupOptions {
  home?: string;
  configPath?: string;
  dbPath?: string;
  endpoint?: string;
  token?: string;
  force?: boolean;
  dryRun?: boolean;
  binPath?: string;
  sourcePath?: string;
  agents?: string[];
  agentRoot?: string;
  assetRoot?: string;
  skipAgentSkills?: boolean;
  generateTokenIfMissing?: boolean;
}

export async function initMemoryCli(options: MemoryCliSetupOptions = {}): Promise<Record<string, unknown>> {
  const home = resolve(expandHome(options.home ?? "~/.memmy"));
  const configPath = resolve(expandHome(options.configPath ?? join(home, "config.yaml")));
  const dbPath = resolve(expandHome(options.dbPath ?? join(home, "memory-service", "memory.sqlite")));
  const endpoint = options.endpoint ?? "http://127.0.0.1:18960";

  if (!options.dryRun) {
    mkdirSync(home, { recursive: true });
    mkdirSync(dirname(configPath), { recursive: true });
    await mutateRuntimeConfig(configPath, (config) => {
      setupMemoryConfig(config, {
        dbPath,
        endpoint,
        token: options.token,
        generateTokenIfMissing: options.generateTokenIfMissing,
      });
    });
  }

  let agentInstallations: AgentSkillInstallResult[] = [];

  const requestedAgents = options.skipAgentSkills
    ? []
    : options.agents?.length
      ? options.agents
      : [...SUPPORTED_MEMMY_AGENT_IDS];

  if (requestedAgents.length) {
    agentInstallations = await installMemmyMemorySkillForAgents(requestedAgents, {
      agentRoot: options.agents?.length ? options.agentRoot : undefined,
      assetRoot: options.assetRoot,
      memmyConfigPath: configPath,
      dryRun: options.dryRun,
      skipUnavailable: !options.agents?.length
    });
  }

  return {
    ok: true,
    command: "init",
    home,
    configPath,
    dbPath,
    endpoint,
    dryRun: options.dryRun ?? false,
    ...(agentInstallations.length ? { agents: agentInstallations } : {})
  };
}

export async function installMemoryCli(options: MemoryCliSetupOptions = {}): Promise<Record<string, unknown>> {
  const home = resolve(expandHome(options.home ?? "~/.memmy"));
  const binPath = resolve(expandHome(options.binPath ?? join(home, "bin", "memmy-memory")));
  const source = resolve(expandHome(options.sourcePath ?? join(process.cwd(), "dist", "src", "cli", "index.js")));

  if (existsSync(binPath) && !options.force && !isExistingMemmyMemoryLink(binPath, source)) {
    throw new Error(`${binPath} already exists`);
  }

  const init = await initMemoryCli(options);

  if (!options.dryRun) {
    mkdirSync(dirname(binPath), { recursive: true });
    if (existsSync(binPath)) unlinkSync(binPath);
    symlinkSync(source, binPath);
  }

  return {
    ...init,
    command: "install",
    binPath,
    source,
    pathReady: isPathReady(dirname(binPath)),
  };
}

function isExistingMemmyMemoryLink(binPath: string, source: string): boolean {
  try {
    const stat = lstatSync(binPath);
    if (!stat.isSymbolicLink()) return false;
    return resolve(dirname(binPath), readlinkSync(binPath)) === source;
  } catch {
    return false;
  }
}

function isPathReady(binDir: string): boolean {
  return (process.env.PATH ?? "")
    .split(":")
    .some((entry) => entry && resolve(expandHome(entry)) === binDir);
}

function setupMemoryConfig(
  config: Record<string, unknown>,
  options: {
    dbPath: string;
    endpoint: string;
    token?: string;
    generateTokenIfMissing?: boolean;
  }
): void {
  const app = asRecord(config.app);
  const appUserId = optionalString(app.userId);

  config.memmyMemory = setupMemmyMemoryConfig(asRecord(config.memmyMemory), {
    appUserId,
    dbPath: options.dbPath,
    endpoint: options.endpoint,
    token: options.token,
    generateTokenIfMissing: options.generateTokenIfMissing,
  });
}

function setupMemmyMemoryConfig(
  existing: Record<string, unknown>,
  options: {
    appUserId?: string;
    dbPath: string;
    endpoint: string;
    token?: string;
    generateTokenIfMissing?: boolean;
  }
): Record<string, unknown> {
  const roleRouting = asRecord(existing.roleRouting);
  const embedding = asRecord(existing.embedding);
  const storage = asRecord(existing.storage);
  const algorithm = asRecord(existing.algorithm);
  const existingToken = optionalString(storage.token);
  const token = options.token
    ?? existingToken
    ?? (options.generateTokenIfMissing ? crypto.randomBytes(32).toString("hex") : undefined);
  validateEmbeddingForSetup(embedding);
  const memmyMemory: Record<string, unknown> = {
    ...existing,
    version: 1,
    userId: optionalString(existing.userId) ?? options.appUserId ?? "local-user",
    roleRouting: {
      ...roleRouting,
      summary: memoryRoleRouting(roleRouting.summary),
      evolution: memoryRoleRouting(roleRouting.evolution)
    },
    storage: {
      ...storage,
      mode: "local",
      backend: "sqlite",
      sqlitePath: options.dbPath,
      endpoint: options.endpoint,
      ...(token !== undefined ? { token } : {})
    },
    algorithm: {
      ...algorithm,
      enableMemoryAdd: true,
      enableMemorySearch: true,
      enableQueryRewrite: false
    }
  };
  delete memmyMemory.embedding;
  return memmyMemory;
}

function validateEmbeddingForSetup(existing: Record<string, unknown>): void {
  const keys = Object.keys(existing);
  if (keys.length === 0) return;
  if (
    keys.length === 1
    && keys[0] === "mode"
    && (existing.mode === "cloud" || existing.mode === "local" || existing.mode === "custom")
  ) {
    return;
  }
  throw new Error("memmyMemory.embedding requires the registered runtime config migration");
}

function memoryRoleRouting(value: unknown): "follow" | "fixed" {
  return value === "fixed" ? "fixed" : "follow";
}
