import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeRuntimeModelCatalogV107 } from "../src/migrations/v1.0.7/0001-normalize-runtime-model-catalog.js";
import { repairRuntimeModelCatalogV109 } from "../src/migrations/v1.0.9/0001-repair-runtime-model-catalog.js";
import { removePlatformMemoryDuplicatesV124 } from "../src/migrations/v1.2.4/0001-remove-platform-memory-duplicates.js";
import { loadMemmyConfig } from "../../Memory/src/config/index.js";

const roots: string[] = [];
const platformAddress = "https://platform.example.test/api/agentExternal/v1";
const roles = [
  { role: "summary", capability: "memory_summary", assignment: "memorySummary" },
  { role: "evolution", capability: "memory_evolution", assignment: "memoryEvolution" },
  { role: "embedding", capability: "embedding", assignment: "embedding" },
] as const;

function initialConfig(): Record<string, any> {
  return {
    app: { userMode: "byok", userId: "owner-a" },
    providers: { memmy_account: { ownerAccountId: "owner-a", apiKey: "platform-fixture-token",
      endpoints: { platform: { apiBase: platformAddress, protocol: "memmy-account" } } } },
    modelAssignments: { account: { ownerAccountId: "owner-a" } },
    memmyMemory: { storage: { sqlitePath: "preserved-memory.sqlite" },
      roleRouting: { summary: "fixed", evolution: "fixed" } },
  };
}

function legacyConnection(model: string): Record<string, any> {
  return { provider: "openai_compatible", sourceProvider: "memmy_account", endpoint: platformAddress,
    model, apiKey: "platform-fixture-token", ...(model === "embedding" ? { mode: "custom" } : {}) };
}

async function fixture(value: unknown) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-platform-legacy-")); roots.push(root);
  const file = path.join(root, "config.yaml");
  await fs.writeFile(file, YAML.stringify(value));
  return { file, read: async (): Promise<Record<string, any>> => YAML.parse(await fs.readFile(file, "utf8")), context: {
    profileWorkspace: root, sessionsDir: path.join(root, "sessions"), runtimeConfigFile: file,
    sessionDagDir: path.join(root, "dag"), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe.each([normalizeRuntimeModelCatalogV107, repairRuntimeModelCatalogV109])("legacy platform connection preservation: $id", migration => {
  it.each(["null", "missing", "builtin-local"])("keeps an existing catalog's local embedding choice (%s) despite stale raw custom fields", async choice => {
    const initial = initialConfig();
    initial.modelAssignments.byok = {};
    if (choice !== "missing") initial.modelAssignments.byok.embedding = choice === "null" ? null : "memmy-builtin-local-embedding";
    initial.memmyMemory.embedding = { ...legacyConnection("embedding"), endpoint: "http://127.0.0.1:1234/v1", apiKey: "" };
    const f = await fixture(initial);
    expect(loadMemmyConfig(f.file).config.embedding.provider).toBe("local");
    await migration.up(f.context);
    const saved = await f.read();
    expect(saved.modelAssignments.byok.embedding).toBe(choice === "builtin-local" ? "memmy-builtin-local-embedding" : null);
    expect(loadMemmyConfig(f.file).config.embedding.provider).toBe("local");
    expect(saved.memmyMemory.embedding).toEqual(initial.memmyMemory.embedding);
    const once = await fs.readFile(f.file, "utf8");
    expect(await migration.up(f.context)).toMatchObject({ changed: 0 });
    expect(await fs.readFile(f.file, "utf8")).toBe(once);
  });

  it.each(roles.flatMap(role => ["endpoint", "model", "apiKey"].map(field => ({ ...role, field }))))(
    "preserves edited $role $field despite its old platform source marker", async ({ role, capability, assignment, field }) => {
      const initial = initialConfig(), connection = legacyConnection(capability);
      if (role === "embedding") delete initial.modelAssignments;
      connection[field] = field === "endpoint" ? "https://custom.example.test/v1" : `custom-${field}`;
      initial.memmyMemory[role] = connection;
      const f = await fixture(initial);
      await migration.up(f.context);
      const saved = await f.read(), presetId = saved.modelAssignments.byok[assignment];
      expect(presetId).toEqual(expect.any(String));
      const preset = saved.modelPresets[presetId], provider = saved.providers[preset.provider];
      const endpoint = provider.endpoints[preset.endpoint];
      expect(preset).toMatchObject({ source: "byok", provider: "openai", model: connection.model });
      expect(endpoint.apiBase).toBe(connection.endpoint);
      expect(endpoint.inheritProviderDefaults).toBe(false);
      expect(endpoint.apiKey ?? provider.apiKey).toBe(connection.apiKey);
      expect(saved.memmyMemory.storage).toEqual(initial.memmyMemory.storage);
      // Both the repeated normalization and the later cleanup must retain it.
      const once = await fs.readFile(f.file, "utf8");
      expect(await migration.up(f.context)).toMatchObject({ changed: 0 });
      expect(await fs.readFile(f.file, "utf8")).toBe(once);
      await removePlatformMemoryDuplicatesV124.up(f.context);
      expect((await f.read()).modelAssignments.byok[assignment]).toBe(presetId);
    });

  it.each([{ provider: "memmy_account", marked: true }, { provider: "memmy_account", marked: false }, { provider: "openai_compatible", marked: true }])(
    "imports edited $provider (source marker=$marked) with its old account protocol as valid BYOK", async ({ provider, marked }) => {
    const initial = initialConfig();
    initial.memmyMemory.summary = { ...legacyConnection("memory_summary"), provider,
      protocol: "memmy-account", endpoint: "https://custom.example.test/v1", apiKey: "custom-fixture-token" };
    if (!marked) delete initial.memmyMemory.summary.sourceProvider;
    const f = await fixture(initial); await migration.up(f.context);
    const saved = await f.read(), id = saved.modelAssignments.byok.memorySummary;
    expect(saved.modelPresets[id]).toMatchObject({ source: "byok", provider: "openai", model: "memory_summary" });
    const preset = saved.modelPresets[id];
    expect(saved.providers.openai.endpoints[preset.endpoint].protocol).toBe("openai-chat-completions");
    const once = await fs.readFile(f.file, "utf8");
    expect(await migration.up(f.context)).toMatchObject({ changed: 0 });
    expect(await fs.readFile(f.file, "utf8")).toBe(once);
  });

  it.each(["extraHeaders", "extraBody"])("preserves edited %s despite the platform source marker", async field => {
    const initial = initialConfig(), connection = legacyConnection("memory_summary");
    connection[field] = { custom: "retained" };
    initial.memmyMemory.summary = connection;
    const f = await fixture(initial); await migration.up(f.context);
    const saved = await f.read(), id = saved.modelAssignments.byok.memorySummary;
    const preset = saved.modelPresets[id];
    expect(preset).toMatchObject({ source: "byok", provider: "openai", model: "memory_summary" });
    expect(saved.providers.openai.endpoints[preset.endpoint][field]).toEqual(connection[field]);
    await removePlatformMemoryDuplicatesV124.up(f.context);
    expect((await f.read()).modelAssignments.byok.memorySummary).toBe(id);
    const once = await fs.readFile(f.file, "utf8");
    expect(await migration.up(f.context)).toMatchObject({ changed: 0 });
    expect(await fs.readFile(f.file, "utf8")).toBe(once);
  });

  it.each(roles.flatMap(role => ["missing", "empty"].flatMap(key => [false, true].map(existing => ({ ...role, key, existing })))))(
    "preserves no-auth $role with $key key and existing endpoint=$existing", async ({ role, capability, assignment, key, existing }) => {
      const initial = initialConfig(), connection = legacyConnection(capability);
      if (role === "embedding") delete initial.modelAssignments;
      connection.endpoint = "http://127.0.0.1:1234/v1";
      if (key === "missing") delete connection.apiKey; else connection.apiKey = "";
      const protocol = role === "embedding" ? "openai-embeddings" : "openai-chat-completions";
      initial.providers.openai = { apiKey: "unrelated-openai-fixture-token", endpoints: {
        cloud: { apiBase: "https://api.openai.com/v1", protocol: "openai-chat-completions" },
        ...(existing ? { authenticated: { apiBase: connection.endpoint, protocol } } : {}),
      } };
      initial.memmyMemory[role] = connection;
      const f = await fixture(initial); await migration.up(f.context);
      const saved = await f.read(), id = saved.modelAssignments.byok[assignment], preset = saved.modelPresets[id];
      const provider = saved.providers[preset.provider], endpoint = provider.endpoints[preset.endpoint];
      expect(endpoint.inheritProviderDefaults).toBe(false);
      expect(endpoint.apiKey).toBe("");
      expect(endpoint.apiKey ?? provider.apiKey).toBe("");
      expect(provider.apiKey).toBe("unrelated-openai-fixture-token");
      if (existing) {
        expect(preset.endpoint).not.toBe("authenticated");
        expect(provider.endpoints.authenticated.apiKey ?? provider.apiKey).toBe("unrelated-openai-fixture-token");
      }
      await removePlatformMemoryDuplicatesV124.up(f.context);
      expect((await f.read()).modelAssignments.byok[assignment]).toBe(id);
      const once = await fs.readFile(f.file, "utf8");
      expect(await migration.up(f.context)).toMatchObject({ changed: 0 });
      expect(await fs.readFile(f.file, "utf8")).toBe(once);
    });

  it.each(roles.flatMap(role => ["openai-responses", "custom-memory-protocol"].map(protocol => ({ ...role, protocol }))))(
    "preserves explicit $protocol for $role instead of deleting a same-address connection", async ({ role, capability, assignment, protocol }) => {
      const initial = initialConfig();
      if (role === "embedding") delete initial.modelAssignments;
      initial.memmyMemory[role] = { ...legacyConnection(capability), protocol };
      const f = await fixture(initial); await migration.up(f.context);
      const saved = await f.read();
      const entry = Object.entries(saved.modelPresets).find(([, value]: any) => value.source === "byok"
        && value.capabilities.includes(capability) && saved.providers[value.provider].endpoints[value.endpoint].protocol === protocol);
      expect(entry).toBeDefined();
      const [id, preset] = entry! as [string, Record<string, any>];
      const endpoint = saved.providers[preset.provider].endpoints[preset.endpoint];
      // Unsupported protocols are retained for correction, not activated.
      expect(saved.modelAssignments.byok[assignment]).toBe(role !== "embedding" && protocol === "openai-responses" ? id : null);
      expect(endpoint.protocol).toBe(protocol);
      await removePlatformMemoryDuplicatesV124.up(f.context);
      expect((await f.read()).modelPresets[id]).toEqual(preset);
      const once = await fs.readFile(f.file, "utf8");
      expect(await migration.up(f.context)).toMatchObject({ changed: 0 });
      expect(await fs.readFile(f.file, "utf8")).toBe(once);
    });

  it.each(["memmy-account", "role-default"])("still omits equivalent explicit %s platform projections", async protocol => {
    const initial = initialConfig();
    for (const { role, capability } of roles) initial.memmyMemory[role] = { ...legacyConnection(capability),
      protocol: protocol === "role-default" ? role === "embedding" ? "openai-embeddings" : "openai-chat-completions" : protocol };
    const f = await fixture(initial); await migration.up(f.context);
    expect(Object.values((await f.read()).modelPresets ?? {}).filter((preset: any) => preset.source === "byok")).toEqual([]);
  });

  it("preserves a connection matching another account's dormant platform catalog", async () => {
    const initial = initialConfig(); initial.app.userId = "owner-b";
    initial.memmyMemory.summary = legacyConnection("memory_summary");
    const f = await fixture(initial); await migration.up(f.context);
    const saved = await f.read(), id = saved.modelAssignments.byok.memorySummary;
    expect(saved.modelPresets[id]).toMatchObject({ source: "byok", provider: "openai" });
    expect(saved.providers.memmy_account.ownerAccountId).toBe("owner-a");
  });

  it("preserves a marked custom connection when no account catalog can verify it", async () => {
    const initial = initialConfig(); delete initial.providers.memmy_account;
    initial.memmyMemory.summary = legacyConnection("memory_summary");
    const f = await fixture(initial); await migration.up(f.context);
    const saved = await f.read(), id = saved.modelAssignments.byok.memorySummary;
    expect(saved.modelPresets[id]).toMatchObject({ source: "byok", provider: "openai" });
  });

  it("keeps independent endpoints distinct even when their current auth matches inherited defaults", async () => {
    const initial = initialConfig();
    initial.providers.openai = { apiKey: "platform-fixture-token", endpoints: {
      inherited: { apiBase: platformAddress, protocol: "openai-chat-completions" },
    } };
    initial.memmyMemory.summary = { ...legacyConnection("memory_summary"), inheritProviderDefaults: false };
    const f = await fixture(initial); await migration.up(f.context);
    const saved = await f.read(), id = saved.modelAssignments.byok.memorySummary, preset = saved.modelPresets[id];
    expect(preset.endpoint).not.toBe("inherited");
    const endpoint = saved.providers.openai.endpoints[preset.endpoint];
    expect(endpoint).toMatchObject({ inheritProviderDefaults: false, apiKey: "platform-fixture-token", extraHeaders: {}, extraBody: {} });
    expect(saved.providers.openai.endpoints.inherited).toEqual(initial.providers.openai.endpoints.inherited);
    await removePlatformMemoryDuplicatesV124.up(f.context);
    expect((await f.read()).modelPresets[id]).toEqual(preset);
    const once = await fs.readFile(f.file, "utf8");
    expect(await migration.up(f.context)).toMatchObject({ changed: 0 });
    expect(await fs.readFile(f.file, "utf8")).toBe(once);
  });

  it.each(["current", "legacy-owner-fields", "provider-level-address"])(
    "still omits unchanged platform connections with %s configuration", async shape => {
      const initial = initialConfig();
      if (shape === "legacy-owner-fields") {
        delete initial.app.userId; delete initial.providers.memmy_account.ownerAccountId;
        delete initial.modelAssignments.account.ownerAccountId;
      }
      if (shape === "provider-level-address") {
        initial.providers.memmy_account.apiBase = platformAddress;
        delete initial.providers.memmy_account.endpoints;
      }
      for (const { role, capability } of roles) initial.memmyMemory[role] = legacyConnection(capability);
      const f = await fixture(initial); await migration.up(f.context);
      const saved = await f.read();
      expect(Object.values(saved.modelPresets ?? {}).filter((preset: any) => preset.source === "byok")).toEqual([]);
      expect(saved.memmyMemory.storage).toEqual(initial.memmyMemory.storage);
      const once = await fs.readFile(f.file, "utf8");
      expect(await migration.up(f.context)).toMatchObject({ changed: 0 });
      expect(await fs.readFile(f.file, "utf8")).toBe(once);
    });
});
