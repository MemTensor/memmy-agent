import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { createMemmyConfigWriter } from "../../infrastructure/memmy-config/index.js";
import { createAppConfigService } from "../app-config-service.js";
import { createHttpModelConfigTester } from "../model-config-tester.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(endpoint: Record<string, unknown>, provider: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "memmy-endpoint-probe-")); roots.push(root);
  const configPath = join(root, "config.yaml");
  writeFileSync(configPath, YAML.stringify({ providers: { openai: { ...provider, endpoints: { local: {
    apiBase: "http://127.0.0.1:18789/v1", protocol: "openai-chat-completions", ...endpoint
  } } } } }));
  const requests: Request[] = [];
  const service = createAppConfigService({ bootstrapRepository: {} as never,
    memmyConfigWriter: createMemmyConfigWriter({ configPath }),
    modelConfigTester: createHttpModelConfigTester({ fetch: async (url, init) => {
      requests.push(new Request(url, init));
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }), { status: 200 });
    } })
  });
  const input = { provider: "openai_compatible" as const, endpointId: "local", protocol: "openai-chat-completions" as const,
    apiBase: "http://127.0.0.1:18789/v1", modelId: "local-model" };
  return { service, requests, input };
}

describe("saved independent endpoints through the real model test service and HTTP probe", () => {
  it("sends no Authorization for a saved no-auth endpoint despite populated Provider defaults", async () => {
    const h = fixture({ inheritProviderDefaults: false }, { apiKey: "provider-secret", extraHeaders: { Authorization: "Bearer provider-header" } });
    await expect(h.service.testModelConfig(h.input)).resolves.toMatchObject({ ok: true });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.url).toBe("http://127.0.0.1:18789/v1/chat/completions");
    expect(h.requests[0]!.headers.has("Authorization")).toBe(false);
    expect(h.requests[0]!.headers.has("x-api-key")).toBe(false);
  });
  it("keeps endpoint-owned Authorization and headers while excluding Provider headers", async () => {
    const h = fixture({ inheritProviderDefaults: false, extraHeaders: { Authorization: "Bearer endpoint-owned", "x-local": "local" } },
      { apiKey: "provider-secret", extraHeaders: { Authorization: "Bearer provider-header", "x-provider": "must-not-send" } });
    await expect(h.service.testModelConfig(h.input)).resolves.toMatchObject({ ok: true });
    expect(h.requests[0]!.headers.get("Authorization")).toBe("Bearer endpoint-owned");
    expect(h.requests[0]!.headers.get("x-local")).toBe("local");
    expect(h.requests[0]!.headers.has("x-provider")).toBe(false);
  });
  it("preserves endpoint-owned keys when independent, and legacy Provider keys by default", async () => {
    for (const independent of [false, true]) {
      const h = fixture(independent ? { inheritProviderDefaults: false, apiKey: "endpoint-secret" } : {}, { apiKey: "provider-secret" });
      await expect(h.service.testModelConfig(h.input)).resolves.toMatchObject({ ok: true });
      expect(h.requests[0]!.headers.get("Authorization")).toBe(independent ? "Bearer endpoint-secret" : "Bearer provider-secret");
    }
  });
  it("keeps explicit endpoint Authorization even when a replacement key is supplied", async () => {
    const h = fixture({ inheritProviderDefaults: false, apiKey: "old-key", extraHeaders: { authorization: "Bearer endpoint-owned" } });
    await expect(h.service.testModelConfig({ ...h.input, apiKey: "replacement-key" })).resolves.toMatchObject({ ok: true });
    expect(h.requests[0]!.headers.get("Authorization")).toBe("Bearer endpoint-owned");
  });

  it("does not send saved endpoint headers to an edited URL before that endpoint is saved", async () => {
    const h = fixture({ inheritProviderDefaults: false, extraHeaders: { Authorization: "Bearer endpoint-owned" } });
    await expect(h.service.testModelConfig({ ...h.input, apiBase: "http://127.0.0.1:18790/v1" })).rejects.toThrow(/API Key/);
    expect(h.requests).toEqual([]);
  });

  it("does not let a self-reported flag bypass the default missing-key rule", async () => {
    const h = fixture({});
    await expect(h.service.testModelConfig({ ...h.input, inheritProviderDefaults: false } as typeof h.input))
      .rejects.toThrow(/API Key/);
    expect(h.requests).toEqual([]);
  });
});
