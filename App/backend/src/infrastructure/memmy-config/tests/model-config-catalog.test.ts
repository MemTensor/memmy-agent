import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID,
  type ModelAssignments,
  type ModelConfigInput
} from "@memmy/local-api-contracts";
import { readCatalogEndpointApiKey } from "../index.js";
import {
  InvalidModelConfigError,
  ModelConfigChangedError,
  readModelConfigCatalog,
  writeModelConfigCatalog
} from "../model-config-catalog.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(initial: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-model-catalog-"));
  roots.push(root);
  const file = join(root, "config.yaml");
  writeFileSync(file, YAML.stringify(initial), "utf8");
  return file;
}

function emptyAssignment(ownerAccountId?: string): ModelAssignments["account"] {
  return {
    ...(ownerAccountId ? { ownerAccountId } : {}),
    agent: { candidates: [], default: null },
    memorySummary: null,
    memoryEvolution: null,
    embedding: null,
    asr: null,
    imageGeneration: null
  };
}

function emptyAssignments(): ModelAssignments {
  return { byok: emptyAssignment(), account: emptyAssignment() };
}

function openAiInput(revision: string, presetId?: string): ModelConfigInput {
  return {
    configRevision: revision,
    providers: [{
      provider: "openai",
      apiKey: "sk-new-secret",
      endpoints: [{
        endpointId: "chat",
        apiBase: "https://api.example.test/v1/",
        protocol: "openai-chat-completions"
      }],
      models: [{
        ...(presetId ? { presetId } : {}),
        endpointId: "chat",
        model: "gpt-5",
        source: "byok",
        capabilities: ["agent", "memory_summary", "memory_evolution"]
      }]
    }],
    modelAssignments: emptyAssignments()
  };
}

describe("independent endpoint inheritance", () => {
  it("keeps no-auth custom endpoints isolated when relocating them from a named Provider", async () => {
    const file = fixture({
      providers: { custom: {
        apiKey: "custom-provider-secret",
        endpoints: { memory: {
          apiBase: "http://127.0.0.1:18789/v1", protocol: "openai-responses",
          extraHeaders: { "x-memory": "local" }, extraBody: { temperature: 0 }
        } }
      }, openai: {
        apiKey: "provider-secret",
        extraHeaders: { Authorization: "Bearer provider-header", "x-provider": "global" },
        extraBody: { providerOption: true },
        endpoints: { memory: {
          apiBase: "http://127.0.0.1:18789/v1",
          protocol: "openai-responses",
          inheritProviderDefaults: false,
          extraHeaders: { "x-memory": "local" },
          extraBody: { temperature: 0 }
        } }
      } },
      modelPresets: { "legacy-custom": {
        provider: "openai", endpoint: "memory", model: "memory-model", source: "byok",
        capabilities: ["agent", "memory_summary"], custom: true
      } },
      modelAssignments: emptyAssignments()
    });

    const view = await readModelConfigCatalog(file);
    const raw = YAML.parse(readFileSync(file, "utf8")) as any;
    expect(raw.modelPresets["legacy-custom"].endpoint).toBe("memory-custom");
    const endpoint = raw.providers.custom.endpoints["memory-custom"];
    expect(endpoint).toMatchObject({ inheritProviderDefaults: false,
      extraHeaders: { "x-memory": "local" }, extraBody: { temperature: 0 } });
    expect(endpoint).not.toHaveProperty("apiKey");
    expect(endpoint.extraHeaders).not.toHaveProperty("Authorization");
    expect(endpoint.extraHeaders).not.toHaveProperty("x-provider");
    expect(endpoint.extraBody).not.toHaveProperty("providerOption");
    expect(view.providers.find(provider => provider.provider === "custom")?.models[0])
      .toMatchObject({ presetId: "legacy-custom", available: true, protocol: "openai-responses" });
    expect(await readCatalogEndpointApiKey(file, "custom", "memory-custom")).toBeNull();
  });

  it("does not coalesce inherited and independent endpoints with currently identical options", async () => {
    const file = fixture({ modelAssignments: emptyAssignments() });
    const input = openAiInput((await readModelConfigCatalog(file)).configRevision);
    input.providers[0]!.endpoints.push({
      ...input.providers[0]!.endpoints[0]!, endpointId: "independent",
      inheritProviderDefaults: false, apiKey: input.providers[0]!.apiKey
    });
    input.providers[0]!.models.push({ endpointId: "independent", model: "memory-model",
      source: "byok", capabilities: ["memory_summary"] });
    const first = await writeModelConfigCatalog(file, input);
    expect(first.providers[0]!.endpoints.map(endpoint => endpoint.endpointId).sort())
      .toEqual(["chat", "independent"]);
    expect(first.endpointAliases?.openai).toBeUndefined();

    input.configRevision = first.configRevision;
    input.providers[0]!.apiKey = "changed-provider-secret";
    input.providers[0]!.endpoints[1]!.apiKey = "";
    input.providers[0]!.models = first.providers[0]!.models.map(model => ({ ...model }));
    await writeModelConfigCatalog(file, input);
    expect(await readCatalogEndpointApiKey(file, "openai", "chat")).toBe("changed-provider-secret");
    expect(await readCatalogEndpointApiKey(file, "openai", "independent")).toBe("sk-new-secret");
  });

  it("round-trips isolated no-auth memory endpoints without borrowing Provider defaults or changing cloud models", async () => {
    const file = fixture({ app: { userMode: "byok" }, modelAssignments: emptyAssignments() });
    const input = openAiInput((await readModelConfigCatalog(file)).configRevision);
    input.providers[0]!.apiKey = "provider-secret";
    input.providers[0]!.extraHeaders = { Authorization: "Bearer provider-header", "x-provider": "global" };
    input.providers[0]!.extraBody = { providerOption: true, temperature: 0.8 };
    input.providers[0]!.endpoints.push(
      { endpointId: "memory", apiBase: "http://127.0.0.1:18789/v1", protocol: "openai-chat-completions", inheritProviderDefaults: false, extraHeaders: { "x-memory": "local" }, extraBody: { temperature: 0 } },
      { endpointId: "embed", apiBase: "http://127.0.0.1:18789/v1", protocol: "openai-embeddings", inheritProviderDefaults: false }
    );
    input.providers[0]!.models.push(
      { endpointId: "memory", model: "memory-no-auth", source: "byok", capabilities: ["memory_evolution"] },
      { endpointId: "memory", model: "summary-no-auth", source: "byok", capabilities: ["memory_summary"] },
      { endpointId: "embed", model: "embedding-no-auth", source: "byok", capabilities: ["embedding"] }
    );
    const created = await writeModelConfigCatalog(file, input);
    const models = created.providers[0]!.models;
    const cloud = models.find(model => model.model === "gpt-5")!.presetId;
    const memory = models.find(model => model.model === "memory-no-auth")!.presetId;
    const summary = models.find(model => model.model === "summary-no-auth")!.presetId;
    const embed = models.find(model => model.model === "embedding-no-auth")!.presetId;
    expect(models.every(model => model.available)).toBe(true);
    expect(created.providers[0]!.endpoints.find(endpoint => endpoint.endpointId === "memory"))
      .toMatchObject({ inheritProviderDefaults: false, hasApiKey: false, apiKeyMasked: "" });
    const save = { ...input, configRevision: created.configRevision,
      providers: [{ ...input.providers[0]!, apiKey: "", models: models.map(model => ({ ...model })) }],
      modelAssignments: { ...created.modelAssignments, byok: { ...created.modelAssignments.byok,
        agent: { candidates: [cloud], default: cloud }, memorySummary: summary, memoryEvolution: memory, embedding: embed } } };
    const saved = await writeModelConfigCatalog(file, save);
    const raw = YAML.parse(readFileSync(file, "utf8")) as any;
    for (const role of ["summary", "evolution"]) {
      expect(raw.memmyMemory[role]).toMatchObject({ endpoint: "http://127.0.0.1:18789/v1", model: role === "summary" ? "summary-no-auth" : "memory-no-auth", extraHeaders: { "x-memory": "local" }, extraBody: { temperature: 0 } });
      expect(raw.memmyMemory[role]).not.toHaveProperty("apiKey");
      expect(raw.memmyMemory[role].extraHeaders).not.toHaveProperty("Authorization");
      expect(raw.memmyMemory[role].extraBody).not.toHaveProperty("providerOption");
    }
    expect(raw.memmyMemory.embedding).toMatchObject({ mode: "custom", model: "embedding-no-auth" });
    expect(raw.memmyMemory.embedding).not.toHaveProperty("apiKey");
    expect(raw.memmyMemory.embedding).not.toHaveProperty("extraHeaders");
    expect(raw.providers.openai.apiKey).toBe("provider-secret");
    expect(await readCatalogEndpointApiKey(file, "openai", "memory")).toBeNull();
    expect(await readCatalogEndpointApiKey(file, "openai", "chat")).toBe("provider-secret");
    const clear = { ...save, configRevision: saved.configRevision, modelAssignments: structuredClone(saved.modelAssignments) };
    clear.modelAssignments.byok.embedding = null;
    await writeModelConfigCatalog(file, clear);
    const local = YAML.parse(readFileSync(file, "utf8")) as any;
    expect(local.memmyMemory.embedding).toMatchObject({ provider: "local", mode: "local" });
    expect(local.memmyMemory.embedding).not.toHaveProperty("endpoint");
    expect(local.providers.openai).toEqual(raw.providers.openai);
  });
});

describe("model config catalog", () => {
  it("stores Custom beside OpenAI and moves an existing custom preset onto provider custom", async () => {
    const file = fixture({
      providers: {
        openai: {
          apiKey: "sk-shared",
          endpoints: {
            chat: {
              apiBase: "https://api.openai.com/v1",
              protocol: "openai-chat-completions"
            }
          }
        }
      },
      modelPresets: {
        "legacy-custom": {
          provider: "openai",
          endpoint: "chat",
          model: "legacy-model",
          source: "byok",
          capabilities: ["agent", "memory_summary", "memory_evolution"],
          custom: true
        }
      },
      modelAssignments: emptyAssignments()
    });

    const read = await readModelConfigCatalog(file);
    const migrated = YAML.parse(readFileSync(file, "utf8")) as any;
    expect(migrated.modelPresets["legacy-custom"]).toMatchObject({
      provider: "custom",
      endpoint: "chat",
      custom: true
    });
    expect(migrated.providers.custom.endpoints.chat).toMatchObject({
      apiBase: "https://api.openai.com/v1",
      protocol: "openai-chat-completions",
      apiKey: "sk-shared"
    });
    expect(migrated.providers.openai).toBeUndefined();
    expect(read.providers.map((provider) => provider.provider)).toEqual(["custom"]);

    const legacy = read.providers[0]!.models[0]!;
    const saved = await writeModelConfigCatalog(file, {
      configRevision: read.configRevision,
      providers: [
        {
          provider: "custom",
          endpoints: [{
            endpointId: legacy.endpointId,
            apiBase: "https://api.openai.com/v1",
            protocol: "openai-chat-completions",
            apiKey: "sk-shared"
          }, {
            endpointId: "anthropic",
            apiBase: "https://api.anthropic.com/v1",
            protocol: "anthropic-messages",
            apiKey: "sk-anthropic"
          }],
          models: [
            {
              presetId: legacy.presetId,
              endpointId: legacy.endpointId,
              model: "legacy-model",
              source: "byok",
              capabilities: ["agent", "memory_summary", "memory_evolution"],
              custom: true
            },
            {
              endpointId: "anthropic",
              model: "claude-sonnet",
              source: "byok",
              capabilities: ["memory_summary", "memory_evolution"],
              custom: true
            }
          ]
        },
        {
          provider: "openai",
          endpoints: [{
            endpointId: "chat",
            apiBase: "https://api.openai.com/v1",
            protocol: "openai-chat-completions",
            apiKey: "sk-shared"
          }],
          models: [{
            endpointId: "chat",
            model: "gpt-official",
            source: "byok",
            capabilities: ["agent"]
          }]
        }
      ],
      modelAssignments: emptyAssignments()
    });
    expect(saved.providers.map((provider) => provider.provider).sort()).toEqual(["custom", "openai"]);

    const anthropicId = saved.providers
      .find((provider) => provider.provider === "custom")!
      .models.find((model) => model.model === "claude-sonnet")!
      .presetId;
    const officialId = saved.providers
      .find((provider) => provider.provider === "openai")!
      .models[0]!.presetId;
    const assigned = await writeModelConfigCatalog(file, {
      configRevision: saved.configRevision,
      providers: saved.providers.map((provider) => ({
        provider: provider.provider,
        endpoints: provider.endpoints.map((endpoint) => ({
          endpointId: endpoint.endpointId,
          apiBase: endpoint.apiBase,
          protocol: endpoint.protocol,
          ...(provider.provider === "custom" && endpoint.protocol === "openai-chat-completions" ? { apiKey: "sk-shared" } : {}),
          ...(endpoint.protocol === "anthropic-messages" ? { apiKey: "sk-anthropic" } : {}),
          ...(provider.provider === "openai" ? { apiKey: "sk-shared" } : {})
        })),
        models: provider.models.map((model) => ({
          presetId: model.presetId,
          endpointId: model.endpointId,
          model: model.model,
          source: model.source,
          capabilities: [...model.capabilities],
          ...(model.custom ? { custom: true } : {})
        }))
      })),
      modelAssignments: {
        ...emptyAssignments(),
        byok: {
          ...emptyAssignment(),
          agent: { candidates: [officialId], default: officialId },
          memoryEvolution: anthropicId
        }
      }
    });
    expect(assigned.providers.find((provider) => provider.provider === "custom")?.models).toHaveLength(2);
    expect((YAML.parse(readFileSync(file, "utf8")) as any).memmyMemory.evolution.provider).toBe("anthropic");
  });

  it("round-trips StepFun and Xiaomi MiMo connections back into the view", async () => {
    const file = fixture({ modelAssignments: emptyAssignments() });
    const current = await readModelConfigCatalog(file);

    const saved = await writeModelConfigCatalog(file, {
      configRevision: current.configRevision,
      providers: [
        {
          provider: "stepfun",
          apiKey: "sk-stepfun-secret",
          endpoints: [{
            endpointId: "chat",
            apiBase: "https://api.stepfun.com/v1",
            protocol: "openai-chat-completions"
          }],
          models: [{
            endpointId: "chat",
            model: "step-3.5-flash",
            source: "byok",
            capabilities: ["agent", "memory_summary", "memory_evolution"]
          }]
        },
        {
          provider: "xiaomi_mimo",
          apiKey: "sk-mimo-secret",
          endpoints: [{
            endpointId: "chat",
            apiBase: "https://api.xiaomimimo.com/v1",
            protocol: "openai-chat-completions"
          }],
          models: [{
            endpointId: "chat",
            model: "mimo-v2.5-pro",
            source: "byok",
            capabilities: ["agent", "memory_summary", "memory_evolution"]
          }]
        }
      ],
      modelAssignments: emptyAssignments()
    });

    // The desktop client matches the model it just saved by provider/endpoint/model,
    // so a provider missing from the view surfaces as "Unable to resolve server preset".
    const savedModels = saved.providers.flatMap((provider) => provider.models);
    expect(savedModels.map((model) => [model.provider, model.model])).toEqual(
      expect.arrayContaining([
        ["stepfun", "step-3.5-flash"],
        ["xiaomi_mimo", "mimo-v2.5-pro"]
      ])
    );

    const reread = await readModelConfigCatalog(file);
    expect(reread.providers.map((provider) => provider.provider)).toEqual(
      expect.arrayContaining(["stepfun", "xiaomi_mimo"])
    );
  });

  it("persists the reserved built-in local Embedding assignment without a preset", async () => {
    const file = fixture({ modelAssignments: emptyAssignments() });
    const current = await readModelConfigCatalog(file);
    const assignments = emptyAssignments();
    assignments.byok.embedding = BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID;

    const saved = await writeModelConfigCatalog(file, {
      configRevision: current.configRevision,
      providers: [],
      modelAssignments: assignments
    });

    expect(saved.modelAssignments.byok.embedding).toBe(BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID);
  });

  it("rejects an ownerless account built-in local Embedding assignment", async () => {
    const file = fixture({ modelAssignments: emptyAssignments() });
    const current = await readModelConfigCatalog(file);
    const assignments = emptyAssignments();
    assignments.account.embedding = BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID;

    await expect(writeModelConfigCatalog(file, {
      configRevision: current.configRevision,
      providers: [],
      modelAssignments: assignments
    })).rejects.toThrow(/requires an account owner/);
  });

  it("rejects the built-in local Embedding identifier outside the Embedding assignment", async () => {
    const file = fixture({ modelAssignments: emptyAssignments() });
    const current = await readModelConfigCatalog(file);
    const assignments = emptyAssignments();
    assignments.byok.memorySummary = BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID;

    await expect(writeModelConfigCatalog(file, {
      configRevision: current.configRevision,
      providers: [],
      modelAssignments: assignments
    })).rejects.toThrow(/only valid for embedding/);
  });

  it("reserves the built-in local Embedding identifier against preset collisions", async () => {
    const file = fixture({
      providers: {
        openai: {
          apiKey: "sk-existing",
          endpoints: {
            chat: { apiBase: "https://api.example.test/v1", protocol: "openai-chat-completions" }
          }
        }
      },
      modelPresets: {
        [BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID]: {
          provider: "openai",
          endpoint: "chat",
          model: "gpt-5",
          source: "byok",
          capabilities: ["agent"]
        }
      },
      modelAssignments: emptyAssignments()
    });
    const current = await readModelConfigCatalog(file);

    await expect(writeModelConfigCatalog(
      file,
      openAiInput(current.configRevision, BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID)
    )).rejects.toThrow(/Preset ID is reserved/);
  });

  it("creates unique server preset IDs, masks all credentials, and never persists labels", async () => {
    const file = fixture({ futureSection: { keepMe: true } });
    const current = await readModelConfigCatalog(file);
    const createInput = openAiInput(current.configRevision);
    createInput.providers[0]!.extraHeaders = { Authorization: "provider-header-secret" };
    createInput.providers[0]!.extraBody = { token: "provider-body-secret" };
    createInput.providers[0]!.endpoints[0]!.extraHeaders = { "x-api-key": "endpoint-header-secret" };
    createInput.providers[0]!.endpoints[0]!.extraBody = { token: "endpoint-body-secret" };
    const first = await writeModelConfigCatalog(file, createInput);
    const firstId = first.providers[0]?.models[0]?.presetId;
    expect(firstId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.providers[0]).toMatchObject({
      hasApiKey: true,
      apiKeyMasked: "sk-••••cret",
      apiKey: ""
    });
    expect(first.providers[0]?.endpoints[0]).toMatchObject({
      apiBase: "https://api.example.test/v1",
      hasApiKey: false,
      apiKey: ""
    });

    const secondInput = openAiInput(first.configRevision, firstId);
    secondInput.providers[0]!.models.push({
      endpointId: "chat",
      model: "gpt-5-mini",
      source: "byok",
      capabilities: ["agent"]
    });
    const second = await writeModelConfigCatalog(file, secondInput);
    const ids = second.providers[0]!.models.map((model) => model.presetId);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(firstId);
    const raw = YAML.parse(readFileSync(file, "utf8")) as any;
    expect(raw.futureSection.keepMe).toBe(true);
    expect(raw.providers.openai.extraHeaders.Authorization).toBe("provider-header-secret");
    expect(raw.providers.openai.extraBody.token).toBe("provider-body-secret");
    expect(raw.providers.openai.endpoints.chat.extraHeaders["x-api-key"]).toBe("endpoint-header-secret");
    expect(raw.providers.openai.endpoints.chat.extraBody.token).toBe("endpoint-body-secret");
    for (const preset of Object.values(raw.modelPresets) as any[]) {
      expect(preset).not.toHaveProperty("maxTokens");
      expect(preset).not.toHaveProperty("contextWindowTokens");
    }
    expect(JSON.stringify(raw)).not.toContain("label");
    const serializedView = JSON.stringify(second);
    expect(serializedView).not.toContain("sk-new-secret");
    expect(serializedView).not.toContain("provider-header-secret");
    expect(serializedView).not.toContain("provider-body-secret");
    expect(serializedView).not.toContain("endpoint-header-secret");
    expect(serializedView).not.toContain("endpoint-body-secret");
  });

  it("removes a deleted canonical Provider even when it has no presets", async () => {
    const file = fixture({
      providers: {
        openai: {
          apiKey: "sk-orphan-secret",
          endpoints: {
            chat: {
              apiBase: "https://api.openai.com/v1",
              protocol: "openai-chat-completions"
            }
          }
        }
      },
      modelPresets: {},
      modelAssignments: emptyAssignments()
    });
    const current = await readModelConfigCatalog(file);
    expect(current.providers).toEqual([]);

    await writeModelConfigCatalog(file, {
      configRevision: current.configRevision,
      providers: [],
      modelAssignments: emptyAssignments()
    });

    const raw = YAML.parse(readFileSync(file, "utf8")) as any;
    expect(raw.providers.openai).toBeUndefined();
    expect(JSON.stringify(raw)).not.toContain("sk-orphan-secret");
  });

  it("keeps a preset ID while every mutable catalog field changes", async () => {
    const file = fixture({
      futureSection: { keepMe: true },
      providers: {
        openai: {
          apiKey: "sk-old",
          futureProviderField: "keep",
          endpoints: {
            chat: {
              apiBase: "https://old.example/v1",
              protocol: "openai-chat-completions",
              futureEndpointField: "keep"
            }
          }
        }
      },
      modelPresets: {
        "preset-stable": {
          provider: "openai",
          endpoint: "chat",
          model: "gpt-old",
          source: "byok",
          capabilities: ["agent"],
          futurePresetField: "keep"
        }
      },
      modelAssignments: emptyAssignments()
    });
    const current = await readModelConfigCatalog(file);
    const saved = await writeModelConfigCatalog(file, {
      configRevision: current.configRevision,
      providers: [{
        provider: "anthropic",
        apiKey: "sk-anthropic",
        endpoints: [{
          endpointId: "messages-v2",
          apiBase: "https://new.example/v2",
          protocol: "anthropic-messages"
        }],
        models: [{
          presetId: "preset-stable",
          endpointId: "messages-v2",
          model: "claude-new",
          source: "byok",
          capabilities: ["memory_summary", "memory_evolution"]
        }]
      }],
      modelAssignments: emptyAssignments()
    });
    expect(saved.providers[0]?.models[0]?.presetId).toBe("preset-stable");
    const raw = YAML.parse(readFileSync(file, "utf8")) as any;
    expect(raw.modelPresets["preset-stable"]).toMatchObject({
      provider: "anthropic",
      endpoint: "messages-v2",
      model: "claude-new",
      capabilities: ["memory_summary", "memory_evolution"],
      futurePresetField: "keep"
    });
    expect(raw.futureSection.keepMe).toBe(true);
    expect(raw.providers.openai).toBeUndefined();
  });

  it("preserves an omitted key and unknown nested fields when editing in place", async () => {
    const file = fixture({
      providers: {
        openai: {
          apiKey: "sk-existing",
          futureProviderField: "keep",
          endpoints: {
            chat: {
              apiBase: "https://old.example/v1",
              protocol: "openai-chat-completions",
              futureEndpointField: "keep"
            }
          }
        }
      },
      modelPresets: {
        stable: {
          provider: "openai", endpoint: "chat", model: "gpt-old", source: "byok",
          capabilities: ["agent"], futurePresetField: "keep"
        }
      },
      modelAssignments: emptyAssignments()
    });
    const current = await readModelConfigCatalog(file);
    const input = openAiInput(current.configRevision, "stable");
    input.providers[0]!.apiKey = "";
    input.providers[0]!.endpoints[0]!.apiKey = "";
    await writeModelConfigCatalog(file, input);
    const raw = YAML.parse(readFileSync(file, "utf8")) as any;
    expect(raw.providers.openai).toMatchObject({ apiKey: "sk-existing", futureProviderField: "keep" });
    expect(raw.providers.openai.endpoints.chat.futureEndpointField).toBe("keep");
    expect(raw.modelPresets.stable.futurePresetField).toBe("keep");
  });

  it("stores account and BYOK assignments independently", async () => {
    const file = fixture();
    const created = await writeModelConfigCatalog(file, openAiInput((await readModelConfigCatalog(file)).configRevision));
    const presetId = created.providers[0]!.models[0]!.presetId;
    const byokInput = openAiInput(created.configRevision, presetId);
    byokInput.modelAssignments.byok = {
      ...emptyAssignment(),
      agent: { candidates: [presetId], default: presetId },
      memorySummary: presetId,
      memoryEvolution: presetId
    };
    const byokSaved = await writeModelConfigCatalog(file, byokInput);
    const accountBefore = structuredClone(byokSaved.modelAssignments.account);
    const accountInput = openAiInput(byokSaved.configRevision, presetId);
    accountInput.modelAssignments = structuredClone(byokSaved.modelAssignments);
    accountInput.modelAssignments.account.agent = { candidates: [presetId], default: presetId };
    const accountSaved = await writeModelConfigCatalog(file, accountInput);
    expect(accountSaved.modelAssignments.byok).toEqual(byokSaved.modelAssignments.byok);
    expect(accountSaved.modelAssignments.account).not.toEqual(accountBefore);
  });

  it("projects Desktop memory selections into the authoritative memmyMemory section", async () => {
    const file = fixture({ app: { userMode: "byok" } });
    const revision = (await readModelConfigCatalog(file)).configRevision;
    const definitions: ModelConfigInput = {
      configRevision: revision,
      providers: [{
        provider: "openai",
        apiKey: "sk-memory",
        endpoints: [
          {
            endpointId: "chat",
            apiBase: "https://models.example/v1",
            protocol: "openai-chat-completions"
          },
          {
            endpointId: "embedding",
            apiBase: "https://models.example/v1",
            protocol: "openai-embeddings"
          }
        ],
        models: [
          {
            endpointId: "chat",
            model: "agent-model",
            source: "byok",
            capabilities: ["agent", "memory_summary", "memory_evolution"]
          },
          {
            endpointId: "chat",
            model: "memory-model",
            source: "byok",
            capabilities: ["memory_summary", "memory_evolution"]
          },
          {
            endpointId: "embedding",
            model: "embedding-model",
            source: "byok",
            capabilities: ["embedding"]
          }
        ]
      }],
      modelAssignments: emptyAssignments()
    };
    const created = await writeModelConfigCatalog(file, definitions);
    const models = created.providers[0]!.models;
    const agentId = models.find((model) => model.model === "agent-model")!.presetId;
    const memoryId = models.find((model) => model.model === "memory-model")!.presetId;
    const embeddingId = models.find((model) => model.model === "embedding-model")!.presetId;
    const assigned: ModelConfigInput = {
      ...definitions,
      configRevision: created.configRevision,
      providers: [{
        ...definitions.providers[0]!,
        models: definitions.providers[0]!.models.map((model) => ({
          ...model,
          presetId: model.model === "agent-model"
            ? agentId
            : model.model === "memory-model"
              ? memoryId
              : embeddingId
        }))
      }],
      modelAssignments: {
        ...emptyAssignments(),
        byok: {
          ...emptyAssignment(),
          agent: { candidates: [agentId], default: agentId },
          memorySummary: memoryId,
          memoryEvolution: memoryId,
          embedding: embeddingId
        }
      }
    };
    const saved = await writeModelConfigCatalog(file, assigned);
    const raw = YAML.parse(readFileSync(file, "utf8")) as any;
    expect(raw.memmyMemory).toMatchObject({
      roleRouting: { summary: "follow", evolution: "fixed" },
      evolution: {
        provider: "openai_compatible",
        endpoint: "https://models.example/v1",
        model: "memory-model",
        apiKey: "sk-memory"
      },
      embedding: {
        mode: "custom",
        provider: "openai_compatible",
        endpoint: "https://models.example/v1",
        model: "embedding-model",
        apiKey: "sk-memory"
      }
    });
    expect(saved.memorySettings).toEqual({
      roleRouting: { summary: "follow", evolution: "fixed" },
      embeddingMode: "custom"
    });

    const evolutionOnlyInput = structuredClone(assigned);
    evolutionOnlyInput.configRevision = saved.configRevision;
    evolutionOnlyInput.modelAssignments.byok.memoryEvolution = agentId;
    const evolutionOnly = await writeModelConfigCatalog(file, evolutionOnlyInput);
    expect(evolutionOnly.modelAssignments.byok.memorySummary).toBe(agentId);
    expect(evolutionOnly.memorySettings?.roleRouting).toEqual({ summary: "follow", evolution: "follow" });

    const followInput = structuredClone(assigned);
    followInput.configRevision = evolutionOnly.configRevision;
    followInput.modelAssignments.byok.memorySummary = agentId;
    followInput.modelAssignments.byok.memoryEvolution = agentId;
    const followed = await writeModelConfigCatalog(file, followInput);
    expect(followed.memorySettings?.roleRouting.summary).toBe("follow");
    expect(followed.memorySettings?.roleRouting.evolution).toBe("follow");
    expect((YAML.parse(readFileSync(file, "utf8")) as any).memmyMemory.roleRouting.summary).toBe("follow");
  });

  it("coalesces identical endpoint definitions and redirects their model references", async () => {
    const file = fixture();
    const input = openAiInput((await readModelConfigCatalog(file)).configRevision);
    input.providers[0]!.endpoints.push({
      endpointId: "chat-copy",
      apiBase: "https://api.example.test/v1",
      protocol: "openai-chat-completions"
    });
    input.providers[0]!.models.push({
      endpointId: "chat-copy",
      model: "gpt-5-alias",
      source: "byok",
      capabilities: ["agent"]
    });

    const saved = await writeModelConfigCatalog(file, input);
    const raw = YAML.parse(readFileSync(file, "utf8")) as any;
    expect(Object.keys(raw.providers.openai.endpoints)).toEqual(["chat"]);
    expect(Object.values(raw.modelPresets).map((preset: any) => preset.endpoint)).toEqual(["chat", "chat"]);
    expect(saved.providers[0]?.endpoints).toHaveLength(1);
  });

  it("coalesces duplicate embedding endpoints created while adding models", async () => {
    const file = fixture();
    const input = openAiInput((await readModelConfigCatalog(file)).configRevision);
    input.providers[0]!.endpoints = [
      {
        endpointId: "embedding",
        apiBase: "https://api.example.test/v1/",
        protocol: "openai-embeddings"
      },
      {
        endpointId: "embedding-copy",
        apiBase: "https://api.example.test/v1",
        protocol: "openai-embeddings"
      }
    ];
    input.providers[0]!.models = [
      {
        endpointId: "embedding",
        model: "embedding-a",
        source: "byok",
        capabilities: ["embedding"]
      },
      {
        endpointId: "embedding-copy",
        model: "embedding-b",
        source: "byok",
        capabilities: ["embedding"]
      }
    ];

    const saved = await writeModelConfigCatalog(file, input);
    const raw = YAML.parse(readFileSync(file, "utf8")) as any;
    expect(Object.keys(raw.providers.openai.endpoints)).toEqual(["embedding"]);
    expect(Object.values(raw.modelPresets).map((preset: any) => preset.endpoint)).toEqual(["embedding", "embedding"]);
    expect(saved.providers[0]?.models.map((model) => model.model)).toEqual(["embedding-a", "embedding-b"]);
  });

  it.each([false, true])("coalesces a reentered key and identical model while retaining the saved preset (new endpoint first: %s)", async (newFirst) => {
    const file = fixture();
    const first = await writeModelConfigCatalog(file, openAiInput((await readModelConfigCatalog(file)).configRevision));
    const originalId = first.providers[0]!.models[0]!.presetId;
    const input = openAiInput(first.configRevision);
    input.providers[0]!.models[0]!.presetId = originalId;
    input.providers[0]!.models[0]!.capabilities = ["agent"];
    input.providers[0]!.endpoints.push({ ...input.providers[0]!.endpoints[0]!, endpointId: "chat-copy" });
    input.providers[0]!.models.push({
      ...input.providers[0]!.models[0]!, presetId: undefined, endpointId: "chat-copy", capabilities: ["memory_evolution"]
    });
    if (newFirst) {
      input.providers[0]!.endpoints.reverse();
      input.providers[0]!.models.reverse();
    }
    const saved = await writeModelConfigCatalog(file, input);
    expect(saved.endpointAliases).toEqual({ openai: { "chat-copy": "chat" } });
    expect(saved.providers[0]!.models).toHaveLength(1);
    expect(saved.providers[0]!.models[0]).toMatchObject({
      presetId: originalId, endpointId: "chat", capabilities: ["agent", "memory_evolution"]
    });
    // Aliases describe this write only; neither transient metadata nor plaintext is added to GET views.
    expect((await readModelConfigCatalog(file)).endpointAliases).toBeUndefined();
  });

  it("keeps endpoints with different credentials even when their route is the same", async () => {
    const file = fixture();
    const input = openAiInput((await readModelConfigCatalog(file)).configRevision);
    input.providers[0]!.endpoints.push({
      endpointId: "chat-other-key",
      apiBase: "https://api.example.test/v1",
      protocol: "openai-chat-completions",
      apiKey: "sk-another-secret"
    });
    input.providers[0]!.models.push({
      endpointId: "chat-other-key",
      model: "gpt-5-alias",
      source: "byok",
      capabilities: ["agent"]
    });

    await writeModelConfigCatalog(file, input);
    const raw = YAML.parse(readFileSync(file, "utf8")) as any;
    expect(Object.keys(raw.providers.openai.endpoints)).toEqual(["chat", "chat-other-key"]);
    expect(raw.providers.openai.endpoints["chat-other-key"].apiKey).toBe("sk-another-secret");
  });

  it("rejects invalid protocol capabilities and duplicate models", async () => {
    const file = fixture();
    const revision = (await readModelConfigCatalog(file)).configRevision;
    const wrongProtocol = openAiInput(revision);
    wrongProtocol.providers[0]!.models[0]!.capabilities = ["embedding"];
    await expect(writeModelConfigCatalog(file, wrongProtocol)).rejects.toThrow(/does not support capability embedding/);

    const responsesMemory = openAiInput(revision);
    responsesMemory.providers[0]!.endpoints[0]!.protocol = "openai-responses";
    responsesMemory.providers[0]!.models[0]!.capabilities = ["agent", "memory_summary", "memory_evolution"];
    const savedResponses = await writeModelConfigCatalog(file, responsesMemory);
    const responsesPresetId = savedResponses.providers[0]!.models[0]!.presetId!;
    const assignedResponses = openAiInput(savedResponses.configRevision, responsesPresetId);
    assignedResponses.providers[0]!.endpoints[0]!.protocol = "openai-responses";
    assignedResponses.providers[0]!.models[0]!.capabilities = ["agent", "memory_summary", "memory_evolution"];
    assignedResponses.modelAssignments.byok.memoryEvolution = responsesPresetId;
    await writeModelConfigCatalog(file, assignedResponses);
    expect((YAML.parse(readFileSync(file, "utf8")) as any).memmyMemory.evolution.provider).toBe("openai_responses");

    const bedrockMemory = openAiInput((await readModelConfigCatalog(file)).configRevision);
    bedrockMemory.providers = [{
      provider: "bedrock",
      endpoints: [{
        endpointId: "chat",
        apiBase: "https://bedrock-runtime.us-west-2.amazonaws.com",
        protocol: "bedrock-converse",
        region: "us-west-2"
      }],
      models: [{
        endpointId: "chat",
        model: "anthropic.claude-sonnet-5",
        source: "byok",
        capabilities: ["agent", "memory_summary", "memory_evolution"]
      }]
    }];
    const savedBedrock = await writeModelConfigCatalog(file, bedrockMemory);
    const bedrockPresetId = savedBedrock.providers[0]!.models[0]!.presetId!;
    bedrockMemory.configRevision = savedBedrock.configRevision;
    bedrockMemory.providers[0]!.models[0]!.presetId = bedrockPresetId;
    bedrockMemory.modelAssignments.byok.memorySummary = bedrockPresetId;
    await writeModelConfigCatalog(file, bedrockMemory);
    expect((YAML.parse(readFileSync(file, "utf8")) as any).memmyMemory.summary.provider).toBe("bedrock");

    const duplicateModel = openAiInput((await readModelConfigCatalog(file)).configRevision);
    duplicateModel.providers[0]!.models.push({
      endpointId: "chat",
      model: "gpt-5",
      source: "byok",
      capabilities: ["agent"]
    });
    await expect(writeModelConfigCatalog(file, duplicateModel)).rejects.toThrow(/Duplicate Provider\/endpoint\/model/);
  });

  it("rejects stale revisions without exposing or overwriting the newer config", async () => {
    const file = fixture({ futureSection: { value: 1 } });
    const current = await readModelConfigCatalog(file);
    writeFileSync(file, YAML.stringify({
      futureSection: { value: 2 },
      providers: { openai: { endpoints: {} } }
    }), "utf8");
    await expect(writeModelConfigCatalog(file, openAiInput(current.configRevision))).rejects.toBeInstanceOf(ModelConfigChangedError);
    expect((YAML.parse(readFileSync(file, "utf8")) as any).futureSection.value).toBe(2);
  });

  it("rejects account definitions at the desktop write boundary", async () => {
    const file = fixture();
    const input = openAiInput((await readModelConfigCatalog(file)).configRevision);
    input.providers = [{
      provider: "memmy_account",
      ownerAccountId: "owner-a",
      endpoints: [{ endpointId: "platform", apiBase: "https://cloud.example/v1", protocol: "memmy-account" }],
      models: [{
        endpointId: "platform", model: "agent_chat", source: "account", ownerAccountId: "owner-a", capabilities: ["agent"]
      }]
    }];
    await expect(writeModelConfigCatalog(file, input)).rejects.toBeInstanceOf(InvalidModelConfigError);
  });
});
