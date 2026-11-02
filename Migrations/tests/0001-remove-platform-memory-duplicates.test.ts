import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeRuntimeModelCatalogForTest } from "../src/migrations/v1.0.7/0001-normalize-runtime-model-catalog.js";
import { removePlatformMemoryDuplicatesV124 as cleanup } from "../src/migrations/v1.2.4/0001-remove-platform-memory-duplicates.js";
import { migrations } from "../src/registry.js";
import { runMigrationsForTest } from "../src/runner.js";

const roots: string[] = [];
const apiBase = "https://platform.example.test/api/agentExternal/v1";
// Recorded output of the pre-fix model-catalog migration, not UI-created UUIDs.
const ids = ["byok-openai-memory-summary-c6f352c1", "byok-openai-memory-evolution-db4aad9f", "byok-openai-embedding-4e50cb14"];
const models = ["memory_summary", "memory_evolution", "embedding"];
function config(): Record<string, any> {
  return {
    app: { userMode: "account", userId: "owner-a" },
    providers: {
      memmy_account: { ownerAccountId: "owner-a", apiKey: "fixture-token", endpoints: { platform: { apiBase, protocol: "memmy-account" } } },
      openai: { apiKey: "fixture-token", endpoints: {
        chat: { apiBase, protocol: "openai-chat-completions" },
        embedding: { apiBase, protocol: "openai-embeddings" },
      } },
    },
    modelPresets: Object.fromEntries(models.flatMap((model, i) => [
      [ids[i], { provider: "openai", endpoint: i === 2 ? "embedding" : "chat", model, source: "byok", capabilities: [model] }],
      [`platform-${model}`, { provider: "memmy_account", endpoint: "platform", model, source: "account", ownerAccountId: "owner-a", capabilities: [model] }],
    ])),
    modelAssignments: {
      account: { ownerAccountId: "owner-a", memorySummary: "platform-memory_summary", memoryEvolution: "platform-memory_evolution", embedding: "platform-embedding" },
      byok: { memorySummary: ids[0], memoryEvolution: ids[1], embedding: ids[2] },
    },
    memmyMemory: { storage: { sqlitePath: "untouched.sqlite" } },
  };
}
async function fixture(value: unknown) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-700-")); roots.push(root);
  const file = path.join(root, "config.yaml");
  await fs.writeFile(file, YAML.stringify(value));
  return { file, read: async () => YAML.parse(await fs.readFile(file, "utf8")), context: {
    profileWorkspace: root, sessionsDir: path.join(root, "sessions"), runtimeConfigFile: file,
    sessionDagDir: path.join(root, "dag"), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe("MEMMY-700 platform Memory duplicates", () => {
  it("removes recorded migration copies and orphan endpoints, preserving platform assignments and data settings", async () => {
    const initial = config(); const f = await fixture(initial);
    expect(await cleanup.up(f.context)).toMatchObject({ changed: 1 });
    const result = await f.read();
    expect(Object.keys(result.modelPresets)).toEqual(models.map(m => `platform-${m}`));
    expect(result.providers.openai).toBeUndefined();
    expect(result.providers.memmy_account).toEqual(initial.providers.memmy_account);
    expect(result.modelAssignments.account).toEqual(initial.modelAssignments.account);
    expect(Object.values(result.modelAssignments.byok)).toEqual([null, null, null]);
    expect(result.memmyMemory).toEqual(initial.memmyMemory);
    const once = await fs.readFile(f.file, "utf8");
    expect(await cleanup.up(f.context)).toMatchObject({ changed: 0 });
    expect(await fs.readFile(f.file, "utf8")).toBe(once);
  });

  it.each(["model", "address", "credential", "label", "id", "capabilities", "headers", "no-account"])("preserves a user-modified or ambiguous configuration (%s)", async change => {
    const initial = config(); const preset = initial.modelPresets[ids[0]!];
    if (change === "model") preset.model = "my-summary";
    if (change === "address") initial.providers.openai.endpoints.chat.apiBase = "https://user.example.test/v1";
    if (change === "credential") initial.providers.openai.endpoints.chat.apiKey = "user-key";
    if (change === "label") preset.label = "My model";
    if (change === "id") { initial.modelPresets["user-created-uuid"] = preset; delete initial.modelPresets[ids[0]!]; }
    if (change === "capabilities") preset.capabilities.push("agent");
    if (change === "headers") initial.providers.openai.endpoints.chat.extraHeaders = { "X-User": "custom" };
    if (change === "no-account") delete initial.providers.memmy_account;
    const f = await fixture(initial); await cleanup.up(f.context);
    const result = await f.read(); const id = change === "id" ? "user-created-uuid" : ids[0]!;
    expect(result.modelPresets[id]).toEqual(preset);
    expect(result.providers.openai.endpoints.chat).toEqual(initial.providers.openai.endpoints.chat);
  });

  it.each(["extraHeaders", "extraBody"])("preserves effective provider-level %s and BYOK selections", async field => {
    const initial = config();
    initial.providers.memmy_account[field] = { base: "platform" };
    initial.providers.memmy_account.endpoints.platform[field] = { base: "platform" };
    initial.providers.openai[field] = { base: "platform", userOption: "keep" };
    initial.providers.openai.endpoints.chat[field] = { base: "platform" };
    initial.providers.openai.endpoints.embedding[field] = { base: "platform" };
    const f = await fixture(initial);
    expect(await cleanup.up(f.context)).toMatchObject({ changed: 0 });
    expect(await f.read()).toEqual(initial);
    expect(await cleanup.up(f.context)).toMatchObject({ changed: 0 });
  });

  it.each(["extraHeaders", "extraBody"])("merges platform %s and applies endpoint overrides on both sides", async field => {
    const initial = config();
    initial.providers.memmy_account[field] = { inherited: "yes", overridden: "old-platform" };
    initial.providers.memmy_account.endpoints.platform[field] = { overridden: "final" };
    initial.providers.openai[field] = { inherited: "yes", overridden: "old-user" };
    initial.providers.openai.endpoints.chat[field] = { overridden: "final" };
    initial.providers.openai.endpoints.embedding[field] = { inherited: "yes", overridden: "final" };
    const f = await fixture(initial); await cleanup.up(f.context);
    expect(Object.keys((await f.read()).modelPresets)).toEqual(models.map(m => `platform-${m}`));
    expect(await cleanup.up(f.context)).toMatchObject({ changed: 0 });
  });

  it.each(["extraHeaders", "extraBody"])("keeps a candidate missing inherited platform %s", async field => {
    const initial = config();
    initial.providers.memmy_account[field] = { inherited: "platform" };
    initial.providers.memmy_account.endpoints.platform[field] = { base: "same" };
    initial.providers.openai.endpoints.chat[field] = { base: "same" };
    initial.providers.openai.endpoints.embedding[field] = { base: "same" };
    const f = await fixture(initial); await cleanup.up(f.context);
    expect(await f.read()).toEqual(initial);
  });

  it.each(["extraHeaders", "extraBody"])("compares merged platform %s during legacy import", async field => {
    const initial = config(); delete initial.providers.openai;
    for (const id of ids) delete initial.modelPresets[id];
    delete initial.modelAssignments.byok;
    initial.providers.memmy_account[field] = { inherited: "platform", overridden: "old" };
    initial.providers.memmy_account.endpoints.platform[field] = { overridden: "final" };
    initial.memmyMemory = { roleRouting: { evolution: "fixed" }, evolution: {
      provider: "openai_compatible", endpoint: apiBase, apiKey: "fixture-token", model: "memory_evolution",
      [field]: { inherited: "platform", overridden: "final" },
    } };
    const f = await fixture(initial); await normalizeRuntimeModelCatalogForTest(f.context);
    expect(Object.values((await f.read()).modelPresets).filter((p: any) => p.source === "byok")).toEqual([]);
    initial.memmyMemory.evolution[field].userOption = "custom";
    const custom = await fixture(initial); await normalizeRuntimeModelCatalogForTest(custom.context);
    expect(Object.values((await custom.read()).modelPresets)).toContainEqual(expect.objectContaining({ model: "memory_evolution", source: "byok" }));
  });

  it("keeps a shared endpoint and unrelated models, and repairs only the current owner's account references", async () => {
    const initial = config();
    initial.modelPresets.custom = { provider: "openai", endpoint: "chat", model: "custom", source: "byok", capabilities: ["agent"] };
    initial.modelAssignments.account.memorySummary = ids[0];
    const f = await fixture(initial); await cleanup.up(f.context); const result = await f.read();
    expect(result.providers.openai.endpoints.chat).toEqual(initial.providers.openai.endpoints.chat);
    expect(result.modelPresets.custom).toEqual(initial.modelPresets.custom);
    expect(result.modelAssignments.account.memorySummary).toBe("platform-memory_summary");
  });

  it("also removes the Memory settings writer's exact generated copies", async () => {
    const initial = config();
    for (const [i, id] of ids.entries()) {
      const preset = initial.modelPresets[id];
      const hash = createHash("sha256").update(`openai\0${preset.endpoint}\0${preset.model}`).digest("hex").slice(0, 16);
      const runtimeId = `memmy-memory-${hash}`;
      initial.modelPresets[runtimeId] = preset; delete initial.modelPresets[id];
      initial.modelAssignments.byok[["memorySummary", "memoryEvolution", "embedding"][i]!] = runtimeId;
    }
    const f = await fixture(initial); await cleanup.up(f.context); const result = await f.read();
    expect(Object.values(result.modelPresets).every((p: any) => p.source === "account")).toBe(true);
    expect(result.providers.openai).toBeUndefined();
  });

  it("does not create missing configuration files", async () => {
    const f = await fixture({}); await fs.unlink(f.file);
    expect(await cleanup.up(f.context)).toMatchObject({ deferred: true, changed: 0 });
    await expect(fs.stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([true, false])("does not import platform Memory roles as BYOK (source marker present: %s)", async marked => {
    const initial = config(); delete initial.providers.openai;
    for (const id of ids) delete initial.modelPresets[id];
    delete initial.modelAssignments.byok;
    initial.memmyMemory = { roleRouting: { summary: "fixed", evolution: "fixed" } };
    for (const [i, role] of ["summary", "evolution", "embedding"].entries()) {
      initial.memmyMemory[role] = { provider: "openai_compatible", endpoint: apiBase, apiKey: "fixture-token", model: models[i],
        ...(marked ? { sourceProvider: "memmy_account" } : {}), ...(role === "embedding" ? { mode: "cloud" } : {}) };
    }
    const f = await fixture(initial); await normalizeRuntimeModelCatalogForTest(f.context);
    const result = await f.read();
    expect(Object.values(result.modelPresets).filter((p: any) => p.source === "byok")).toEqual([]);
    expect(Object.values(result.modelPresets).filter((p: any) => p.source === "account").length).toBeGreaterThanOrEqual(3);
  });

  it("still imports same-named user models on a different endpoint", async () => {
    const f = await fixture({ memmyMemory: { roleRouting: { summary: "fixed" }, summary: {
      provider: "openai_compatible", endpoint: "https://user.example.test/v1", model: "memory_summary", apiKey: "user-key",
    } } });
    await normalizeRuntimeModelCatalogForTest(f.context);
    const result = await f.read();
    expect(Object.values(result.modelPresets)).toContainEqual(expect.objectContaining({ model: "memory_summary", source: "byok" }));
  });

  it("cleans new exact copies after the original cleanup already ran, retaining unknown old credentials", async () => {
    const f = await fixture(config());
    const options = { targets: { agentWorkspace: f.context.profileWorkspace, runtimeConfigFile: f.file, sessionDagDir: f.context.sessionDagDir }, logger: f.context.logger };
    await runMigrationsForTest(options, { definitions: [cleanup] });
    // An older startup writer reintroduced a copy after migration 0001.
    const reintroduced = config();
    reintroduced.modelAssignments.account.embedding = ids[2];
    reintroduced.providers.openai.endpoints.stale = { apiBase, protocol: "openai-embeddings", apiKey: "old-or-user-key" };
    const staleId = `memmy-memory-${createHash("sha256").update("openai\0stale\0embedding").digest("hex").slice(0, 16)}`;
    reintroduced.modelPresets[staleId] = { provider: "openai", endpoint: "stale", model: "embedding", source: "byok", capabilities: ["embedding"] };
    await fs.writeFile(f.file, YAML.stringify(reintroduced));
    const definitions = migrations.filter(m => m.id.startsWith("v1.2.4/"));
    const upgraded = await runMigrationsForTest(options, { definitions });
    expect(upgraded.skipped).toContain(cleanup.id);
    expect(upgraded.applied.map(m => m.id)).toEqual(["v1.2.4/0002-remove-reintroduced-platform-memory-duplicates"]);
    const saved = await f.read();
    expect(saved.modelAssignments.account.embedding).toBe("platform-embedding");
    expect(Object.keys(saved.modelPresets)).toEqual([...models.map(m => `platform-${m}`), staleId]);
    expect(saved.providers.openai.endpoints.stale).toEqual(reintroduced.providers.openai.endpoints.stale);
    const once = await fs.readFile(f.file, "utf8");
    expect((await runMigrationsForTest(options, { definitions })).applied).toHaveLength(0);
    expect(await fs.readFile(f.file, "utf8")).toBe(once);
  });

  it("registers cleanup after previous migrations so completed upgrades receive it", () => {
    expect(migrations).toContain(cleanup);
  });
});
