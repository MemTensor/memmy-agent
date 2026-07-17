import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHookContext } from "../../../src/core/agent-runtime/hook.js";
import type { AgentHook } from "../../../src/core/agent-runtime/hook.js";
import { Config } from "../../../src/config/schema.js";
import { createByokTokenUsageRecorder, installByokTokenUsage } from "../../../src/integrations/byok-token-usage/register.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("installByokTokenUsage", () => {
  it("installs a lazy hook when runtime.json is missing and records after it appears", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-byok-token-"));
    const runtimeConfigPath = join(tempDir, "runtime.json");
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const hooks: AgentHook[] = [];

    const integration = installByokTokenUsage(new Config(), {
      hooks,
      runtimeConfigPath,
      env: {},
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(integration.enabled).toBe(true);
    expect(hooks).toHaveLength(1);

    const ctx = new AgentHookContext({
      spec: {
        sessionKey: "cli:direct",
        model: "gpt-4.1-mini",
      },
    });
    await hooks[0]?.beforeRun(ctx);
    await hooks[0]?.afterRun(ctx, { usage: { prompt_tokens: 1 } });
    expect(fetchImpl).not.toHaveBeenCalled();

    writeFileSync(runtimeConfigPath, JSON.stringify({
      baseUrl: "http://127.0.0.1:62934",
      localToken: "runtime-token",
    }));

    await hooks[0]?.beforeRun(ctx);
    await hooks[0]?.afterRun(ctx, { usage: { prompt_tokens: 2, completion_tokens: 3 } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not install a hook in Vitest runtime", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-byok-token-"));
    const runtimeConfigPath = join(tempDir, ".memmy", "runtime.json");
    mkdirSync(join(tempDir, ".memmy"), { recursive: true });
    writeFileSync(runtimeConfigPath, JSON.stringify({
      baseUrl: "http://127.0.0.1:62934",
      localToken: "runtime-token",
    }));
    const hooks: AgentHook[] = [];

    const integration = installByokTokenUsage(configFixture(), {
      hooks,
      runtimeConfigPath,
      env: { NODE_ENV: "test" },
    });

    expect(integration.enabled).toBe(false);
    expect(hooks).toEqual([]);
  });

  it("installs a hook using the latest runtime.json and resolves provider names from config", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-byok-token-"));
    const runtimeConfigPath = join(tempDir, ".memmy", "runtime.json");
    mkdirSync(join(tempDir, ".memmy"), { recursive: true });
    writeFileSync(runtimeConfigPath, JSON.stringify({
      baseUrl: "http://127.0.0.1:62934",
      localToken: "runtime-token",
    }));
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const hooks: AgentHook[] = [];

    const integration = installByokTokenUsage(configFixture(), {
      hooks,
      runtimeConfigPath,
      env: {},
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(integration.enabled).toBe(true);
    expect(hooks).toHaveLength(1);

    writeFileSync(runtimeConfigPath, JSON.stringify({
      baseUrl: "http://127.0.0.1:63000",
      localToken: "runtime-token-2",
    }));

    const ctx = new AgentHookContext({
      spec: {
        sessionKey: "cli:direct",
        model: "gpt-4.1-mini",
      },
    });
    await hooks[0]?.beforeRun(ctx);
    await hooks[0]?.afterRun(ctx, { usage: { prompt_tokens: 3, completion_tokens: 4 } });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("http://127.0.0.1:63000/api/app/byok-token-usage/events");
    expect(init.headers).toMatchObject({
      "x-memmy-local-token": "runtime-token-2",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      kind: "agent_chat",
      source: "agent",
      metadata: {
        provider: "openai",
        modelId: "gpt-4.1-mini",
      },
      totalTokens: 7,
    });
  });

  it("creates a standalone recorder that uses the existing agent_chat usage event shape", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-byok-token-recorder-"));
    const runtimeConfigPath = join(tempDir, ".memmy", "runtime.json");
    mkdirSync(join(tempDir, ".memmy"), { recursive: true });
    writeFileSync(runtimeConfigPath, JSON.stringify({
      baseUrl: "http://127.0.0.1:63001",
      localToken: "runtime-token",
    }));
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const recorder = createByokTokenUsageRecorder(configFixture(), {
      runtimeConfigPath,
      fetchImpl: fetchImpl as typeof fetch,
    });
    await recorder.recordAgentChatUsage({
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
      sessionKey: "websocket:chat-title",
      chatId: "chat-title",
      modelId: "gpt-4.1-mini",
      operation: "session_title",
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("http://127.0.0.1:63001/api/app/byok-token-usage/events");
    expect(JSON.parse(String(init.body))).toMatchObject({
      kind: "agent_chat",
      source: "agent",
      metadata: {
        operation: "session_title",
        sessionKey: "websocket:chat-title",
        chatId: "chat-title",
        provider: "openai",
        modelId: "gpt-4.1-mini",
      },
      totalTokens: 11,
    });
  });
});

function configFixture(): Config {
  return new Config({
    agents: {
      defaults: {
        provider: "openai",
        model: "gpt-4.1-mini",
      },
    },
    providers: {
      openai: {
        apiKey: "sk-test",
      },
    },
  });
}
