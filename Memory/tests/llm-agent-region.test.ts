import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmConfig } from "../src/config/index.js";
import {
  packagedDesktopEditionManifestPath,
  resolveMemoryAgentRegion
} from "../src/model/agent-region.js";
import { createLlmClient } from "../src/model/llm.js";
import type { MemoryLlmModelRole } from "../src/model/token-usage.js";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("memory account model agent region", () => {
  it("locates desktop-edition.json beside the packaged desktop runtime", () => {
    const modelDirectory = resolve("app-root/dist/runtime/memory/src/model");

    expect(packagedDesktopEditionManifestPath(modelDirectory)).toBe(
      resolve("app-root/dist/main/desktop-edition.json")
    );
  });

  it.each([
    [{ accountChannel: "email" }, "intl"],
    [{ accountChannel: "phone" }, "cn"],
    [{ edition: "intl" }, "intl"],
    [{ edition: "cn" }, "cn"],
    [{ edition: "cn", accountChannel: "email" }, "cn"],
    [{ edition: "intl", accountChannel: "phone" }, "intl"]
  ] as const)("resolves account region from packaged identity %j", (manifest, expected) => {
    expect(resolveMemoryAgentRegion("account", {
      manifestPath: writeManifest(manifest),
      env: {
        MEMMY_ACCOUNT_CHANNEL: expected === "intl" ? "phone" : "email",
        MEMMY_APP_EDITION: expected === "intl" ? "cn" : "intl"
      }
    })).toBe(expected);
  });

  it("falls back to app edition and then accountChannel when the manifest is unavailable", () => {
    const manifestPath = missingManifestPath();

    expect(resolveMemoryAgentRegion("account", {
      manifestPath,
      env: { MEMMY_ACCOUNT_CHANNEL: "email", MEMMY_APP_EDITION: "cn" }
    })).toBe("cn");
    expect(resolveMemoryAgentRegion("account", {
      manifestPath,
      env: { MEMMY_ACCOUNT_CHANNEL: "phone", MEMMY_APP_EDITION: "intl" }
    })).toBe("intl");
    expect(resolveMemoryAgentRegion("account", {
      manifestPath,
      env: { MEMMY_ACCOUNT_CHANNEL: "email" }
    })).toBe("intl");
    expect(resolveMemoryAgentRegion("account", {
      manifestPath,
      env: { MEMMY_ACCOUNT_CHANNEL: "phone" }
    })).toBe("cn");
    expect(resolveMemoryAgentRegion("account", {
      manifestPath,
      env: {}
    })).toBe("cn");
  });

  it("does not resolve an agent region outside account mode", () => {
    expect(resolveMemoryAgentRegion("byok", {
      manifestPath: writeManifest({ edition: "intl", accountChannel: "email" }),
      env: { MEMMY_ACCOUNT_CHANNEL: "email" }
    })).toBeUndefined();
  });

  it.each([
    ["memory_summary", "cn"],
    ["memory_summary", "intl"],
    ["memory_evolution", "cn"],
    ["memory_evolution", "intl"]
  ] as const)("sends the %s account model request with X-Agent-Region=%s", async (modelRole, agentRegion) => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "ok" } }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createLlmClient(llmConfig(modelRole), { modelRole, agentRegion });
    await expect(client.complete(
      [{ role: "user", content: "run" }],
      { operation: modelRole === "memory_summary" ? "capture.summarize" : "skill.crystallize" }
    )).resolves.toBe("ok");

    expect(requestHeaders(fetchMock)).toMatchObject({
      authorization: "Bearer account-token",
      "X-Agent-Region": agentRegion
    });
  });

  it("does not send X-Agent-Region for BYOK model requests", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "ok" } }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createLlmClient(llmConfig("memory_summary"), {
      modelRole: "memory_summary",
      agentRegion: resolveMemoryAgentRegion("byok", {
        manifestPath: writeManifest({ edition: "intl", accountChannel: "email" }),
        env: { MEMMY_ACCOUNT_CHANNEL: "email" }
      })
    });
    await client.complete(
      [{ role: "user", content: "run" }],
      { operation: "capture.summarize" }
    );

    expect(requestHeaders(fetchMock)).not.toHaveProperty("X-Agent-Region");
  });
});

function llmConfig(modelRole: MemoryLlmModelRole): LlmConfig {
  return {
    provider: "openai_compatible",
    endpoint: "https://api.example.test/v1",
    model: modelRole,
    apiKey: "account-token",
    enableThinking: false,
    temperature: 0,
    maxTokens: 512,
    timeoutMs: 60_000,
    maxRetries: 0,
    malformedRetries: 0
  };
}

function requestHeaders(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): Record<string, string> {
  const headers = fetchMock.mock.calls[0]?.[1]?.headers;
  if (!headers || Array.isArray(headers) || headers instanceof Headers) {
    throw new Error("expected plain request headers");
  }
  return headers;
}

function writeManifest(value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-agent-region-"));
  roots.push(root);
  const path = join(root, "desktop-edition.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function missingManifestPath(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-agent-region-missing-"));
  roots.push(root);
  return join(root, "desktop-edition.json");
}
