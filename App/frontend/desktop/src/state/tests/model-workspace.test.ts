import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelConfigInput, ModelConfigView } from "@memmy/local-api-contracts";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { CLIENT_PRESET_ID_PREFIX, persistModelCatalogMutation } from "../../api/config-client.js";
import {
  readModelConfigCatalog,
  writeModelConfigCatalog
} from "../../../../../backend/src/infrastructure/memmy-config/model-config-catalog.js";
import {
  MODEL_WORKSPACE_STORAGE_KEY,
  assignCatalogPreset,
  assignedCatalogEndpointId,
  clearLegacyModelWorkspace,
  createModelWorkspace,
  deleteModelConnection,
  getModelCandidates,
  getTaskModelCandidates,
  modelConfigInput,
  resolveModelSelection,
  setModelAssignment,
  setTaskModelCandidates,
  upsertByokPreset,
  upsertModelConnection
} from "../model-workspace.js";

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function catalogFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "frontend-model-catalog-"));
  fixtureRoots.push(root);
  const file = join(root, "config.yaml");
  writeFileSync(file, YAML.stringify({ futureSection: { keepMe: true } }), "utf8");
  return file;
}

async function deletionCatalogFixture(file: string): Promise<ModelConfigView> {
  const empty = await readModelConfigCatalog(file);
  const input: ModelConfigInput = {
    configRevision: empty.configRevision,
    providers: [{
      provider: "openai",
      endpoints: [
        { endpointId: "chat", apiBase: "https://api.openai.com/v1", protocol: "openai-chat-completions", apiKey: "sk-delete" },
        { endpointId: "embedding", apiBase: "https://api.openai.com/v1", protocol: "openai-embeddings", apiKey: "sk-delete" }
      ],
      models: [
        { endpointId: "chat", model: "gpt-delete", source: "byok", capabilities: ["agent"] },
        { endpointId: "embedding", model: "embedding-delete", source: "byok", capabilities: ["embedding"] }
      ]
    }],
    modelAssignments: structuredClone(emptyAssignments)
  };
  return writeModelConfigCatalog(file, input);
}

const emptyAssignments: ModelConfigInput["modelAssignments"] = {
  byok: { agent: { candidates: [], default: null }, memorySummary: null, memoryEvolution: null, embedding: null, asr: null, imageGeneration: null },
  account: { agent: { candidates: [], default: null }, memorySummary: null, memoryEvolution: null, embedding: null, asr: null, imageGeneration: null }
};

function catalog(): ModelConfigView {
  const accountAgent = {
    presetId: "account-agent",
    provider: "memmy_account" as const,
    endpointId: "account",
    protocol: "memmy-account" as const,
    model: "agent_chat",
    source: "account" as const,
    ownerAccountId: "owner-a",
    capabilities: ["agent" as const],
    available: true
  };
  const byokAgent = {
    presetId: "byok-agent",
    provider: "openai" as const,
    endpointId: "chat",
    protocol: "openai-chat-completions" as const,
    model: "gpt-4o",
    source: "byok" as const,
    capabilities: ["agent" as const],
    available: true
  };
  const byokEmbedding = {
    presetId: "byok-embedding",
    provider: "openai" as const,
    endpointId: "embedding",
    protocol: "openai-embeddings" as const,
    model: "text-embedding-3-small",
    source: "byok" as const,
    capabilities: ["embedding" as const],
    available: true
  };
  return {
    configRevision: "revision-1",
    providers: [
      {
        provider: "memmy_account",
        configured: true,
        hasApiKey: false,
        apiKeyMasked: "",
        apiKey: "",
        ownerAccountId: "owner-a",
        endpoints: [{ endpointId: "account", apiBase: "https://account.memmy.ai/v1", protocol: "memmy-account", hasApiKey: false, apiKeyMasked: "", apiKey: "" }],
        accountManaged: true,
        editable: false,
        models: [accountAgent]
      },
      {
        provider: "openai",
        configured: true,
        hasApiKey: false,
        apiKeyMasked: "",
        apiKey: "",
        endpoints: [
          { endpointId: "chat", apiBase: "https://api.openai.com/v1", protocol: "openai-chat-completions", hasApiKey: true, apiKeyMasked: "sk••••test", apiKey: "" },
          { endpointId: "embedding", apiBase: "https://api.openai.com/v1", protocol: "openai-embeddings", hasApiKey: true, apiKeyMasked: "sk••••test", apiKey: "" }
        ],
        accountManaged: false,
        editable: true,
        models: [byokAgent, byokEmbedding]
      }
    ],
    modelAssignments: {
      byok: {
        agent: { candidates: ["byok-agent"], default: "byok-agent" },
        memorySummary: null,
        memoryEvolution: null,
        embedding: "byok-embedding",
        asr: null,
        imageGeneration: null
      },
      account: {
        ownerAccountId: "owner-a",
        agent: { candidates: ["account-agent", "byok-agent"], default: "account-agent" },
        memorySummary: "account-agent",
        memoryEvolution: "account-agent",
        embedding: "byok-embedding",
        asr: null,
        imageGeneration: null
      }
    },
    effectiveCandidates: {
      byok: [byokAgent],
      account: [accountAgent, byokAgent]
    },
    configured: true,
    updatedAt: "2026-08-11T00:00:00.000Z"
  };
}

describe("canonical model workspace adapter", () => {
  it("真实 Backend catalog：空目录经 onboarding 两阶段创建 server UUID 并让一 preset 承载三种 chat capability", async () => {
    const file = catalogFixture();
    let workspace = createModelWorkspace(await readModelConfigCatalog(file));
    const agent = upsertByokPreset(workspace, {
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      protocol: "openai-chat-completions",
      apiKey: "sk-onboarding",
      model: "gpt-4o",
      capabilities: ["agent"]
    });
    workspace = assignCatalogPreset(agent.workspace, "byok", "agent", agent.presetId);
    const summary = upsertByokPreset(workspace, {
      provider: "openai",
      endpointId: agent.endpointId,
      endpoint: "https://api.openai.com/v1",
      protocol: "openai-chat-completions",
      model: "gpt-4o",
      capabilities: ["memory_summary"]
    });
    workspace = assignCatalogPreset(summary.workspace, "byok", "memory_summary", summary.presetId);
    const evolution = upsertByokPreset(workspace, {
      provider: "openai",
      endpointId: agent.endpointId,
      endpoint: "https://api.openai.com/v1",
      protocol: "openai-chat-completions",
      model: "gpt-4o",
      capabilities: ["memory_evolution"]
    });
    workspace = assignCatalogPreset(evolution.workspace, "byok", "memory_evolution", evolution.presetId);
    const embedding = upsertByokPreset(workspace, {
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      protocol: "openai-embeddings",
      apiKey: "sk-onboarding",
      model: "text-embedding-3-small",
      capabilities: ["embedding"]
    });
    workspace = assignCatalogPreset(embedding.workspace, "byok", "embedding", embedding.presetId);
    const alternateAuth = upsertByokPreset(workspace, {
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      protocol: "openai-chat-completions",
      apiKey: "sk-other-auth",
      model: "gpt-4o-alt",
      capabilities: ["agent"]
    });
    workspace = alternateAuth.workspace;

    expect(agent.presetId).toMatch(new RegExp(`^${CLIENT_PRESET_ID_PREFIX}`));
    const saved = await persistModelCatalogMutation(modelConfigInput(workspace), {
      read: () => readModelConfigCatalog(file),
      write: (input) => writeModelConfigCatalog(file, input)
    });
    const chat = saved.providers.flatMap((provider) => provider.models).find((model) => model.model === "gpt-4o")!;
    const embeddingSaved = saved.providers.flatMap((provider) => provider.models).find((model) => model.model === "text-embedding-3-small")!;
    const alternateAuthSaved = saved.providers.flatMap((provider) => provider.models).find((model) => model.model === "gpt-4o-alt")!;

    expect(chat.presetId).toMatch(/^[0-9a-f-]{36}$/);
    expect(embeddingSaved.presetId).toMatch(/^[0-9a-f-]{36}$/);
    expect(chat.capabilities).toEqual(["agent", "memory_summary", "memory_evolution"]);
    expect(alternateAuthSaved.endpointId).not.toBe(chat.endpointId);
    expect(saved.providers.find((provider) => provider.provider === "openai")?.endpoints).toHaveLength(3);
    expect(saved.modelAssignments.byok).toMatchObject({
      agent: { candidates: [chat.presetId], default: chat.presetId },
      memorySummary: chat.presetId,
      memoryEvolution: chat.presetId,
      embedding: embeddingSaved.presetId
    });
    const raw = YAML.parse(readFileSync(file, "utf8")) as any;
    expect(Object.keys(raw.modelPresets)).toHaveLength(3);
    expect(JSON.stringify(raw)).not.toContain(CLIENT_PRESET_ID_PREFIX);
    expect(raw.futureSection.keepMe).toBe(true);

    const savedWorkspace = createModelWorkspace(saved);
    const chatConnection = savedWorkspace.spaces.byok.connections.find((connection) => (
      connection.modelEntries.some((entry) => entry.presetId === chat.presetId)
    ))!;
    const moved = upsertModelConnection(savedWorkspace, "byok", {
      id: chatConnection.id,
      provider: "anthropic",
      endpoint: "https://api.anthropic.com",
      protocol: "anthropic-messages",
      apiKey: "sk-anthropic",
      models: ["claude-sonnet-4"],
      modelEntries: [{ presetId: chat.presetId, model: "claude-sonnet-4", capability: "chat" }]
    });
    expect(moved.error).toBeNull();
    const movedSaved = await persistModelCatalogMutation(modelConfigInput(moved.workspace), {
      read: () => readModelConfigCatalog(file),
      write: (input) => writeModelConfigCatalog(file, input)
    });
    expect(movedSaved.providers.find((provider) => provider.provider === "openai")?.models.map((model) => model.presetId))
      .toEqual(expect.arrayContaining([embeddingSaved.presetId, alternateAuthSaved.presetId]));
    expect(movedSaved.providers.find((provider) => provider.provider === "anthropic")?.models)
      .toEqual([expect.objectContaining({ presetId: chat.presetId, model: "claude-sonnet-4" })]);
  });

  it("真实 Backend catalog：phase2 revision 冲突会 reload/rebase，phase1 创建的 UUID 不丢失", async () => {
    const file = catalogFixture();
    let workspace = createModelWorkspace(await readModelConfigCatalog(file));
    const agent = upsertByokPreset(workspace, {
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      protocol: "openai-chat-completions",
      apiKey: "sk-conflict",
      model: "gpt-4.1",
      capabilities: ["agent"]
    });
    workspace = assignCatalogPreset(agent.workspace, "byok", "agent", agent.presetId);
    let writeCount = 0;
    const saved = await persistModelCatalogMutation(modelConfigInput(workspace), {
      read: () => readModelConfigCatalog(file),
      write: async (input) => {
        writeCount += 1;
        if (writeCount === 2) {
          const raw = YAML.parse(readFileSync(file, "utf8")) as any;
          raw.providers.openai.concurrentMarker = "keep-me";
          writeFileSync(file, YAML.stringify(raw), "utf8");
        }
        return writeModelConfigCatalog(file, input);
      }
    });
    const preset = saved.providers.flatMap((provider) => provider.models).find((model) => model.model === "gpt-4.1")!;

    expect(writeCount).toBe(3);
    expect(preset.presetId).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.modelAssignments.byok.agent).toEqual({ candidates: [preset.presetId], default: preset.presetId });
    expect((YAML.parse(readFileSync(file, "utf8")) as any).providers.openai.concurrentMarker).toBe("keep-me");
  });

  it("真实 Backend catalog：第二段只换模型时复用主 Agent 的 masked Key endpoint", async () => {
    const file = catalogFixture();
    const base = await readModelConfigCatalog(file);
    let workspace = createModelWorkspace(base);
    const agent = upsertByokPreset(workspace, {
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      protocol: "openai-chat-completions",
      apiKey: "sk-primary",
      model: "gpt-4.1",
      capabilities: ["agent"]
    });
    workspace = assignCatalogPreset(agent.workspace, "byok", "agent", agent.presetId);
    const primarySaved = await persistModelCatalogMutation(modelConfigInput(workspace), {
      read: () => readModelConfigCatalog(file),
      write: (input) => writeModelConfigCatalog(file, input)
    }, base);

    workspace = createModelWorkspace(primarySaved);
    const endpointId = assignedCatalogEndpointId(workspace, "byok", "agent")!;
    const endpoint = primarySaved.providers[0]!.endpoints.find((item) => item.endpointId === endpointId)!;
    const summary = upsertByokPreset(workspace, {
      provider: "openai",
      endpointId,
      endpoint: endpoint.apiBase,
      protocol: endpoint.protocol,
      apiKeyMasked: endpoint.apiKeyMasked,
      model: "gpt-4.1-mini",
      capabilities: ["memory_summary"]
    });
    workspace = assignCatalogPreset(summary.workspace, "byok", "memory_summary", summary.presetId);
    const saved = await persistModelCatalogMutation(modelConfigInput(workspace), {
      read: () => readModelConfigCatalog(file),
      write: (input) => writeModelConfigCatalog(file, input)
    }, primarySaved);
    const summarySaved = saved.providers[0]!.models.find((item) => item.model === "gpt-4.1-mini")!;

    expect(summarySaved.endpointId).toBe(endpointId);
    expect(saved.modelAssignments.byok.memorySummary).toBe(summarySaved.presetId);
    expect((YAML.parse(readFileSync(file, "utf8")) as any).providers.openai.endpoints[endpointId].apiKey).toBe("sk-primary");
  });

  it("真实 Backend catalog：无 pending 的编辑在 409 后三方重放且保留并发 account/未知字段", async () => {
    const file = catalogFixture();
    const empty = await readModelConfigCatalog(file);
    let workspace = createModelWorkspace(empty);
    const agent = upsertByokPreset(workspace, {
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      protocol: "openai-chat-completions",
      apiKey: "sk-edit",
      model: "gpt-before",
      capabilities: ["agent"]
    });
    workspace = assignCatalogPreset(agent.workspace, "byok", "agent", agent.presetId);
    const embedding = upsertByokPreset(workspace, {
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      protocol: "openai-embeddings",
      apiKey: "sk-edit",
      model: "embedding-before",
      capabilities: ["embedding"]
    });
    workspace = assignCatalogPreset(embedding.workspace, "byok", "embedding", embedding.presetId);
    const base = await persistModelCatalogMutation(modelConfigInput(workspace), {
      read: () => readModelConfigCatalog(file),
      write: (input) => writeModelConfigCatalog(file, input)
    }, empty);

    workspace = createModelWorkspace(base);
    const chatConnection = workspace.spaces.byok.connections.find((item) => item.models.includes("gpt-before"))!;
    const edited = upsertModelConnection(workspace, "byok", {
      id: chatConnection.id,
      provider: "openai",
      endpoint: chatConnection.endpoint,
      protocol: chatConnection.protocol,
      models: ["gpt-after"],
      modelEntries: [{ presetId: chatConnection.modelEntries[0]!.presetId, model: "gpt-after", capability: "chat" }]
    });
    expect(edited.error).toBeNull();
    let writeCount = 0;
    const saved = await persistModelCatalogMutation(modelConfigInput(edited.workspace), {
      read: () => readModelConfigCatalog(file),
      write: async (input) => {
        writeCount += 1;
        if (writeCount === 1) {
          const raw = YAML.parse(readFileSync(file, "utf8")) as any;
          raw.modelAssignments.account.ownerAccountId = "concurrent-owner";
          raw.concurrentSection = { keepMe: true };
          writeFileSync(file, YAML.stringify(raw), "utf8");
        }
        return writeModelConfigCatalog(file, input);
      }
    }, base);

    expect(writeCount).toBe(2);
    expect(saved.providers.flatMap((provider) => provider.models).map((item) => item.model)).toContain("gpt-after");
    expect(saved.providers.flatMap((provider) => provider.models).map((item) => item.model)).toContain("embedding-before");
    expect(saved.modelAssignments.account.ownerAccountId).toBe("concurrent-owner");
    expect((YAML.parse(readFileSync(file, "utf8")) as any).concurrentSection.keepMe).toBe(true);
  });

  it("真实 Backend catalog：无并发时允许删除 endpoint 与 preset", async () => {
    const file = catalogFixture();
    const base = await deletionCatalogFixture(file);
    const desired = modelConfigInput(createModelWorkspace(base));
    desired.providers[0]!.endpoints = desired.providers[0]!.endpoints.filter((endpoint) => endpoint.endpointId !== "embedding");
    desired.providers[0]!.models = desired.providers[0]!.models.filter((model) => model.endpointId !== "embedding");

    const saved = await persistModelCatalogMutation(desired, {
      read: () => readModelConfigCatalog(file),
      write: (input) => writeModelConfigCatalog(file, input)
    }, base);

    expect(saved.providers[0]!.endpoints.map((endpoint) => endpoint.endpointId)).not.toContain("embedding");
    expect(saved.providers[0]!.models.map((model) => model.model)).not.toContain("embedding-delete");
  });

  it("真实 Backend catalog：从账号空间删除共享 DashScope 配置并清理双空间引用", async () => {
    const file = catalogFixture();
    const empty = await readModelConfigCatalog(file);
    let workspace = createModelWorkspace(empty);
    const created = upsertByokPreset(workspace, {
      provider: "dashscope",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      protocol: "openai-chat-completions",
      apiKey: "sk-dashscope-delete",
      model: "qwen-max",
      capabilities: ["agent"]
    });
    workspace = assignCatalogPreset(created.workspace, "byok", "agent", created.presetId);
    workspace = assignCatalogPreset(workspace, "account", "agent", created.presetId);
    const base = await persistModelCatalogMutation(modelConfigInput(workspace), {
      read: () => readModelConfigCatalog(file),
      write: (input) => writeModelConfigCatalog(file, input)
    }, empty);

    workspace = createModelWorkspace(base);
    const connection = workspace.spaces.account.connections.find((item) => item.provider === "dashscope")!;
    const deleted = deleteModelConnection(workspace, "account", connection.id);

    expect(deleted.error).toBeNull();
    expect(deleted.workspace.catalog.modelAssignments.byok.agent).toEqual({ candidates: [], default: null });
    expect(deleted.workspace.catalog.modelAssignments.account.agent).toEqual({ candidates: [], default: null });

    const saved = await persistModelCatalogMutation(modelConfigInput(deleted.workspace), {
      read: () => readModelConfigCatalog(file),
      write: (input) => writeModelConfigCatalog(file, input)
    }, base);
    const raw = YAML.parse(readFileSync(file, "utf8")) as any;

    expect(saved.providers.some((provider) => provider.provider === "dashscope")).toBe(false);
    expect(raw.providers?.dashscope).toBeUndefined();
    expect(Object.values(raw.modelPresets ?? {})).not.toContainEqual(expect.objectContaining({ provider: "dashscope" }));
  });

  it("真实 Backend catalog：删除遇到不可见 Key 并发轮换时拒绝重放", async () => {
    const file = catalogFixture();
    const base = await deletionCatalogFixture(file);
    const desired = modelConfigInput(createModelWorkspace(base));
    desired.providers[0]!.endpoints = desired.providers[0]!.endpoints.filter((endpoint) => endpoint.endpointId !== "embedding");
    desired.providers[0]!.models = desired.providers[0]!.models.filter((model) => model.endpointId !== "embedding");

    const concurrent = modelConfigInput(createModelWorkspace(base));
    concurrent.providers[0]!.endpoints.find((endpoint) => endpoint.endpointId === "embedding")!.apiKey = "sk-rotated-secret";
    await writeModelConfigCatalog(file, concurrent);

    await expect(persistModelCatalogMutation(desired, {
      read: () => readModelConfigCatalog(file),
      write: (input) => writeModelConfigCatalog(file, input)
    }, base)).rejects.toMatchObject({ code: "model_config_changed" });
    const raw = YAML.parse(readFileSync(file, "utf8")) as any;
    expect(raw.providers.openai.endpoints.embedding.apiKey).toBe("sk-rotated-secret");
  });

  it("真实 Backend catalog：409 rebase 不会删除被并发修改的 endpoint", async () => {
    const file = catalogFixture();
    const base = await deletionCatalogFixture(file);
    const desired = modelConfigInput(createModelWorkspace(base));
    const desiredProvider = desired.providers[0]!;
    desiredProvider.endpoints = desiredProvider.endpoints.filter((endpoint) => endpoint.endpointId !== "embedding");
    desiredProvider.models = desiredProvider.models.filter((model) => model.endpointId !== "embedding");

    const concurrent = modelConfigInput(createModelWorkspace(base));
    concurrent.providers[0]!.endpoints.find((endpoint) => endpoint.endpointId === "embedding")!.apiBase = "https://concurrent.example/v1";
    await writeModelConfigCatalog(file, concurrent);

    await expect(persistModelCatalogMutation(desired, {
      read: () => readModelConfigCatalog(file),
      write: (input) => writeModelConfigCatalog(file, input)
    }, base)).rejects.toMatchObject({ code: "model_config_changed" });
    expect((await readModelConfigCatalog(file)).providers[0]!.endpoints)
      .toContainEqual(expect.objectContaining({ endpointId: "embedding", apiBase: "https://concurrent.example/v1" }));
  });

  it("真实 Backend catalog：409 rebase 不会删除被并发修改的 preset", async () => {
    const file = catalogFixture();
    const base = await deletionCatalogFixture(file);
    const target = base.providers[0]!.models.find((model) => model.model === "embedding-delete")!;
    const desired = modelConfigInput(createModelWorkspace(base));
    desired.providers[0]!.models = desired.providers[0]!.models.filter((model) => model.presetId !== target.presetId);

    const concurrent = modelConfigInput(createModelWorkspace(base));
    concurrent.providers[0]!.models.find((model) => model.presetId === target.presetId)!.model = "embedding-concurrent";
    await writeModelConfigCatalog(file, concurrent);

    await expect(persistModelCatalogMutation(desired, {
      read: () => readModelConfigCatalog(file),
      write: (input) => writeModelConfigCatalog(file, input)
    }, base)).rejects.toMatchObject({ code: "model_config_changed" });
    expect((await readModelConfigCatalog(file)).providers[0]!.models)
      .toContainEqual(expect.objectContaining({ presetId: target.presetId, model: "embedding-concurrent" }));
  });

  it("真实 Backend catalog：409 rebase 不会删除并发新增子项的 Provider", async () => {
    const file = catalogFixture();
    const base = await deletionCatalogFixture(file);
    const desired = modelConfigInput(createModelWorkspace(base));
    desired.providers = [];

    const concurrent = modelConfigInput(createModelWorkspace(base));
    concurrent.providers[0]!.endpoints.push({
      endpointId: "asr",
      apiBase: "https://concurrent.example/v1",
      protocol: "dashscope-input-audio-chat",
      apiKey: "sk-concurrent"
    });
    concurrent.providers[0]!.models.push({
      endpointId: "asr",
      model: "whisper-concurrent",
      source: "byok",
      capabilities: ["asr"]
    });
    await writeModelConfigCatalog(file, concurrent);

    await expect(persistModelCatalogMutation(desired, {
      read: () => readModelConfigCatalog(file),
      write: (input) => writeModelConfigCatalog(file, input)
    }, base)).rejects.toMatchObject({ code: "model_config_changed" });
    expect((await readModelConfigCatalog(file)).providers[0]!.models)
      .toContainEqual(expect.objectContaining({ model: "whisper-concurrent" }));
  });

  it("真实 Backend catalog：phase1 首次 409 后重放创建 intent 并继续 server UUID assignment", async () => {
    const file = catalogFixture();
    const base = await readModelConfigCatalog(file);
    let workspace = createModelWorkspace(base);
    const agent = upsertByokPreset(workspace, {
      provider: "deepseek",
      endpoint: "https://api.deepseek.com/v1",
      protocol: "openai-chat-completions",
      apiKey: "sk-phase1",
      model: "deepseek-chat",
      capabilities: ["agent"]
    });
    workspace = assignCatalogPreset(agent.workspace, "byok", "agent", agent.presetId);
    let writeCount = 0;
    const saved = await persistModelCatalogMutation(modelConfigInput(workspace), {
      read: () => readModelConfigCatalog(file),
      write: async (input) => {
        writeCount += 1;
        if (writeCount === 1) {
          const raw = YAML.parse(readFileSync(file, "utf8")) as any;
          raw.agents = { defaults: { concurrentMarker: "keep-me" } };
          writeFileSync(file, YAML.stringify(raw), "utf8");
        }
        return writeModelConfigCatalog(file, input);
      }
    }, base);
    const preset = saved.providers[0]!.models[0]!;

    expect(writeCount).toBe(4);
    expect(preset.presetId).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.modelAssignments.byok.agent).toEqual({ candidates: [preset.presetId], default: preset.presetId });
    expect((YAML.parse(readFileSync(file, "utf8")) as any).agents.defaults.concurrentMarker).toBe("keep-me");
  });

  it("真实 Backend catalog：Provider 切换遇到目标同名 endpointId 时生成新 ID 并保留目标定义", async () => {
    const file = catalogFixture();
    const empty = await readModelConfigCatalog(file);
    const created = await writeModelConfigCatalog(file, {
      configRevision: empty.configRevision,
      providers: [
        {
          provider: "openai",
          endpoints: [{ endpointId: "shared", apiBase: "https://api.openai.com/v1", protocol: "openai-chat-completions", apiKey: "sk-openai" }],
          models: [{ endpointId: "shared", model: "gpt-source", source: "byok", capabilities: ["agent"] }]
        },
        {
          provider: "anthropic",
          endpoints: [{ endpointId: "shared", apiBase: "https://api.anthropic.com", protocol: "anthropic-messages", apiKey: "sk-existing" }],
          models: [{ endpointId: "shared", model: "claude-existing", source: "byok", capabilities: ["agent"] }]
        }
      ],
      modelAssignments: structuredClone(emptyAssignments)
    });
    const sourcePreset = created.providers.find((item) => item.provider === "openai")!.models[0]!;
    const assignedInput = modelConfigInput(createModelWorkspace(created));
    assignedInput.modelAssignments.byok.agent = { candidates: [sourcePreset.presetId], default: sourcePreset.presetId };
    const base = await writeModelConfigCatalog(file, assignedInput);
    const workspace = createModelWorkspace(base);
    const sourceConnection = workspace.spaces.byok.connections.find((item) => item.provider === "openai")!;
    const moved = upsertModelConnection(workspace, "byok", {
      id: sourceConnection.id,
      provider: "anthropic",
      endpoint: "https://api.anthropic.com/v1/moved",
      protocol: "anthropic-messages",
      apiKey: "sk-moved",
      models: ["claude-moved"],
      modelEntries: [{ presetId: sourcePreset.presetId, model: "claude-moved", capability: "chat" }]
    });
    expect(moved.error).toBeNull();
    const saved = await persistModelCatalogMutation(modelConfigInput(moved.workspace), {
      read: () => readModelConfigCatalog(file),
      write: (input) => writeModelConfigCatalog(file, input)
    }, base);
    const anthropic = saved.providers.find((item) => item.provider === "anthropic")!;
    const movedPreset = anthropic.models.find((item) => item.presetId === sourcePreset.presetId)!;

    expect(saved.providers.some((item) => item.provider === "openai")).toBe(false);
    expect(anthropic.endpoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ endpointId: "shared", apiBase: "https://api.anthropic.com" }),
      expect.objectContaining({ endpointId: movedPreset.endpointId, apiBase: "https://api.anthropic.com/v1/moved" })
    ]));
    expect(movedPreset.endpointId).not.toBe("shared");
    expect(anthropic.models.map((item) => item.model)).toEqual(expect.arrayContaining(["claude-existing", "claude-moved"]));
    expect(saved.modelAssignments.byok.agent).toEqual({ candidates: [sourcePreset.presetId], default: sourcePreset.presetId });
  });

  it("账号模式展示平台和当前 BYOK，本地模式只展示 BYOK，并严格按 capability 过滤", () => {
    const workspace = createModelWorkspace(catalog());

    expect(getModelCandidates(workspace, "account", "chat").map((item) => item.id)).toEqual(["account-agent", "byok-agent"]);
    expect(getModelCandidates(workspace, "byok", "chat").map((item) => item.id)).toEqual(["byok-agent"]);
    expect(getModelCandidates(workspace, "byok", "embedding").map((item) => item.id)).toEqual(["byok-embedding"]);
    expect(getModelCandidates(workspace, "byok", "asr")).toEqual([]);
  });

  it("同 Provider 的 Chat 与 Embedding 使用独立 endpoint/protocol", () => {
    const workspace = createModelWorkspace(catalog());
    expect(workspace.spaces.byok.connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ endpointId: "chat", protocol: "openai-chat-completions", models: ["gpt-4o"] }),
      expect.objectContaining({ endpointId: "embedding", protocol: "openai-embeddings", models: ["text-embedding-3-small"] })
    ]));
  });

  it("endpoint 只在完整 auth identity 相同时复用，不会让 KeyA/KeyB 串用", () => {
    let workspace = createModelWorkspace({
      ...catalog(),
      providers: [],
      modelAssignments: {
        byok: { agent: { candidates: [], default: null }, memorySummary: null, memoryEvolution: null, embedding: null, asr: null, imageGeneration: null },
        account: { agent: { candidates: [], default: null }, memorySummary: null, memoryEvolution: null, embedding: null, asr: null, imageGeneration: null }
      },
      effectiveCandidates: { byok: [], account: [] }
    });
    const keyA = upsertByokPreset(workspace, {
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      protocol: "openai-chat-completions",
      apiKey: "sk-key-a",
      model: "gpt-a",
      capabilities: ["agent"]
    });
    workspace = keyA.workspace;
    const keyB = upsertByokPreset(workspace, {
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      protocol: "openai-chat-completions",
      apiKey: "sk-key-b",
      model: "gpt-b",
      capabilities: ["agent"]
    });
    workspace = keyB.workspace;
    const keyBAgain = upsertByokPreset(workspace, {
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      protocol: "openai-chat-completions",
      apiKey: "sk-key-b",
      model: "gpt-b-mini",
      capabilities: ["agent"]
    });
    const provider = keyBAgain.workspace.catalog.providers[0]!;

    expect(provider.endpoints).toHaveLength(2);
    const modelA = provider.models.find((item) => item.model === "gpt-a")!;
    const modelB = provider.models.find((item) => item.model === "gpt-b")!;
    const modelBAgain = provider.models.find((item) => item.model === "gpt-b-mini")!;
    expect(modelA.endpointId).not.toBe(modelB.endpointId);
    expect(modelBAgain.endpointId).toBe(modelB.endpointId);
  });

  it("编辑 preset 保留稳定 ID，改变为 endpoint 不支持的 capability 会失败", () => {
    const workspace = createModelWorkspace(catalog());
    const chatConnection = workspace.spaces.byok.connections.find((item) => item.endpointId === "chat")!;
    const edited = upsertModelConnection(workspace, "byok", {
      id: chatConnection.id,
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      protocol: "openai-chat-completions",
      models: ["gpt-4.1"],
      modelCapabilities: { "gpt-4.1": "chat" }
    });
    expect(edited.error).toBeNull();
    expect(getModelCandidates(edited.workspace, "byok", "chat")[0]?.id).toBe("byok-agent");

    const invalid = upsertModelConnection(workspace, "byok", {
      id: chatConnection.id,
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      protocol: "openai-chat-completions",
      models: ["text-embedding-3-large"],
      modelCapabilities: { "text-embedding-3-large": "embedding" }
    });
    expect(invalid.error).toBe("incompatible_model_capabilities");
  });

  it("编辑连接切换 Provider 会从旧 Provider 原子移除 endpoint/preset 并保留服务端 presetId", () => {
    const workspace = createModelWorkspace(catalog());
    const chatConnection = workspace.spaces.byok.connections.find((item) => item.endpointId === "chat")!;
    const moved = upsertModelConnection(workspace, "byok", {
      id: chatConnection.id,
      provider: "anthropic",
      endpoint: "https://api.anthropic.com",
      protocol: "anthropic-messages",
      apiKey: "sk-ant-new",
      models: ["claude-sonnet-4"],
      modelEntries: [{ presetId: "byok-agent", model: "claude-sonnet-4", capability: "chat" }]
    });
    expect(moved.error).toBeNull();
    const input = modelConfigInput(moved.workspace);
    expect(input.providers.find((item) => item.provider === "openai")?.models.map((item) => item.presetId))
      .toEqual(["byok-embedding"]);
    expect(input.providers.find((item) => item.provider === "anthropic")?.models)
      .toEqual([expect.objectContaining({ presetId: "byok-agent", model: "claude-sonnet-4" })]);
    expect(input.providers.flatMap((provider) => provider.models).filter((model) => model.presetId === "byok-agent"))
      .toHaveLength(1);
  });

  it("account 与 byok Assignment 独立，账号态增删候选不改本地默认和单选", () => {
    const workspace = createModelWorkspace(catalog());
    const originalByok = structuredClone(workspace.catalog.modelAssignments.byok);
    const accountOnly = setTaskModelCandidates(workspace, "account", ["byok-agent"]);
    const assigned = setModelAssignment(accountOnly, "account", "embedding", "byok-embedding");

    expect(assigned.catalog.modelAssignments.account.agent).toEqual({ candidates: ["byok-agent"], default: "byok-agent" });
    expect(assigned.catalog.modelAssignments.byok).toEqual(originalByok);
  });

  it("删除账号空间可见的共享 BYOK 连接时同步清理两个空间的引用", () => {
    const result = deleteModelConnection(createModelWorkspace(catalog()), "account", "openai:chat");

    expect(result.error).toBeNull();
    expect(result.workspace.catalog.providers.find((provider) => provider.provider === "openai")?.endpoints)
      .toEqual([expect.objectContaining({ endpointId: "embedding" })]);
    expect(result.workspace.catalog.modelAssignments.byok.agent)
      .toEqual({ candidates: [], default: null });
    expect(result.workspace.catalog.modelAssignments.account.agent)
      .toEqual({ candidates: ["account-agent"], default: "account-agent" });
    expect(result.workspace.catalog.effectiveCandidates.byok).toEqual([]);
    expect(result.workspace.catalog.effectiveCandidates.account.map((candidate) => candidate.presetId))
      .toEqual(["account-agent"]);
  });

  it("Agent 多选/default 与其他任务单选引用 preset ID", () => {
    const workspace = createModelWorkspace(catalog());
    expect(getTaskModelCandidates(workspace, "account").map((item) => item.id)).toEqual(["account-agent", "byok-agent"]);
    expect(resolveModelSelection(workspace, "account", null).candidateId).toBe("account-agent");
    expect(resolveModelSelection(workspace, "byok", "missing")).toMatchObject({ unavailable: true, candidateId: "missing" });
  });

  it("会话唯一 Agent 候选被删除后仍保留 unavailable 墓碑", () => {
    const workspace = createModelWorkspace(catalog());
    workspace.catalog.modelAssignments.byok.agent = { candidates: [], default: null };

    expect(resolveModelSelection(workspace, "byok", "byok-agent")).toEqual({
      candidate: null,
      candidateId: "byok-agent",
      unavailable: true,
      reason: "unavailable"
    });
  });

  it("引导只 patch 自己的 endpoint/preset/assignment 并保留既有目录项", () => {
    let workspace = createModelWorkspace(catalog());
    const summary = upsertByokPreset(workspace, {
      provider: "openai",
      endpointId: "chat",
      endpoint: "https://api.openai.com/v1",
      protocol: "openai-chat-completions",
      model: "gpt-4o-mini",
      capabilities: ["memory_summary"]
    });
    workspace = assignCatalogPreset(summary.workspace, "byok", "memory_summary", summary.presetId);
    const input = modelConfigInput(workspace);

    expect(getModelCandidates(workspace, "byok", "memorySummary").map((item) => item.id)).toContain(summary.presetId);
    expect(getModelCandidates(workspace, "byok", "chat").map((item) => item.id)).not.toContain(summary.presetId);
    expect(input.configRevision).toBe("revision-1");
    expect(input.providers.find((item) => item.provider === "openai")?.models.map((item) => item.presetId))
      .toEqual(expect.arrayContaining(["byok-agent", "byok-embedding", summary.presetId]));
    expect(input.modelAssignments.byok.memorySummary).toBe(summary.presetId);
    expect(input.modelAssignments.account.agent.default).toBe("account-agent");
  });

  it("同 provider/endpoint/model 的 Agent、记忆总结、记忆演化合并为一 preset capability union", () => {
    let workspace = createModelWorkspace(catalog());
    const agent = upsertByokPreset(workspace, {
      provider: "openai",
      endpointId: "chat",
      endpoint: "https://api.openai.com/v1",
      protocol: "openai-chat-completions",
      apiKeyMasked: "sk••••test",
      model: "gpt-4o",
      capabilities: ["agent"]
    });
    workspace = assignCatalogPreset(agent.workspace, "byok", "agent", agent.presetId);
    const summary = upsertByokPreset(workspace, {
      provider: "openai",
      endpointId: "chat",
      endpoint: "https://api.openai.com/v1",
      protocol: "openai-chat-completions",
      apiKeyMasked: "sk••••test",
      model: "gpt-4o",
      capabilities: ["memory_summary"]
    });
    workspace = assignCatalogPreset(summary.workspace, "byok", "memory_summary", summary.presetId);
    const evolution = upsertByokPreset(workspace, {
      provider: "openai",
      endpointId: "chat",
      endpoint: "https://api.openai.com/v1",
      protocol: "openai-chat-completions",
      apiKeyMasked: "sk••••test",
      model: "gpt-4o",
      capabilities: ["memory_evolution"]
    });
    workspace = assignCatalogPreset(evolution.workspace, "byok", "memory_evolution", evolution.presetId);

    const ids = [agent.presetId, summary.presetId, evolution.presetId];
    expect(new Set(ids).size).toBe(1);
    expect(workspace.spaces.byok.connections.find((item) => item.endpointId === "chat")?.modelEntries)
      .toEqual([
        expect.objectContaining({
          presetId: agent.presetId,
          model: "gpt-4o",
          capabilities: ["agent", "memory_summary", "memory_evolution"]
        })
      ]);
    expect(modelConfigInput(workspace).modelAssignments.byok).toMatchObject({
      agent: { default: agent.presetId },
      memorySummary: summary.presetId,
      memoryEvolution: evolution.presetId
    });
  });

  it("首次真实读取后只删除旧 workspace key，不读取或迁移其内容", () => {
    const removed: string[] = [];
    clearLegacyModelWorkspace({ removeItem: (key) => { removed.push(key); } });
    expect(removed).toEqual([MODEL_WORKSPACE_STORAGE_KEY]);
  });

  it("DTO 不包含 label、maxTokens 或 dailyTokenLimit", () => {
    const serialized = JSON.stringify(modelConfigInput(createModelWorkspace(catalog())));
    expect(serialized).not.toContain("label");
    expect(serialized).not.toContain("maxTokens");
    expect(serialized).not.toContain("dailyTokenLimit");
  });
});
