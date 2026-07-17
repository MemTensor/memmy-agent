import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getStorage, GitHubCopilotProvider, loginGitHubCopilotDeviceFlow } from "../../src/providers/github-copilot-provider.js";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";
import { findByName } from "../../src/providers/registry.js";

describe("GitHub Copilot provider routing", () => {
  it("opts GitHub Copilot GPT-5 and o-series models into Responses API on a non-OpenAI base", () => {
    const provider = new OpenAICompatProvider({
      apiKey: "token",
      apiBase: "https://api.githubcopilot.com",
      defaultModel: "github_copilot/gpt-5.4-mini",
      spec: findByName("github_copilot"),
    });

    expect(provider.shouldUseResponsesApi("github_copilot/gpt-5.4-mini", null)).toBe(true);
    expect(provider.shouldUseResponsesApi("github_copilot/o3", null)).toBe(true);
  });

  it("strips GitHub Copilot prefixes before sending GPT-5 requests through Responses API", async () => {
    const fetchMock = vi.fn(async (url: string, init: any) => ({
      ok: true,
      json: async () => ({
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        status: "completed",
      }),
      text: async () => "",
      init,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new GitHubCopilotProvider({
      apiKey: "token",
      apiBase: "https://api.githubcopilot.com",
      defaultModel: "github-copilot/gpt-5.1",
      spec: findByName("github-copilot"),
    });
    vi.spyOn(provider, "getCopilotAccessToken").mockResolvedValue("token");

    await provider.chat({ messages: [{ role: "user", content: "hi" }] });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.githubcopilot.com/responses");
    expect(body.model).toBe("gpt-5.1");
    expect(body.input[0].role).toBe("user");
  });

  it("stores GitHub Copilot OAuth tokens under the auth data directory", () => {
    const oldDataDir = process.env.MEMMY_AGENT_DATA_DIR;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-copilot-storage-"));
    process.env.MEMMY_AGENT_DATA_DIR = root;
    try {
      const storage = getStorage();
      storage.save({ access: "gho_test", expires: 123 });

      expect(path.basename(storage.getTokenPath())).toBe("github-copilot.json");
      expect(path.basename(path.dirname(storage.getTokenPath()))).toBe("auth");
      expect(storage.load()?.access).toBe("gho_test");
      storage.delete();
      expect(fs.existsSync(storage.getTokenPath())).toBe(false);
    } finally {
      if (oldDataDir == null) delete process.env.MEMMY_AGENT_DATA_DIR;
      else process.env.MEMMY_AGENT_DATA_DIR = oldDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs GitHub device flow and persists the OAuth token", async () => {
    const oldPath = process.env.OAUTH_CLI_KIT_TOKEN_PATH;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-gh-device-"));
    process.env.OAUTH_CLI_KIT_TOKEN_PATH = path.join(root, "github-copilot.json");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_code: "device-1",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        interval: 1,
        expires_in: 60,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "authorization_pending" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "gho_token", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ login: "octocat" }), { status: 200 }));
    const output: string[] = [];
    try {
      const token = await loginGitHubCopilotDeviceFlow({
        fetchImpl: fetchMock as any,
        sleepFn: async () => undefined,
        printFn: (message) => output.push(message),
      });

      expect(token.access).toBe("gho_token");
      expect(token.account_id).toBe("octocat");
      expect(getStorage().load()?.access).toBe("gho_token");
      expect(output).toContain("Code: ABCD-1234");
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      if (oldPath == null) delete process.env.OAUTH_CLI_KIT_TOKEN_PATH;
      else process.env.OAUTH_CLI_KIT_TOKEN_PATH = oldPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
