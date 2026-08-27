import { CodexToken, CodexTokenStorage, getCodexStorage } from "./openai-codex-provider.js";

export type OpenAICodexOAuthToken = {
  accountId: string;
  access: string;
};

export type OpenAICodexOAuthIO = {
  print?: (text: string) => void;
  prompt?: (text: string) => string | Promise<string>;
  storage?: CodexTokenStorage;
  env?: NodeJS.ProcessEnv;
};

function tokenFromEnv(env: NodeJS.ProcessEnv): CodexToken | null {
  const accountId = env.OPENAI_CODEX_ACCOUNT_ID ?? env.CHATGPT_ACCOUNT_ID;
  const access = env.OPENAI_CODEX_ACCESS_TOKEN ?? env.CHATGPT_ACCESS_TOKEN;
  return accountId && access ? { accountId, access } : null;
}

export function normalizeOpenAICodexToken(token: CodexToken | null | undefined): OpenAICodexOAuthToken | null {
  const accountId = token?.accountId ?? token?.account_id ?? "";
  const access = token?.access ?? token?.accessToken ?? "";
  return accountId && access ? { accountId, access } : null;
}

export function getOpenAICodexToken({
  storage = getCodexStorage(),
  env = process.env,
}: {
  storage?: CodexTokenStorage;
  env?: NodeJS.ProcessEnv;
} = {}): OpenAICodexOAuthToken | null {
  return normalizeOpenAICodexToken(tokenFromEnv(env)) ?? normalizeOpenAICodexToken(storage.load());
}

async function defaultPrompt(text: string): Promise<string> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(text);
  } finally {
    rl.close();
  }
}

export async function loginOpenAICodexInteractive({
  print = (text: string) => console.log(text),
  prompt = defaultPrompt,
  storage = getCodexStorage(),
  env = process.env,
}: OpenAICodexOAuthIO = {}): Promise<OpenAICodexOAuthToken | null> {
  const existing = getOpenAICodexToken({ storage, env });
  if (existing) return existing;

  print("Starting interactive OAuth login...");
  const accountId = String(await prompt("OpenAI Codex account ID: ")).trim();
  const access = String(await prompt("OpenAI Codex access token: ")).trim();
  if (!accountId || !access) return null;

  const token = { accountId, account_id: accountId, access };
  storage.save(token);
  return { accountId, access };
}
