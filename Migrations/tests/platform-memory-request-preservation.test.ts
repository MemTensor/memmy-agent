import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeRuntimeModelCatalogV107 } from "../src/migrations/v1.0.7/0001-normalize-runtime-model-catalog.js";
import { repairRuntimeModelCatalogV109 } from "../src/migrations/v1.0.9/0001-repair-runtime-model-catalog.js";
import { removePlatformMemoryDuplicatesV124 } from "../src/migrations/v1.2.4/0001-remove-platform-memory-duplicates.js";
import { DEFAULT_MEMMY_CONFIG, loadMemmyConfig } from "../../Memory/src/config/index.js";
import { resolveAssignedModel, type RuntimeModelCatalog } from "../../Memory/src/contracts/model-catalog-resolver.js";
import { createLlmClient } from "../../Memory/src/model/llm.js";
import { createEmbedder } from "../../Memory/src/model/embedder.js";

const roots: string[] = [];
const localBase = "http://127.0.0.1:1234/v1";
type CapturedRequest = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function captureRequests(file: string, useCatalog = false): Promise<CapturedRequest[]> {
  const calls: CapturedRequest[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(url.endsWith("/embeddings") ? { data: [{ embedding: [1, 0, 0] }] }
      : { choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }),
    { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const config = loadMemmyConfig(file).config;
    const raw = YAML.parse(await fs.readFile(file, "utf8"));
    const connection = (capability: "memory_summary" | "memory_evolution" | "embedding") => {
      const selected = resolveAssignedModel({ catalog: raw as RuntimeModelCatalog, mode: "byok", activeAccountId: "owner-a", capability });
      expect(selected.ok).toBe(true);
      if (!selected.ok) throw new Error(`Migrated ${capability} assignment unavailable`);
      return { endpoint: selected.provider.apiBase, model: selected.context.model, apiKey: selected.provider.apiKey,
        extraHeaders: { ...selected.provider.extraHeaders }, extraBody: { ...selected.provider.extraBody } };
    };
    for (const role of ["summary", "evolution"] as const) {
      const client = createLlmClient({ ...config[role], ...(useCatalog ? connection(`memory_${role}`) : {}), maxRetries: 0 });
      expect(client.isConfigured()).toBe(true);
      await client.complete([{ role: "user", content: "synthetic migration check" }], { operation: "test.migration" });
    }
    expect(config.embedding).toMatchObject({ provider: "openai_compatible", mode: "custom", endpoint: localBase });
    await createEmbedder({ ...config.embedding, ...(useCatalog ? connection("embedding") : {}), cache: false, maxRetries: 0 }).embed(["synthetic migration check"]);
    const cloud = raw.modelAssignments
      ? resolveAssignedModel({ catalog: raw as RuntimeModelCatalog, mode: "byok", activeAccountId: "owner-a", capability: "agent" })
      : undefined;
    if (raw.modelAssignments) expect(cloud?.ok).toBe(true);
    const provider = cloud?.ok ? cloud.provider : { ...raw.providers.openai, ...raw.providers.openai.endpoints.cloud };
    const cloudModel = cloud?.ok ? cloud.context.model : raw.agents.defaults.model;
    await createLlmClient({ ...DEFAULT_MEMMY_CONFIG.summary, provider: "openai_compatible", sourceProvider: "openai",
      endpoint: provider.apiBase, model: cloudModel, apiKey: provider.apiKey,
      extraHeaders: { ...provider.extraHeaders }, extraBody: { ...provider.extraBody }, maxRetries: 0 })
      .complete([{ role: "user", content: "synthetic cloud check" }], { operation: "test.migration" });
    return calls;
  } finally { vi.unstubAllGlobals(); }
}

describe.each([normalizeRuntimeModelCatalogV107, repairRuntimeModelCatalogV109])("real Memory request preservation: $id", migration => {
  it.each(["missing-key", "empty-key", "custom-options", "provider-only-options"])("keeps fixed/custom requests executable and isolated (%s)", async shape => {
    const noAuth = shape === "missing-key" || shape === "empty-key";
    const cloud: Record<string, any> = { apiKey: "unrelated-cloud-fixture-token", endpoints: {
      cloud: { apiBase: "https://cloud.example.test/v1", protocol: "openai-chat-completions" },
      sameAddress: { apiBase: localBase, protocol: "openai-chat-completions" },
    } };
    if (!noAuth) {
      cloud.extraHeaders = { Authorization: "Bearer unrelated-header-token", "X-Cloud-Account": "other" };
      cloud.extraBody = { model: "unrelated-model", temperature: 0.9 };
    }
    const memory: Record<string, any> = { storage: { sqlitePath: "untouched-memory.sqlite" }, roleRouting: { summary: "fixed", evolution: "fixed" } };
    for (const role of ["summary", "evolution", "embedding"]) {
      memory[role] = { provider: "openai_compatible", sourceProvider: "memmy_account", endpoint: localBase,
        model: role === "embedding" ? "embedding" : `memory_${role}`,
        ...(shape === "empty-key" ? { apiKey: "" } : noAuth ? {} : { apiKey: "synthetic-local-key" }),
        ...(shape === "custom-options" ? { extraHeaders: { "X-User": "retained" }, extraBody: { seed: 1 } } : {}),
        ...(role === "embedding" ? { mode: "custom" } : {}) };
    }
    const initial = { app: { userMode: "byok", userId: "owner-a" }, providers: { openai: cloud },
      modelPresets: { cloud: { provider: "openai", endpoint: "cloud", model: "cloud-model", source: "byok", capabilities: ["agent"] } },
      agents: { defaults: { provider: "openai", model: "cloud-model", apiBase: "https://cloud.example.test/v1" } }, memmyMemory: memory };
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-migration-requests-")); roots.push(root);
    const file = path.join(root, "config.yaml"); await fs.writeFile(file, YAML.stringify(initial));
    const before = await captureRequests(file);
    const context = { profileWorkspace: root, sessionsDir: path.join(root, "sessions"), runtimeConfigFile: file,
      sessionDagDir: path.join(root, "dag"), logger: { info() {}, warn() {}, error() {} } };
    await migration.up(context);
    const saved = YAML.parse(await fs.readFile(file, "utf8"));
    expect(saved.providers.openai).toMatchObject(cloud);
    expect(saved.memmyMemory).toEqual(memory);
    const { endpoints: originalEndpoints, ...originalDefaults } = cloud;
    const { endpoints: savedEndpoints, ...savedDefaults } = saved.providers.openai;
    expect(savedDefaults).toEqual(originalDefaults);
    for (const [id, endpoint] of Object.entries(originalEndpoints)) expect(savedEndpoints[id]).toEqual(endpoint);
    for (const assignment of ["memorySummary", "memoryEvolution", "embedding"]) {
      const id = saved.modelAssignments.byok[assignment];
      expect(id).toEqual(expect.any(String));
      const preset = saved.modelPresets[id];
      expect(preset.provider).toBe("openai");
      expect(savedEndpoints[preset.endpoint].inheritProviderDefaults).toBe(false);
    }
    const after = await captureRequests(file);
    expect(after).toEqual(before);
    expect(await captureRequests(file, true)).toEqual(before);
    expect(after).toHaveLength(4);
    for (const request of after.slice(0, 3)) {
      expect(request.url.startsWith(localBase)).toBe(true);
      expect(request.headers.authorization).toBe(noAuth ? undefined : "Bearer synthetic-local-key");
      expect(request.headers["x-cloud-account"]).toBeUndefined();
      expect(request.body.model).not.toBe("unrelated-model");
    }
    await removePlatformMemoryDuplicatesV124.up(context);
    expect(await captureRequests(file)).toEqual(before);
    const once = await fs.readFile(file, "utf8");
    expect(await migration.up(context)).toMatchObject({ changed: 0 });
    expect(await fs.readFile(file, "utf8")).toBe(once);
  });
});
