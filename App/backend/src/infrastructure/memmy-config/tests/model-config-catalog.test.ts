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

describe("model config catalog", () => {
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

    const followInput = structuredClone(assigned);
    followInput.configRevision = saved.configRevision;
    followInput.modelAssignments.byok.memorySummary = agentId;
    followInput.modelAssignments.byok.memoryEvolution = agentId;
    const followed = await writeModelConfigCatalog(file, followInput);
    expect(followed.memorySettings?.roleRouting.summary).toBe("follow");
    expect(followed.memorySettings?.roleRouting.evolution).toBe("follow");
    expect((YAML.parse(readFileSync(file, "utf8")) as any).memmyMemory.roleRouting.summary).toBe("follow");
  });

  it("rejects duplicate endpoint definitions, invalid protocol capabilities, and duplicate models", async () => {
    const file = fixture();
    const revision = (await readModelConfigCatalog(file)).configRevision;
    const duplicateEndpoint = openAiInput(revision);
    duplicateEndpoint.providers[0]!.endpoints.push({
      endpointId: "chat-copy",
      apiBase: "https://api.example.test/v1",
      protocol: "openai-chat-completions"
    });
    await expect(writeModelConfigCatalog(file, duplicateEndpoint)).rejects.toThrow(/Duplicate endpoint definition/);

    const wrongProtocol = openAiInput(revision);
    wrongProtocol.providers[0]!.models[0]!.capabilities = ["embedding"];
    await expect(writeModelConfigCatalog(file, wrongProtocol)).rejects.toThrow(/does not support capability embedding/);

    const unsupportedMemoryResponses = openAiInput(revision);
    unsupportedMemoryResponses.providers[0]!.endpoints[0]!.protocol = "openai-responses";
    unsupportedMemoryResponses.providers[0]!.models[0]!.capabilities = ["memory_summary"];
    await expect(writeModelConfigCatalog(file, unsupportedMemoryResponses))
      .rejects.toThrow(/does not support capability memory_summary/);

    const duplicateModel = openAiInput(revision);
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
