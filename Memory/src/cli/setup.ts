import { mutateMemoryConfig } from "../config/writer.js";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync
} from "node:fs";
import crypto from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { asRecord, expandHome, optionalString } from "./config.js";
import {
  installMemoryRuntime,
  installedAgents,
  type MemoryRuntimeInstallOptions
} from "./runtime-installer.js";
import {
  migrateLegacyLocalPlugins,
  type LegacyConfigSource
} from "./legacy-migration.js";
import { installAgentAdapters } from "./adapter-installer.js";
import {
  installMemmyMemorySkillForAgents,
  SUPPORTED_MEMMY_AGENT_IDS,
  type AgentSkillInstallResult
} from "./skill-writer/index.js";

export interface MemoryCliSetupOptions extends MemoryRuntimeInstallOptions {
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
  serviceOnly?: boolean;
  configSource?: LegacyConfigSource;
  legacyRoot?: string;
  nonInteractive?: boolean;
  skipLegacyMigration?: boolean;
  memmyConfigPreexisting?: boolean;
  userHome?: string;
  dshProfile?: string;
}

export async function initMemoryCli(options: MemoryCliSetupOptions = {}): Promise<Record<string, unknown>> {
  const { home, configPath, dbPath, endpoint } = setupPaths(options);

  if (!options.dryRun) {
    mkdirSync(home, { recursive: true });
    mkdirSync(dirname(configPath), { recursive: true });
    await mutateMemoryConfig(configPath, (config) => {
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
  const sourceInstall = options.sourcePath !== undefined || options.binPath !== undefined;
  const paths = setupPaths(options);
  const memmyConfigExisted = options.memmyConfigPreexisting ?? existsSync(paths.configPath);
  const init = await initMemoryCli({
    ...options,
    skipAgentSkills: options.serviceOnly ? true : options.skipAgentSkills
  });
  const migration = options.skipLegacyMigration
    ? undefined
    : await migrateLegacyLocalPlugins({
        configPath: paths.configPath,
        dbPath: paths.dbPath,
        memmyConfigExisted,
        configSource: options.configSource,
        legacyRoot: options.legacyRoot,
        nonInteractive: options.nonInteractive,
        dryRun: options.dryRun
      });

  if (!sourceInstall) {
    const agents = options.serviceOnly ? [] : installedAgentIds(init);
    const runtime = await installMemoryRuntime({
      ...options,
      agents
    });
    const pointer = runtimePointer(runtime);
    const adapters = pointer && agents.length
      ? await installAgentAdapters({
          agents,
          runtime: pointer,
          userHome: options.userHome,
          dshProfile: options.dshProfile,
          dryRun: options.dryRun,
          explicit: Boolean(options.agents?.length)
        })
      : [];
    return {
      ...init,
      command: "install",
      serviceOnly: options.serviceOnly ?? false,
      ...(migration ? { migration } : {}),
      runtime,
      ...(adapters.length ? { adapters } : {})
    };
  }

  const home = resolve(expandHome(options.home ?? "~/.memmy"));
  const binPath = resolve(expandHome(options.binPath ?? join(home, "bin", "memmy-memory")));
  const source = resolve(expandHome(options.sourcePath ?? join(process.cwd(), "dist", "src", "cli", "index.js")));

  if (existsSync(binPath) && !options.force && !isExistingMemmyMemoryLink(binPath, source)) {
    throw new Error(`${binPath} already exists`);
  }

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
    ...(migration ? { migration } : {}),
    pathReady: isPathReady(dirname(binPath)),
  };
}

export async function upgradeMemoryCli(options: MemoryCliSetupOptions = {}): Promise<Record<string, unknown>> {
  const paths = setupPaths(options);
  const migration = options.skipLegacyMigration
    ? undefined
    : await migrateLegacyLocalPlugins({
        configPath: paths.configPath,
        dbPath: paths.dbPath,
        memmyConfigExisted: existsSync(paths.configPath),
        configSource: options.configSource,
        legacyRoot: options.legacyRoot,
        nonInteractive: options.nonInteractive,
        dryRun: options.dryRun
      });
  const agents = options.agents?.length
    ? options.agents
    : await installedAgents(options.home);
  const agentInstallations = agents.length
    ? await installMemmyMemorySkillForAgents(agents, {
        agentRoot: options.agentRoot,
        assetRoot: options.assetRoot,
        dryRun: options.dryRun
      })
    : [];
  const runtime = await installMemoryRuntime({
    ...options,
    latest: options.version ? false : true,
    agents
  });
  const pointer = runtimePointer(runtime);
  const adapters = pointer && agents.length
    ? await installAgentAdapters({
        agents,
        runtime: pointer,
        userHome: options.userHome,
        dshProfile: options.dshProfile,
        dryRun: options.dryRun,
        explicit: Boolean(options.agents?.length)
      })
    : [];
  return {
    ok: true,
    command: "upgrade",
    runtime,
    ...(migration ? { migration } : {}),
    ...(adapters.length ? { adapters } : {}),
    ...(agentInstallations.length ? { agents: agentInstallations } : {})
  };
}

function runtimePointer(value: Record<string, unknown>): import("./runtime-installer.js").InstalledRuntimePointer | undefined {
  const candidate = value.pointer && typeof value.pointer === "object"
    ? value.pointer as Record<string, unknown>
    : value;
  return typeof candidate.version === "string" && typeof candidate.runtimeDir === "string" && typeof candidate.entrypoint === "string"
    ? candidate as unknown as import("./runtime-installer.js").InstalledRuntimePointer
    : undefined;
}

function setupPaths(options: MemoryCliSetupOptions): {
  home: string;
  configPath: string;
  dbPath: string;
  endpoint: string;
} {
  const home = resolve(expandHome(options.home ?? "~/.memmy"));
  const configPath = resolve(expandHome(options.configPath ?? join(home, "config.yaml")));
  const storage = existingMemoryStorage(configPath);
  return {
    home,
    configPath,
    dbPath: resolve(expandHome(
      options.dbPath
        ?? optionalString(storage.sqlitePath)
        ?? join(home, "memory-service", "memory.sqlite")
    )),
    endpoint: options.endpoint
      ?? optionalString(storage.endpoint)
      ?? "http://127.0.0.1:18960"
  };
}

function existingMemoryStorage(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  const parsed = parseYaml(readFileSync(configPath, "utf8")) as unknown;
  return asRecord(asRecord(asRecord(parsed).memmyMemory).storage);
}

function installedAgentIds(result: Record<string, unknown>): string[] {
  if (!Array.isArray(result.agents)) return [];
  return result.agents.flatMap((installation) => {
    if (!installation || typeof installation !== "object") return [];
    const agent = (installation as { agent?: unknown }).agent;
    return typeof agent === "string" ? [agent] : [];
  });
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
    accountMode: app.userMode === "account",
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
    accountMode: boolean;
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
  const agentAccess = asRecord(existing.agentAccess);
  const existingToken = optionalString(storage.token);
  const token = options.token
    ?? existingToken
    ?? (options.generateTokenIfMissing ? crypto.randomBytes(32).toString("hex") : undefined);
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
    },
    agentAccess: {
      ...agentAccess,
      autoScanKnownAgents: optionalBoolean(agentAccess.autoScanKnownAgents) ?? true,
      watchFileChanges: optionalBoolean(agentAccess.watchFileChanges) ?? true,
      autoInjectSkill: optionalBoolean(agentAccess.autoInjectSkill) ?? false
    },
    embedding: Object.keys(embedding).length
      ? embedding
      : {
          mode: options.accountMode ? "cloud" : "local",
          ...(options.accountMode ? {} : { provider: "local" })
        }
  };
  return memmyMemory;
}

function memoryRoleRouting(value: unknown): "follow" | "fixed" {
  return value === "fixed" ? "fixed" : "follow";
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
