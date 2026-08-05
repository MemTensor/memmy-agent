import { describe, expect, it } from "vitest";
import type { ModelProviderConfig } from "../../api/config-client.js";
import {
  MODEL_WORKSPACE_STORAGE_KEY,
  addConnectionModel,
  buildWorkspaceUsageRows,
  createModelWorkspaceSeed,
  deleteConnectionModel,
  deleteModelConnection,
  getModelCandidates,
  maskApiKey,
  persistModelWorkspace,
  readModelWorkspace,
  resolveScopedModelSelection,
  setModelConnectionAvailability,
  setScopedModelSelection,
  transferScopedModelSelection,
  upsertModelConnection,
  writeModelWorkspace
} from "../model-workspace.js";

const legacyConfig: ModelProviderConfig = {
  provider: "openai",
  endpoint: "https://api.example.com/v1",
  model: "legacy-chat",
  apiKey: "",
  apiKeyMasked: "••••••••1234",
  configured: true,
  embedding: null,
  memmyMemory: null,
  asr: null,
  imageGen: null
};

function createWorkspaceWithAccountByok() {
  return upsertModelConnection(createModelWorkspaceSeed(), "account", {
    id: "account-anthropic",
    provider: "anthropic",
    endpoint: "https://api.anthropic.com",
    apiKey: "secret",
    models: ["claude-sonnet-4", "claude-haiku-4"]
  }).workspace;
}

describe("model workspace connections", () => {
  it("seeds the current single config as the first local connection", () => {
    const workspace = createModelWorkspaceSeed(legacyConfig);

    expect(workspace.spaces.byok.connections[0]).toMatchObject({
      provider: "openai",
      endpoint: "https://api.example.com/v1",
      models: ["legacy-chat"]
    });
    expect(workspace.spaces.account.connections).toHaveLength(0);
    expect(getModelCandidates(workspace, "account").map((item) => item.model)).toEqual(["agent_chat"]);
    expect(getModelCandidates(workspace, "account", "embedding").map((item) => item.model)).toEqual(["embedding"]);
    expect(getModelCandidates(workspace, "account", "asr").map((item) => item.model)).toEqual(["asr"]);
    expect(getModelCandidates(workspace, "account", "image")).toEqual([]);
  });

  it("enforces provider uniqueness inside each space only", () => {
    const workspace = createWorkspaceWithAccountByok();
    const duplicate = upsertModelConnection(workspace, "account", {
      provider: "Anthropic",
      endpoint: "https://other.example.com",
      apiKey: "secret",
      models: ["model-a"]
    });
    const local = upsertModelConnection(workspace, "byok", {
      id: "local-anthropic",
      provider: "Anthropic",
      endpoint: "https://other.example.com",
      apiKey: "secret",
      models: ["model-a"]
    });

    expect(duplicate.error).toBe("duplicate_provider");
    expect(local.error).toBeNull();
    expect(local.workspace.spaces.byok.connections[0]?.apiKeyMasked).toBe("••••••••cret");
  });

  it("supports connection and model CRUD without changing candidate order", () => {
    const created = upsertModelConnection(createModelWorkspaceSeed(), "byok", {
      id: "openai-local",
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      apiKey: "sk-test-secret",
      models: ["gpt-4o"]
    });
    expect(created.error).toBeNull();

    const withModel = addConnectionModel(created.workspace, "byok", "openai-local", "gpt-4.1");
    expect(withModel.error).toBeNull();
    expect(getModelCandidates(withModel.workspace, "byok").map((item) => item.model)).toEqual([
      "gpt-4o",
      "gpt-4.1"
    ]);

    const withEmbedding = addConnectionModel(
      withModel.workspace,
      "byok",
      "openai-local",
      "text-embedding-3-small",
      "embedding"
    );
    expect(getModelCandidates(withEmbedding.workspace, "byok", "chat").map((item) => item.model)).toEqual([
      "gpt-4o",
      "gpt-4.1"
    ]);
    expect(getModelCandidates(withEmbedding.workspace, "byok", "embedding").map((item) => item.model)).toEqual([
      "text-embedding-3-small"
    ]);

    const duplicate = addConnectionModel(withEmbedding.workspace, "byok", "openai-local", "GPT-4.1");
    expect(duplicate.error).toBe("duplicate_model");

    const withoutModel = deleteConnectionModel(withModel.workspace, "byok", "openai-local", "gpt-4o");
    expect(getModelCandidates(withoutModel.workspace, "byok").map((item) => item.model)).toEqual(["gpt-4.1"]);

    const deleted = deleteModelConnection(withoutModel.workspace, "byok", "openai-local");
    expect(deleted.error).toBeNull();
    expect(getModelCandidates(deleted.workspace, "byok")).toEqual([]);
  });

  it("never needs to render a plaintext key", () => {
    expect(maskApiKey("sk-super-secret-7890")).toBe("••••••••7890");
    expect(maskApiKey("")).toBe("");
  });

  it("persists optional token limits with a model connection", () => {
    const created = upsertModelConnection(createModelWorkspaceSeed(), "byok", {
      id: "limited-openai",
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      apiKey: "sk-secret",
      maxTokens: 8192,
      dailyTokenLimit: 100_000,
      models: ["gpt-4o"]
    });

    expect(created.workspace.spaces.byok.connections[0]).toMatchObject({
      maxTokens: 8192,
      dailyTokenLimit: 100_000
    });
  });
});

describe("scoped model selections", () => {
  it("keeps conversation A, conversation B, and a draft isolated", () => {
    const workspace = createWorkspaceWithAccountByok();
    const candidates = getModelCandidates(workspace, "account");
    const withA = setScopedModelSelection(workspace, "account", "chat-a", candidates[1]!.id);
    const withB = setScopedModelSelection(withA, "account", "chat-b", candidates[2]!.id);
    const withDraft = setScopedModelSelection(withB, "account", "draft-8", candidates[0]!.id);

    expect(resolveScopedModelSelection(withDraft, "account", "chat-a").candidateId).toBe(candidates[1]!.id);
    expect(resolveScopedModelSelection(withDraft, "account", "chat-b").candidateId).toBe(candidates[2]!.id);
    expect(resolveScopedModelSelection(withDraft, "account", "draft-8").candidateId).toBe(candidates[0]!.id);
    expect(resolveScopedModelSelection(withDraft, "account", "draft-9").reason).toBe("initial");
    expect(resolveScopedModelSelection(withDraft, "account", "draft-9").candidateId).toBe(candidates[0]!.id);
  });

  it("moves only the submitted draft selection into its new chat scope", () => {
    const workspace = createWorkspaceWithAccountByok();
    const candidates = getModelCandidates(workspace, "account");
    const selected = setScopedModelSelection(
      setScopedModelSelection(workspace, "account", "chat-a", candidates[0]!.id),
      "account",
      "draft-7",
      candidates[1]!.id
    );
    const transferred = transferScopedModelSelection(selected, "draft-7", "chat-new");

    expect(transferred.selectionsByScope["draft-7"]).toBeUndefined();
    expect(transferred.selectionsByScope["chat-new"]?.candidateId).toBe(candidates[1]!.id);
    expect(transferred.selectionsByScope["chat-a"]?.candidateId).toBe(candidates[0]!.id);
  });

  it("resets to the new space first item on mode change", () => {
    const account = createWorkspaceWithAccountByok();
    const local = upsertModelConnection(account, "byok", {
      id: "local-openai",
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      apiKey: "secret",
      models: ["local-first"]
    }).workspace;
    const accountSecond = getModelCandidates(local, "account")[1]!;
    const selected = setScopedModelSelection(local, "account", "chat-a", accountSecond.id);
    const resolved = resolveScopedModelSelection(selected, "byok", "chat-a");

    expect(resolved.reason).toBe("mode_changed");
    expect(resolved.candidate?.model).toBe("local-first");
    expect(resolved.unavailable).toBe(false);
  });

  it("keeps a deleted current selection unavailable until the user switches", () => {
    const workspace = createWorkspaceWithAccountByok();
    const selectedCandidate = getModelCandidates(workspace, "account")[1]!;
    const selected = setScopedModelSelection(workspace, "account", "chat-a", selectedCandidate.id);
    const deleted = deleteModelConnection(selected, "account", selectedCandidate.connectionId!).workspace;
    const resolved = resolveScopedModelSelection(deleted, "account", "chat-a");

    expect(resolved.reason).toBe("unavailable");
    expect(resolved.candidate).toBeNull();
    expect(resolved.candidateId).toBe(selectedCandidate.id);
    expect(resolved.unavailable).toBe(true);
  });

  it("treats a failed-key connection as unavailable without deleting its card", () => {
    const workspace = createWorkspaceWithAccountByok();
    const candidate = getModelCandidates(workspace, "account")[1]!;
    const selected = setScopedModelSelection(workspace, "account", "chat-a", candidate.id);
    const invalid = setModelConnectionAvailability(
      selected,
      "account",
      candidate.connectionId!,
      false
    );

    expect(invalid.spaces.account.connections).toHaveLength(1);
    expect(resolveScopedModelSelection(invalid, "account", "chat-a")).toMatchObject({
      reason: "unavailable",
      unavailable: true,
      candidate: null
    });
  });
});

describe("model workspace persistence", () => {
  it("round-trips local storage and reports write failure", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    };
    const workspace = upsertModelConnection(createModelWorkspaceSeed(), "account", {
      id: "limited-anthropic",
      provider: "anthropic",
      endpoint: "https://api.anthropic.com",
      apiKey: "sk-secret",
      maxTokens: 4096,
      dailyTokenLimit: 80_000,
      models: ["claude-sonnet-4"]
    }).workspace;

    expect(writeModelWorkspace(storage, workspace)).toBe(true);
    expect(values.has(MODEL_WORKSPACE_STORAGE_KEY)).toBe(true);
    expect(values.get(MODEL_WORKSPACE_STORAGE_KEY)).not.toContain("sk-");
    expect(values.get(MODEL_WORKSPACE_STORAGE_KEY)).not.toContain('"apiKey"');
    expect(readModelWorkspace(storage).spaces.account.connections[0]).toMatchObject({
      models: ["claude-sonnet-4"],
      maxTokens: 4096,
      dailyTokenLimit: 80_000
    });
    expect(persistModelWorkspace({ setItem: () => { throw new Error("quota"); } }, workspace, undefined)).toBe(false);
  });
});

describe("model workspace usage adapter", () => {
  it("attributes aggregate usage only when the space has one BYOK model", () => {
    const single = createModelWorkspaceSeed(legacyConfig);
    expect(buildWorkspaceUsageRows(single, "byok", {
      inputTokens: 60,
      outputTokens: 40,
      totalTokens: 100
    })[0]).toMatchObject({
      model: "legacy-chat",
      totalTokens: 100,
      breakdownAvailable: true
    });

    const multiple = createWorkspaceWithAccountByok();
    const rows = buildWorkspaceUsageRows(multiple, "account", {
      inputTokens: 60,
      outputTokens: 40,
      totalTokens: 100
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.breakdownAvailable === false && row.totalTokens === 0)).toBe(true);
  });
});
