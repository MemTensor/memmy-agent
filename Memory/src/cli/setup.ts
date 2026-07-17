import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
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
}

export async function initMemoryCli(options: MemoryCliSetupOptions = {}): Promise<Record<string, unknown>> {
  const home = resolve(expandHome(options.home ?? "~/.memmy"));
  const configPath = resolve(expandHome(options.configPath ?? join(home, "config.yaml")));
  const dbPath = resolve(expandHome(options.dbPath ?? join(home, "memory-service", "memory.sqlite")));
  const endpoint = options.endpoint ?? "http://127.0.0.1:18960";

  if (!options.dryRun) {
    mkdirSync(home, { recursive: true });
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, setupConfigYaml(configPath, { dbPath, endpoint, token: options.token }), "utf8");
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
      dryRun: options.dryRun
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

function setupConfigYaml(
  configPath: string,
  options: {
    dbPath: string;
    endpoint: string;
    token?: string;
  }
): string {
  const config = readExistingConfig(configPath);
  const app = { ...asRecord(config.app) };
  const appUserId = optionalString(app.userId);
  delete app.user_id;
  delete app.cloud_uuid;
  if (appUserId) app.userId = appUserId;
  if (Object.keys(app).length > 0) config.app = app;
  else delete config.app;
  delete config.identity;
  delete config.uuid;

  config.memmyMemory = setupMemmyMemoryConfig(asRecord(config.memmyMemory), {
    appUserId,
    dbPath: options.dbPath,
    endpoint: options.endpoint,
    token: options.token
  });

  const yaml = YAML.stringify(config);
  return yaml.endsWith("\n") ? yaml : `${yaml}\n`;
}

function readExistingConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  try {
    const parsed = YAML.parse(readFileSync(configPath, "utf8"));
    return asRecord(parsed);
  } catch {
    return {};
  }
}

function setupMemmyMemoryConfig(
  existing: Record<string, unknown>,
  options: {
    appUserId?: string;
    dbPath: string;
    endpoint: string;
    token?: string;
  }
): Record<string, unknown> {
  const memmyMemory: Record<string, unknown> = {
    ...existing,
    version: 1,
    activeProfile: memoryProfileName(existing.activeProfile) ?? "byok",
    storage: {
      mode: "local",
      backend: "sqlite",
      sqlitePath: options.dbPath,
      endpoint: options.endpoint,
      ...(options.token ? { token: options.token } : {})
    },
    algorithm: {
      ...supportedAlgorithmConfig(asRecord(existing.algorithm)),
      enableMemoryAdd: true,
      enableMemorySearch: true,
      enableQueryRewrite: false
    }
  };
  const profiles = memoryProfiles(existing);
  if (!profiles.byok) {
    profiles.byok = byokProfileFromExisting(existing, options.appUserId);
  }
  memmyMemory.profiles = profiles;
  delete memmyMemory.userId;
  delete memmyMemory.summary;
  delete memmyMemory.evolution;
  delete memmyMemory.embedding;
  return memmyMemory;
}

function supportedAlgorithmConfig(input: Record<string, unknown>): Record<string, unknown> {
  const supported = [
    "capture",
    "reward",
    "feedback",
    "l2Induction",
    "l3Abstraction",
    "skill",
    "session",
    "retrieval"
  ];
  return Object.fromEntries(
    supported
      .filter((key) => Object.prototype.hasOwnProperty.call(input, key))
      .map((key) => [key, input[key]])
  );
}

function memoryProfiles(memmyMemory: Record<string, unknown>): Record<string, unknown> {
  const profiles = asRecord(memmyMemory.profiles);
  return {
    ...(Object.keys(asRecord(profiles.account)).length ? { account: { ...asRecord(profiles.account) } } : {}),
    ...(Object.keys(asRecord(profiles.byok)).length ? { byok: { ...asRecord(profiles.byok) } } : {})
  };
}

function byokProfileFromExisting(existing: Record<string, unknown>, appUserId?: string): Record<string, unknown> {
  const userId = optionalString(existing.userId) ?? appUserId;
  const legacy = {
    ...(userId ? { userId } : {}),
    ...(Object.keys(asRecord(existing.summary)).length ? { summary: { ...asRecord(existing.summary) } } : {}),
    ...(Object.keys(asRecord(existing.evolution)).length ? { evolution: { ...asRecord(existing.evolution) } } : {}),
    embedding: byokEmbeddingFromExisting(asRecord(existing.embedding))
  };
  return legacy;
}

function byokEmbeddingFromExisting(existing: Record<string, unknown>): Record<string, unknown> {
  const provider = optionalString(existing.provider);
  if (
    provider === "openai_compatible" ||
    provider === "gemini" ||
    provider === "cohere" ||
    provider === "voyage" ||
    provider === "mistral"
  ) {
    return { ...existing };
  }
  if (!provider || provider === "local") {
    return {
      provider: "local"
    };
  }
  return {
    provider: "local"
  };
}

function memoryProfileName(value: unknown): "account" | "byok" | undefined {
  const profile = optionalString(value);
  return profile === "account" || profile === "byok" ? profile : undefined;
}
