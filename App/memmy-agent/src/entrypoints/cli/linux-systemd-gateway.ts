import { execFile } from "node:child_process";
import crypto from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { mutateRuntimeConfig } from "@memmy/migrations";
import type { Config } from "../../config/schema.js";
import { getConfigPath, getRuntimeSubdir } from "../../config/paths.js";
import { tuiGatewayOptionsFromConfig } from "./tui-gateway-client.js";

const execFileAsync = promisify(execFile);
const STARTUP_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 1_500;
const POLL_INTERVAL_MS = 150;
const SERVICE_STABILITY_MS = 500;
const MEMORY_SERVICE_NAME = "memmy-memory.service";
const SYSTEMD_GATEWAY_ENV = "MEMMY_LINUX_SYSTEMD_GATEWAY";

const PERSISTED_GATEWAY_ENV_KEYS = [
  "PATH",
  "SHELL",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "GIT_SSH_COMMAND",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "GROQ_BASE_URL",
  "DEEPSEEK_API_KEY",
  "TAVILY_API_KEY",
  "BRAVE_API_KEY",
  "JINA_API_KEY",
  "KAGI_API_KEY",
  "OLOSTEP_API_KEY",
  "SEARXNG_BASE_URL",
  "OPENAI_TRANSCRIPTION_BASE_URL",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_BEARER_TOKEN_BEDROCK",
  "OAUTH_CLI_KIT_TOKEN_PATH",
  "OPENAI_CODEX_TOKEN_PATH",
  "CHATGPT_TOKEN_PATH",
  "OPENAI_CODEX_ACCESS_TOKEN",
  "CHATGPT_ACCESS_TOKEN",
  "OPENAI_CODEX_ACCOUNT_ID",
  "CHATGPT_ACCOUNT_ID",
  "MEMMY_AGENT_PATH_APPEND",
  "MEMMY_AGENT_STREAM_IDLE_TIMEOUT_S",
  "MEMMY_CLOUD_SERVICE",
  "MEMMY_APP_EDITION",
] as const;

export class LinuxSystemdGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinuxSystemdGatewayError";
  }
}

export type GatewayProbe =
  | { status: "ready" }
  | { status: "unavailable"; detail: string }
  | { status: "unexpected"; detail: string };

type GatewayEndpoint = {
  baseUrl: string;
  bootstrapSecret: string | null;
};

type MemoryServiceEndpoint = {
  baseUrl: string;
  token: string | null;
};

type LinuxRootTerminalDependencies = {
  loadConfig: () => Config;
  onboardWizard: () => Promise<unknown>;
  runInteractive: (config?: Config) => Promise<unknown>;
  platform?: NodeJS.Platform;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  systemdGatewayEnabled?: boolean;
  prepareGatewayConfig?: () => Promise<Config>;
  refreshMemoryService?: (config: Config) => Promise<void>;
  prepareGatewayEnvironment?: () => Promise<boolean>;
  enableGatewayService?: (options?: { restart?: boolean }) => Promise<void>;
  probeGateway?: (config: Config) => Promise<GatewayProbe>;
  gatewayServiceMainPid?: () => Promise<number | null>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  startupTimeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mutableRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && isRecord(current); depth += 1) {
    if (typeof current.code === "string") return current.code;
    current = current.cause;
  }
  return null;
}

function unavailableNetworkError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  return new Set([
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENETDOWN",
    "ETIMEDOUT",
  ]).has(errorCode(error) ?? "");
}

function gatewayEndpoint(config: Config): GatewayEndpoint {
  const options = tuiGatewayOptionsFromConfig(config, "cli:systemd-probe");
  return {
    baseUrl: options.baseUrl,
    bootstrapSecret: options.bootstrapSecret?.trim() || null,
  };
}

function memoryServiceEndpoint(config: Config): MemoryServiceEndpoint {
  const storage = isRecord(config.memmyMemory.storage) ? config.memmyMemory.storage : {};
  return {
    baseUrl: typeof storage.endpoint === "string" && storage.endpoint.trim()
      ? storage.endpoint.trim()
      : "http://127.0.0.1:18960",
    token: typeof storage.token === "string" && storage.token.trim()
      ? storage.token.trim()
      : null,
  };
}

function validBootstrap(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.token === "string"
    && value.token.length > 0
    && typeof value.ws_path === "string"
    && value.ws_path.startsWith("/");
}

export function hasUsableDefaultModel(config: Config): boolean {
  try {
    const preset = config.resolvePreset();
    return Boolean(preset.model.trim() && config.getProviderName(preset.model, { preset }));
  } catch {
    return false;
  }
}

export async function probeGateway(
  config: Config,
  {
    fetchImpl = fetch,
    timeoutMs = PROBE_TIMEOUT_MS,
  }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<GatewayProbe> {
  let endpoint: GatewayEndpoint;
  try {
    endpoint = gatewayEndpoint(config);
  } catch (error) {
    const detail = errorMessage(error);
    if (detail.includes("WebSocket Gateway is disabled")) {
      return { status: "unavailable", detail };
    }
    return { status: "unexpected", detail: `invalid Gateway configuration: ${detail}` };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${endpoint.baseUrl}/webui/bootstrap`, {
      cache: "no-store",
      headers: endpoint.bootstrapSecret
        ? { authorization: `Bearer ${endpoint.bootstrapSecret}` }
        : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        status: "unexpected",
        detail: `bootstrap HTTP ${response.status}`,
      };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      return { status: "unexpected", detail: `invalid bootstrap JSON: ${errorMessage(error)}` };
    }
    return validBootstrap(body)
      ? { status: "ready" }
      : { status: "unexpected", detail: "bootstrap response is incompatible" };
  } catch (error) {
    if (unavailableNetworkError(error)) {
      return { status: "unavailable", detail: errorMessage(error) };
    }
    return { status: "unexpected", detail: errorMessage(error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeMemoryServiceAuthentication(
  config: Config,
  {
    fetchImpl = fetch,
    timeoutMs = PROBE_TIMEOUT_MS,
  }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<GatewayProbe> {
  const endpoint = memoryServiceEndpoint(config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(new URL("/api/v1/panel/overview", endpoint.baseUrl), {
      cache: "no-store",
      headers: endpoint.token
        ? { authorization: `Bearer ${endpoint.token}` }
        : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        status: "unexpected",
        detail: `authenticated Memory HTTP ${response.status}`,
      };
    }
    return { status: "ready" };
  } catch (error) {
    if (unavailableNetworkError(error)) {
      return { status: "unavailable", detail: errorMessage(error) };
    }
    return { status: "unexpected", detail: errorMessage(error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function prepareLinuxGatewayConfig(
  loadConfig: () => Config,
  configPath = getConfigPath(),
): Promise<Config> {
  await mutateRuntimeConfig(configPath, (root) => {
    const channels = mutableRecord(root.channels);
    const websocket = mutableRecord(channels.websocket);
    const gateway = mutableRecord(root.gateway);

    websocket.enabled = true;
    websocket.host ??= "127.0.0.1";
    websocket.port ??= 18980;
    websocket.tokenTtlS ??= 86_400;
    websocket.websocketRequiresToken ??= true;
    websocket.allowFrom ??= ["*"];
    if (
      (typeof websocket.tokenIssueSecret !== "string" || !websocket.tokenIssueSecret.trim())
      && (typeof websocket.token !== "string" || !websocket.token.trim())
    ) {
      websocket.tokenIssueSecret = crypto.randomBytes(32).toString("hex");
    }

    gateway.enabled = true;
    gateway.host ??= "127.0.0.1";
    gateway.port ??= 18970;

    channels.websocket = websocket;
    root.channels = channels;
    root.gateway = gateway;
  });
  return loadConfig();
}

function environmentFilePath(): string {
  const configured = process.env.MEMMY_GATEWAY_ENV_FILE?.trim();
  return configured ? path.resolve(configured) : path.join(getRuntimeSubdir("systemd"), "gateway.env");
}

function referencedEnvironmentKeys(configText: string): Set<string> {
  const keys = new Set<string>();
  for (const match of configText.matchAll(/\$\{([A-Z_][A-Z0-9_]*)(?::[^}]*)?\}/gi)) {
    keys.add(match[1]);
  }
  return keys;
}

function quoteEnvironmentValue(key: string, value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new LinuxSystemdGatewayError(
      `Environment variable ${key} contains a newline or NUL and cannot be persisted for systemd.`,
    );
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export async function prepareSystemdGatewayEnvironment(
  {
    configPath = getConfigPath(),
    destination = environmentFilePath(),
    env = process.env,
  }: {
    configPath?: string;
    destination?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<boolean> {
  let configText = "";
  try {
    configText = readFileSync(configPath, "utf8");
  } catch (error) {
    throw new LinuxSystemdGatewayError(
      `Could not read Gateway configuration for systemd environment: ${errorMessage(error)}`,
    );
  }

  const keys = referencedEnvironmentKeys(configText);
  for (const key of PERSISTED_GATEWAY_ENV_KEYS) keys.add(key);
  const lines = [
    "# Generated by memmy. Mode 0600; refreshed by each interactive memmy launch.",
  ];
  for (const key of [...keys].sort()) {
    const value = env[key];
    if (value === undefined) continue;
    lines.push(`${key}=${quoteEnvironmentValue(key, value)}`);
  }
  const content = `${lines.join("\n")}\n`;

  let existing: string | null = null;
  try {
    existing = readFileSync(destination, "utf8");
  } catch {
    existing = null;
  }
  try {
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(destination), 0o700);
    if (existing === content) {
      chmodSync(destination, 0o600);
      return false;
    }
  } catch (error) {
    throw new LinuxSystemdGatewayError(
      `Could not prepare the private Gateway environment directory: ${errorMessage(error)}`,
    );
  }

  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new LinuxSystemdGatewayError(
      `Could not persist the private Gateway environment file: ${errorMessage(error)}`,
    );
  }
  return true;
}

export async function enableSystemdGatewayService(
  { restart = false }: { restart?: boolean } = {},
): Promise<void> {
  try {
    if (restart) {
      await execFileAsync("systemctl", ["--user", "enable", "memmy-gateway.service"], {
        timeout: 20_000,
      });
      await execFileAsync("systemctl", ["--user", "restart", "memmy-gateway.service"], {
        timeout: 20_000,
      });
    } else {
      await execFileAsync(
        "systemctl",
        ["--user", "enable", "--now", "memmy-gateway.service"],
        { timeout: 20_000 },
      );
    }
  } catch (error) {
    const detail = isRecord(error) && typeof error.stderr === "string"
      ? error.stderr.trim()
      : errorMessage(error);
    throw new LinuxSystemdGatewayError(
      "Could not start memmy-gateway.service with systemd --user"
      + `${detail ? `: ${detail}` : "."} `
      + "Install Memmy with the Linux installer and check "
      + "`systemctl --user status memmy-gateway.service`.",
    );
  }
}

export async function systemdGatewayMainPid(): Promise<number | null> {
  return systemdServiceMainPid("memmy-gateway.service");
}

async function systemdServiceMainPid(serviceName: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      "systemctl",
      ["--user", "show", serviceName, "--property=MainPID", "--value"],
      { timeout: 5_000 },
    );
    const pid = Number.parseInt(stdout.trim(), 10);
    if (!Number.isSafeInteger(pid) || pid <= 1) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

export async function refreshSystemdMemoryService(config: Config): Promise<void> {
  try {
    await execFileAsync("systemctl", ["--user", "restart", MEMORY_SERVICE_NAME], {
      timeout: 20_000,
    });
  } catch (error) {
    const detail = isRecord(error) && typeof error.stderr === "string"
      ? error.stderr.trim()
      : errorMessage(error);
    throw new LinuxSystemdGatewayError(
      `Could not restart ${MEMORY_SERVICE_NAME} after onboarding${detail ? `: ${detail}` : "."}`,
    );
  }

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastDetail = "connection refused";
  while (Date.now() < deadline) {
    const result = await probeMemoryServiceAuthentication(config);
    if (result.status === "ready") {
      const firstPid = await systemdServiceMainPid(MEMORY_SERVICE_NAME);
      if (firstPid !== null) {
        await sleep(SERVICE_STABILITY_MS);
        const secondPid = await systemdServiceMainPid(MEMORY_SERVICE_NAME);
        if (secondPid === firstPid) return;
      }
      lastDetail = `${MEMORY_SERVICE_NAME} has no stable MainPID`;
    } else {
      lastDetail = result.detail;
      if (result.status === "unexpected") {
        throw new LinuxSystemdGatewayError(
          `Memory service rejected the post-onboarding configuration (${result.detail}).`,
        );
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new LinuxSystemdGatewayError(
    `${MEMORY_SERVICE_NAME} did not become authenticated and ready after onboarding `
    + `(${lastDetail}). Check \`systemctl --user status ${MEMORY_SERVICE_NAME}\` and `
    + `\`journalctl --user -u ${MEMORY_SERVICE_NAME}\`.`,
  );
}

async function waitForGatewayReady(
  config: Config,
  dependencies: Pick<
    LinuxRootTerminalDependencies,
    "probeGateway" | "now" | "sleep" | "startupTimeoutMs" | "gatewayServiceMainPid"
  >,
): Promise<void> {
  const probe = dependencies.probeGateway ?? ((candidate) => probeGateway(candidate));
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.sleep ?? sleep;
  const serviceMainPid = dependencies.gatewayServiceMainPid ?? systemdGatewayMainPid;
  const deadline = now() + (dependencies.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
  let lastDetail = "connection refused";

  while (now() < deadline) {
    const result = await probe(config);
    if (result.status === "ready") {
      const firstPid = await serviceMainPid();
      if (firstPid !== null) {
        await wait(SERVICE_STABILITY_MS);
        const secondPid = await serviceMainPid();
        if (secondPid === firstPid) return;
      }
      lastDetail = "memmy-gateway.service has no stable MainPID";
      continue;
    }
    lastDetail = result.detail;
    if (result.status === "unexpected") {
      throw new LinuxSystemdGatewayError(
        `Gateway endpoint is occupied, incompatible, or rejected authentication (${result.detail}).`,
      );
    }
    await wait(POLL_INTERVAL_MS);
  }

  throw new LinuxSystemdGatewayError(
    "memmy-gateway.service did not become ready"
    + ` (${lastDetail}). Check \`systemctl --user status memmy-gateway.service\` and `
    + "`journalctl --user -u memmy-gateway.service`.",
  );
}

export async function runLinuxRootTerminal(
  dependencies: LinuxRootTerminalDependencies,
): Promise<unknown> {
  const platform = dependencies.platform ?? process.platform;
  const stdinIsTTY = dependencies.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const stdoutIsTTY = dependencies.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
  const systemdGatewayEnabled = dependencies.systemdGatewayEnabled
    ?? process.env[SYSTEMD_GATEWAY_ENV] === "1";
  if (platform !== "linux" || !stdinIsTTY || !stdoutIsTTY || !systemdGatewayEnabled) {
    return dependencies.runInteractive();
  }

  let config = dependencies.loadConfig();
  let onboarded = false;
  if (!hasUsableDefaultModel(config)) {
    await dependencies.onboardWizard();
    onboarded = true;
    config = dependencies.loadConfig();
    if (!hasUsableDefaultModel(config)) {
      throw new LinuxSystemdGatewayError(
        "No usable default model was saved. Run `memmy onboard --wizard` to finish configuration.",
      );
    }
  }

  const probe = dependencies.probeGateway ?? ((candidate) => probeGateway(candidate));
  const serviceMainPid = dependencies.gatewayServiceMainPid ?? systemdGatewayMainPid;
  let result = await probe(config);
  let servicePid = await serviceMainPid();
  let restart = false;

  if (result.status === "ready" && servicePid === null) {
    throw new LinuxSystemdGatewayError(
      "A compatible Gateway is already running outside memmy-gateway.service. "
      + "Stop that Gateway before starting the installed Memmy CLI.",
    );
  }
  if (result.status === "unexpected" && servicePid === null) {
    throw new LinuxSystemdGatewayError(
      `Gateway endpoint is occupied, incompatible, or rejected authentication (${result.detail}).`,
    );
  }

  if (result.status !== "ready") {
    config = dependencies.prepareGatewayConfig
      ? await dependencies.prepareGatewayConfig()
      : await prepareLinuxGatewayConfig(dependencies.loadConfig);
    restart = servicePid !== null;
    result = await probe(config);
    servicePid = await serviceMainPid();
    if (result.status === "ready" && servicePid === null) {
      throw new LinuxSystemdGatewayError(
        "A compatible Gateway is already running outside memmy-gateway.service. "
        + "Stop that Gateway before starting the installed Memmy CLI.",
      );
    }
    if (result.status === "unexpected" && servicePid === null) {
      throw new LinuxSystemdGatewayError(
        `Gateway endpoint is occupied, incompatible, or rejected authentication (${result.detail}).`,
      );
    }
  }

  if (onboarded) {
    await (dependencies.refreshMemoryService ?? refreshSystemdMemoryService)(config);
  }

  const environmentChanged = dependencies.prepareGatewayEnvironment
    ? await dependencies.prepareGatewayEnvironment()
    : await prepareSystemdGatewayEnvironment();
  restart ||= environmentChanged || result.status === "unexpected";
  await (dependencies.enableGatewayService ?? enableSystemdGatewayService)({ restart });
  await waitForGatewayReady(config, dependencies);

  return dependencies.runInteractive(config);
}
