import { OpenAICompatProvider } from "./openai-compat-provider.js";
import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "../config/paths.js";
import { findByName } from "./registry.js";

export const DEFAULT_COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
export const DEFAULT_COPILOT_BASE_URL = "https://api.githubcopilot.com";
export const DEFAULT_GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const DEFAULT_GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const DEFAULT_GITHUB_USER_URL = "https://api.github.com/user";
export const GITHUB_COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const GITHUB_COPILOT_SCOPE = "read:user";
export const TOKEN_FILENAME = "github-copilot.json";
export const USER_AGENT = "memmy-agent/0.1";
export const EDITOR_VERSION = "vscode/1.99.0";
export const EDITOR_PLUGIN_VERSION = "copilot-chat/0.26.0";
const EXPIRY_SKEW_SECONDS = 60;
const LONG_LIVED_TOKEN_MS = 315360000 * 1000;

type GitHubCopilotInit = {
  apiKey?: string | null;
  apiBase?: string | null;
  defaultModel?: string | null;
  extraHeaders?: Record<string, string> | null;
  spec?: any;
};

export class FileTokenStorage {
  tokenPath: string;

  constructor(tokenPath: string = process.env.OAUTH_CLI_KIT_TOKEN_PATH ?? path.join(getDataDir(), "auth", TOKEN_FILENAME)) {
    this.tokenPath = tokenPath;
  }

  getTokenPath(): string {
    return this.tokenPath;
  }

  load(): Record<string, any> | null {
    try {
      if (!fs.existsSync(this.tokenPath)) return null;
      return JSON.parse(fs.readFileSync(this.tokenPath, "utf8"));
    } catch {
      return null;
    }
  }

  save(token: Record<string, any>): void {
    fs.mkdirSync(path.dirname(this.tokenPath), { recursive: true });
    fs.writeFileSync(this.tokenPath, `${JSON.stringify(token, null, 2)}\n`, "utf8");
  }

  delete(): void {
    fs.rmSync(this.tokenPath, { force: true });
  }
}

export function getStorage(): FileTokenStorage {
  return new FileTokenStorage();
}

export function copilotHeaders(token: string): Record<string, string> {
  return {
    Authorization: `token ${token}`,
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    "Editor-Version": EDITOR_VERSION,
    "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
  };
}

function loadGithubToken(): Record<string, any> | null {
  const token = getStorage().load();
  return token?.access ? token : null;
}

export function getGitHubCopilotLoginStatus(): Record<string, any> | null {
  return loadGithubToken();
}

export async function loginGitHubCopilotDeviceFlow({
  printFn = console.log,
  fetchImpl = fetch,
  sleepFn = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
}: {
  printFn?: (message: string) => void;
  fetchImpl?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
} = {}): Promise<Record<string, any>> {
  const devicePayload = await postGithubForm(fetchImpl, DEFAULT_GITHUB_DEVICE_CODE_URL, {
    client_id: GITHUB_COPILOT_CLIENT_ID,
    scope: GITHUB_COPILOT_SCOPE,
  });
  const deviceCode = String(devicePayload.device_code ?? "");
  const userCode = String(devicePayload.user_code ?? "");
  const verifyUrl = String(devicePayload.verification_uri ?? devicePayload.verification_uri_complete ?? "");
  const verifyComplete = String(devicePayload.verification_uri_complete ?? verifyUrl);
  let interval = Math.max(1, Number(devicePayload.interval ?? 5));
  const expiresIn = Math.max(1, Number(devicePayload.expires_in ?? 900));
  if (!deviceCode || !userCode || !verifyUrl) throw new Error("GitHub device flow did not return a complete device code payload.");

  printFn(`Open: ${verifyUrl}`);
  printFn(`Code: ${userCode}`);
  if (verifyComplete && verifyComplete !== verifyUrl) printFn(`Direct link: ${verifyComplete}`);

  const deadline = Date.now() + expiresIn * 1000;
  let accessToken = "";
  let tokenExpiresIn = LONG_LIVED_TOKEN_MS;
  while (Date.now() < deadline) {
    const pollPayload = await postGithubForm(fetchImpl, DEFAULT_GITHUB_ACCESS_TOKEN_URL, {
      client_id: GITHUB_COPILOT_CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (pollPayload.access_token) {
      accessToken = String(pollPayload.access_token);
      tokenExpiresIn = Math.max(1, Number(pollPayload.expires_in ?? LONG_LIVED_TOKEN_MS / 1000)) * 1000;
      break;
    }
    const error = String(pollPayload.error ?? "");
    if (error === "authorization_pending") {
      await sleepFn(interval * 1000);
      continue;
    }
    if (error === "slow_down") {
      interval += 5;
      await sleepFn(interval * 1000);
      continue;
    }
    if (error === "expired_token") throw new Error("GitHub device code expired. Please run login again.");
    if (error === "access_denied") throw new Error("GitHub device flow was denied.");
    if (error) throw new Error(String(pollPayload.error_description ?? error));
    await sleepFn(interval * 1000);
  }
  if (!accessToken) throw new Error("GitHub device flow timed out.");

  const user = await fetchImpl(DEFAULT_GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
    },
  });
  if (!user.ok) throw new Error(`GitHub user lookup failed: HTTP ${user.status}`);
  const userPayload: any = await user.json();
  const accountId = userPayload.login ?? (userPayload.id == null ? null : String(userPayload.id));
  const token = {
    access: accessToken,
    refresh: "",
    expires: Date.now() + tokenExpiresIn,
    account_id: accountId ?? undefined,
  };
  getStorage().save(token);
  return token;
}

export class GitHubCopilotProvider extends OpenAICompatProvider {
  copilotAccessToken: string | null = null;
  copilotExpiresAt = 0;

  constructor(init: GitHubCopilotInit = {}) {
    super({
      apiKey: init.apiKey ?? "no-key",
      apiBase: init.apiBase ?? DEFAULT_COPILOT_BASE_URL,
      defaultModel: init.defaultModel ?? "github-copilot/gpt-4.1",
      extraHeaders: {
        "Editor-Version": EDITOR_VERSION,
        "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
        "User-Agent": USER_AGENT,
        ...(init.extraHeaders ?? {}),
      },
      spec: init.spec ?? findByName("github_copilot"),
    });
  }

  override getDefaultModel(): string {
    return stripModelPrefix(this.model ?? "gpt-4.1");
  }

  protected override normalizeModel(model: string): string {
    return stripModelPrefix(model);
  }

  async getCopilotAccessToken(): Promise<string> {
    const now = Date.now() / 1000;
    if (this.copilotAccessToken && now < this.copilotExpiresAt - EXPIRY_SKEW_SECONDS) {
      return this.copilotAccessToken;
    }
    const githubToken = loadGithubToken();
    if (!githubToken?.access) {
      throw new Error("GitHub Copilot is not logged in. Run: memmy provider login github-copilot");
    }
    const response = await fetch(DEFAULT_COPILOT_TOKEN_URL, { headers: copilotHeaders(String(githubToken.access)) });
    if (!response.ok) throw new Error(`GitHub Copilot token exchange failed: HTTP ${response.status}`);
    const payload: any = await response.json();
    const token = payload?.token;
    if (!token) throw new Error("GitHub Copilot token exchange returned no token.");
    const expiresAt = Number(payload.expires_at ?? 0);
    this.copilotExpiresAt = Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : Date.now() / 1000 + Number(payload.refresh_in ?? 1500);
    this.copilotAccessToken = String(token);
    return this.copilotAccessToken;
  }

  async refreshClientApiKey(): Promise<string> {
    const token = await this.getCopilotAccessToken();
    this.apiKey = token;
    this.apiKeyForClient = token;
    const client = await this.ensureClient();
    client.apiKey = token;
    return token;
  }

  override async chat(args: any) {
    await this.refreshClientApiKey();
    return super.chat(args);
  }

  override async chatStream(args: any) {
    await this.refreshClientApiKey();
    return super.chatStream(args);
  }
}

async function postGithubForm(fetchImpl: typeof fetch, url: string, data: Record<string, string>): Promise<Record<string, any>> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    body: new URLSearchParams(data),
  });
  if (!response.ok) throw new Error(`GitHub OAuth request failed: HTTP ${response.status}`);
  return response.json() as Promise<Record<string, any>>;
}

function stripModelPrefix(model: string): string {
  return model.replace(/^(github[-_]copilot|copilot)\//, "");
}
export const stripCopilotModelPrefix = stripModelPrefix;
