import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexTokenStorage } from "../../src/providers/openai-codex-provider.js";
import {
  getOpenAICodexToken,
  loginOpenAICodexInteractive,
  normalizeOpenAICodexToken,
} from "../../src/providers/openai-codex-oauth.js";

const roots: string[] = [];

function tempTokenPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-codex-oauth-"));
  roots.push(root);
  return path.join(root, "auth", "codex.json");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("OpenAI Codex OAuth helpers", () => {
  it("normalizes stored token shapes", () => {
    expect(normalizeOpenAICodexToken({ account_id: "acct", accessToken: "token" })).toEqual({
      accountId: "acct",
      access: "token",
    });
    expect(normalizeOpenAICodexToken({ access: "token" })).toBeNull();
  });

  it("prefers env token and falls back to storage", () => {
    const storage = new CodexTokenStorage(tempTokenPath());
    storage.save({ account_id: "stored", access: "stored-token" });

    expect(getOpenAICodexToken({ storage, env: {} })).toEqual({
      accountId: "stored",
      access: "stored-token",
    });
    expect(getOpenAICodexToken({
      storage,
      env: {
        OPENAI_CODEX_ACCOUNT_ID: "env",
        OPENAI_CODEX_ACCESS_TOKEN: "env-token",
      },
    })).toEqual({
      accountId: "env",
      access: "env-token",
    });
  });

  it("prompts interactively and saves the token when no token exists", async () => {
    const storage = new CodexTokenStorage(tempTokenPath());
    const prompt = vi.fn()
      .mockResolvedValueOnce("acct-interactive")
      .mockResolvedValueOnce("access-interactive");
    const print = vi.fn();

    const token = await loginOpenAICodexInteractive({ storage, env: {}, prompt, print });

    expect(token).toEqual({ accountId: "acct-interactive", access: "access-interactive" });
    expect(storage.load()).toEqual({
      accountId: "acct-interactive",
      account_id: "acct-interactive",
      access: "access-interactive",
    });
    expect(print).toHaveBeenCalledWith("Starting interactive OAuth login...");
  });
});
