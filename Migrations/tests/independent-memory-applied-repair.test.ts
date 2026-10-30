import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrations } from "../src/registry.js";
import { runMigrationsForTest } from "../src/runner.js";
import { loadMemmyConfig } from "../../Memory/src/config/index.js";
import { createLlmClient } from "../../Memory/src/model/llm.js";
import { createEmbedder } from "../../Memory/src/model/embedder.js";

const repairId = "v1.2.6/0001-preserve-independent-memory-connections";
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(applied = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-applied-repair-")); roots.push(root);
  const file = path.join(root, "config.yaml"), context = { profileWorkspace: root, runtimeConfigFile: file,
    sessionsDir: path.join(root, "sessions"), sessionDagDir: path.join(root, "dag"), logger: { info() {}, warn() {}, error() {} } };
  const options = { targets: { agentWorkspace: root, runtimeConfigFile: file, sessionDagDir: context.sessionDagDir }, logger: context.logger };
  await fs.writeFile(file, YAML.stringify({ app: { userMode: "byok", userId: "owner-a" },
    providers: { openai: { apiKey: "cloud-token", extraHeaders: { Authorization: "Bearer cloud-header" }, extraBody: { model: "unrelated-cloud-model" },
      endpoints: { cloud: { apiBase: "https://cloud.example.test/v1", protocol: "openai-chat-completions" } } } },
    modelPresets: { cloud: { provider: "openai", endpoint: "cloud", model: "cloud-model", source: "byok", capabilities: ["agent"] } },
    modelAssignments: { byok: { agent: { candidates: ["cloud"], default: "cloud" } } },
    memmyMemory: { storage: { sqlitePath: "do-not-change.sqlite" } } }));
  // Establish actual on-disk applied records before the old writer saves the
  // custom connections. Updating the historical definitions cannot rerun them.
  if (applied) await runMigrationsForTest(options, { definitions: migrations.filter(item => item.id !== repairId) });
  const read = async (): Promise<Record<string, any>> => YAML.parse(await fs.readFile(file, "utf8"));
  return { root, file, context, options, read };
}

describe("forward repair of independent Memory connections after historical migrations", () => {
  it("repairs existing applied installations without rerunning normalization or changing unrelated configuration", async () => {
    const f = await fixture(), before = await f.read();
    before.customUnrelated = { preserve: "byte-for-byte values", nested: [1, false, null] };
    before.modelPresets.cloud.label = "User label must stay";
    before.memmyMemory.roleRouting = { summary: "fixed", evolution: "fixed" };
    before.providers.openai.endpoints.oldEmbedding = { apiBase: "https://cloud.example.test/v1", protocol: "openai-embeddings" };
    before.modelPresets.oldEmbedding = { provider: "openai", endpoint: "oldEmbedding", model: "old-embedding", source: "byok", capabilities: ["embedding"] };
    before.modelAssignments.byok.embedding = "oldEmbedding";
    for (const role of ["summary", "evolution", "embedding"]) before.memmyMemory[role] = {
      provider: "openai_compatible", sourceProvider: "memmy_account", endpoint: "http://127.0.0.1:1234/v1",
      model: role === "embedding" ? "embedding" : `memory_${role}`, apiKey: "", extraHeaders: { "X-Own": "retained" }, extraBody: { seed: 1 },
      ...(role === "embedding" ? { mode: "custom" } : {}),
    };
    await fs.writeFile(f.file, YAML.stringify(before));
    const result = await runMigrationsForTest(f.options, {});
    expect(result.skipped).toContain("v1.0.7/0001-normalize-runtime-model-catalog");
    expect(result.skipped).toContain("v1.0.9/0001-repair-runtime-model-catalog");
    expect(result.applied.map(item => item.id)).toEqual([repairId]);
    const saved = await f.read();
    expect(saved.customUnrelated).toEqual(before.customUnrelated);
    expect(saved.modelPresets.cloud).toEqual(before.modelPresets.cloud);
    expect(saved.app).toEqual(before.app);
    expect(saved.providers.openai.apiKey).toBe(before.providers.openai.apiKey);
    expect(saved.providers.openai.extraHeaders).toEqual(before.providers.openai.extraHeaders);
    expect(saved.providers.openai.extraBody).toEqual(before.providers.openai.extraBody);
    expect(saved.providers.openai.endpoints.cloud).toEqual(before.providers.openai.endpoints.cloud);
    expect(saved.memmyMemory).toEqual(before.memmyMemory);
    for (const field of ["memorySummary", "memoryEvolution", "embedding"]) {
      const preset = saved.modelPresets[saved.modelAssignments.byok[field]];
      expect(saved.providers[preset.provider].endpoints[preset.endpoint]).toMatchObject({ inheritProviderDefaults: false, apiKey: "" });
    }
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: unknown, init: RequestInit) => {
      const url = String(input); requests.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(url.endsWith("/embeddings") ? { data: [{ embedding: [1, 0, 0] }] }
        : { choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const config = loadMemmyConfig(f.file).config;
    for (const role of ["summary", "evolution"] as const) await createLlmClient({ ...config[role], maxRetries: 0 })
      .complete([{ role: "user", content: "synthetic" }], { operation: "test.forward-repair" });
    expect(config.embedding).toMatchObject({ provider: "openai_compatible", mode: "custom" });
    await createEmbedder({ ...config.embedding, cache: false, maxRetries: 0 }).embed(["synthetic"]);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.url.startsWith("http://127.0.0.1:1234/v1")).toBe(true);
      expect(request.headers.has("authorization")).toBe(false);
      expect(request.body.model).not.toBe("unrelated-cloud-model");
    }
    const once = await fs.readFile(f.file, "utf8");
    expect((await runMigrationsForTest(f.options, {})).applied).toHaveLength(0);
    expect(await fs.readFile(f.file, "utf8")).toBe(once);
    const repair = migrations.find(item => item.id === repairId)!;
    expect(await repair.up(f.context)).toMatchObject({ changed: 0 });
    expect(await fs.readFile(f.file, "utf8")).toBe(once);
  });

  it.each(["null", "missing", "builtin-local", "unmarked", "platform", "follow", "account"])(
    "does not reinterpret unrelated or inactive choices (%s)", async choice => {
      const f = await fixture(), before = await f.read();
      const connection = { provider: "openai_compatible", sourceProvider: "memmy_account", endpoint: "http://127.0.0.1:1234/v1",
        model: "memory_summary", apiKey: "", extraHeaders: { "X-Own": "retained" } };
      if (["null", "missing", "builtin-local"].includes(choice)) {
        before.memmyMemory.embedding = { ...connection, model: "embedding", mode: "custom" };
        if (choice === "missing") delete before.modelAssignments.byok.embedding;
        else before.modelAssignments.byok.embedding = choice === "null" ? null : "memmy-builtin-local-embedding";
      } else {
        before.memmyMemory.roleRouting = { summary: choice === "follow" ? "follow" : "fixed" };
        before.memmyMemory.summary = connection;
        if (choice === "unmarked") delete before.memmyMemory.summary.sourceProvider;
        if (choice === "account") before.app.userMode = "account";
        if (choice === "platform") {
          before.memmyMemory.summary.apiKey = "platform-token";
          before.memmyMemory.summary.extraHeaders = {};
          before.providers.memmy_account = { ownerAccountId: "owner-a", apiKey: "platform-token",
            endpoints: { platform: { apiBase: connection.endpoint, protocol: "memmy-account" } } };
        }
      }
      await fs.writeFile(f.file, YAML.stringify(before));
      const once = await fs.readFile(f.file, "utf8"), result = await runMigrationsForTest(f.options, {});
      expect(result.applied.map(item => item.id)).toEqual([repairId]);
      expect(result.applied[0]!.result).toMatchObject({ changed: 0 });
      expect(await fs.readFile(f.file, "utf8")).toBe(once);
      if (["null", "missing", "builtin-local"].includes(choice)) expect(loadMemmyConfig(f.file).config.embedding.provider).toBe("local");
    });

  it.each(["openai-responses", "unsupported-memory-protocol"])("retains %s without enabling unsupported assignments", async protocol => {
    const f = await fixture(), before = await f.read();
    before.memmyMemory.roleRouting = { summary: "fixed" };
    before.memmyMemory.summary = { provider: "openai_compatible", sourceProvider: "memmy_account", endpoint: "http://127.0.0.1:1234/v1",
      model: "memory_summary", apiKey: "", protocol };
    await fs.writeFile(f.file, YAML.stringify(before)); await runMigrationsForTest(f.options, {});
    const saved = await f.read();
    const entry = Object.entries(saved.modelPresets).find(([, item]: any) => item.capabilities.includes("memory_summary"));
    expect(entry).toBeDefined();
    const [id, preset] = entry! as [string, Record<string, any>];
    expect(saved.providers[preset.provider].endpoints[preset.endpoint]).toMatchObject({ protocol, inheritProviderDefaults: false });
    expect(saved.modelAssignments.byok.memorySummary).toBe(protocol === "openai-responses" ? id : null);
    const once = await fs.readFile(f.file, "utf8");
    expect(await migrations.find(item => item.id === repairId)!.up(f.context)).toMatchObject({ changed: 0 });
    expect(await fs.readFile(f.file, "utf8")).toBe(once);
  });

  it("is a no-op after fresh normalization already created the independent connection", async () => {
    const f = await fixture(false), before = await f.read();
    before.memmyMemory.roleRouting = { summary: "fixed" };
    before.memmyMemory.summary = { provider: "openai_compatible", sourceProvider: "memmy_account", endpoint: "http://127.0.0.1:1234/v1",
      model: "memory_summary", apiKey: "" };
    await fs.writeFile(f.file, YAML.stringify(before));
    const result = await runMigrationsForTest(f.options, {});
    expect(result.applied.find(item => item.id === repairId)!.result).toMatchObject({ changed: 0 });
    const saved = await f.read();
    expect(Object.values(saved.modelPresets).filter((item: any) => item.capabilities.includes("memory_summary"))).toHaveLength(1);
  });

  it("defers without creating a missing configuration file", async () => {
    const f = await fixture(); await fs.unlink(f.file);
    expect(await migrations.find(item => item.id === repairId)!.up(f.context)).toMatchObject({ deferred: true, changed: 0 });
    await expect(fs.stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
