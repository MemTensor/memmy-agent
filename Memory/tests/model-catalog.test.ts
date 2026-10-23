import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { loadMemmyConfig } from "../src/config/index.js";
import { syncMemoryModelCatalog } from "../src/config/model-catalog.js";

function platformFixture(): Record<string, any> {
  const connection = { provider: "openai_compatible", sourceProvider: "memmy_account", endpoint: "https://platform.example.test/v1", model: "memory_evolution", apiKey: "fixture-token" };
  return {
    app: { userMode: "account", userId: "owner" },
    providers: { memmy_account: { ownerAccountId: "owner", apiKey: connection.apiKey, endpoints: { platform: { apiBase: connection.endpoint, protocol: "memmy-account" } } } },
    modelPresets: { platform: { provider: "memmy_account", endpoint: "platform", model: connection.model, source: "account", ownerAccountId: "owner", capabilities: ["memory_evolution"] } },
    modelAssignments: { account: { ownerAccountId: "owner", memoryEvolution: "platform" } },
    memmyMemory: { roleRouting: { evolution: "fixed" }, evolution: connection },
  };
}

describe("Memory model catalog inheritance", () => {
  it.each(["sourceProvider", "provider"])("does not copy a platform connection into BYOK when %s identifies its source", (field) => {
    const root = platformFixture();
    const connection = root.memmyMemory.evolution;
    delete connection.sourceProvider;
    connection[field] = "memmy_account";
    const original = structuredClone(root);
    syncMemoryModelCatalog(root, root.memmyMemory, { evolution: connection });
    expect(root.providers).toEqual(original.providers);
    expect(root.modelPresets).toEqual(original.modelPresets);
    expect(root.modelAssignments).toEqual(original.modelAssignments);
  });

  it.each([
    { endpoint: "https://personal.example.test/v1" },
    { model: "personal-model" },
    { apiKey: "personal-key" },
    { provider: "anthropic", endpoint: "https://personal.example.test/v1", model: "personal-model" },
  ])("registers an edited platform connection and loads the new assignment: %j", patch => {
    const root = platformFixture();
    Object.assign(root.memmyMemory.evolution, patch);
    syncMemoryModelCatalog(root, root.memmyMemory, { evolution: patch });
    const id = root.modelAssignments.account.memoryEvolution;
    expect(id).not.toBe("platform");
    expect(root.modelPresets[id].source).toBe("byok");
    expect(root.memmyMemory.evolution.sourceProvider).not.toBe("memmy_account");
    const folder = mkdtempSync(join(tmpdir(), "memmy-700-catalog-"));
    try {
      const file = join(folder, "config.yaml"); writeFileSync(file, YAML.stringify(root));
      const effective = loadMemmyConfig(file).config.evolution;
      expect(effective.endpoint).toBe(root.memmyMemory.evolution.endpoint);
      expect(effective.model).toBe(root.memmyMemory.evolution.model);
      expect(effective.apiKey).toBe(root.memmyMemory.evolution.apiKey);
      expect(effective.sourceProvider).toBe(patch.provider === "anthropic" ? "anthropic" : "openai");
    } finally { rmSync(folder, { recursive: true, force: true }); }
    const once = JSON.stringify(root);
    syncMemoryModelCatalog(root, root.memmyMemory, { evolution: patch });
    expect(JSON.stringify(root)).toBe(once);
  });

  it.each([{}, { temperature: 0.2 }, { maxTokens: 4000 }, { enableThinking: true }, { extraBody: { top_p: 0.8 } }, { extraHeaders: { "X-Request-Option": "value" } }])(
    "does not duplicate an unchanged platform connection when adjusting request options: %j", patch => {
      const root = platformFixture();
      Object.assign(root.memmyMemory.evolution, patch);
      const presets = structuredClone(root.modelPresets), providers = structuredClone(root.providers);
      syncMemoryModelCatalog(root, root.memmyMemory, { evolution: patch });
      expect(root.modelPresets).toEqual(presets);
      expect(root.providers).toEqual(providers);
      expect(root.modelAssignments.account.memoryEvolution).toBe("platform");
    }
  );

  it.each(["unassigned", "stale-copy", "personal"])("recognizes the platform catalog independently of the selected model (%s)", selection => {
    const root = platformFixture();
    const assignment = root.modelAssignments.account;
    if (selection === "unassigned") delete assignment.memoryEvolution;
    else {
      root.providers.openai = { endpoints: { custom: { apiBase: selection === "personal" ? "https://personal.example.test/v1" : root.memmyMemory.evolution.endpoint, protocol: "openai-chat-completions", apiKey: "different-key" } } };
      root.modelPresets.custom = { provider: "openai", endpoint: "custom", model: "memory_evolution", source: "byok", capabilities: ["memory_evolution"] };
      assignment.memoryEvolution = "custom";
    }
    const original = structuredClone(root);
    syncMemoryModelCatalog(root, root.memmyMemory, { evolution: root.memmyMemory.evolution });
    expect(root.providers).toEqual(original.providers);
    expect(root.modelPresets).toEqual(original.modelPresets);
    expect(root.modelAssignments).toEqual(original.modelAssignments);
  });

  it.each(["preset", "provider"])("does not trust another account's platform %s", changed => {
    const root = platformFixture();
    if (changed === "preset") root.modelPresets.platform.ownerAccountId = "another-owner";
    else root.providers.memmy_account.ownerAccountId = "another-owner";
    syncMemoryModelCatalog(root, root.memmyMemory, { evolution: root.memmyMemory.evolution });
    expect(root.modelPresets[root.modelAssignments.account.memoryEvolution].source).toBe("byok");
  });

  it("forces account summaries to use a fixed route", () => {
    const root: Record<string, unknown> = {
      app: { userMode: "account" },
      modelAssignments: {
        account: {
          agent: { candidates: ["account-agent"], default: "account-agent" },
          memorySummary: "account-summary",
          memoryEvolution: "account-evolution"
        }
      }
    };
    const memory = {
      roleRouting: { summary: "follow", evolution: "follow" }
    };

    syncMemoryModelCatalog(root, memory, { roleRouting: memory.roleRouting });

    expect(memory.roleRouting).toEqual({ summary: "fixed", evolution: "fixed" });
    expect((root.modelAssignments as any).account.memorySummary).toBe("account-summary");
    expect((root.modelAssignments as any).account.memoryEvolution).toBe("account-evolution");
  });

  it("syncs follow routing as summary -> evolution -> Agent Chat", () => {
    const root: Record<string, unknown> = {
      app: { userMode: "byok" },
      modelAssignments: {
        byok: {
          agent: { candidates: ["agent-chat"], default: "agent-chat" },
          memorySummary: "old-summary",
          memoryEvolution: "old-evolution"
        }
      }
    };
    const memory = {
      roleRouting: { summary: "follow", evolution: "follow" }
    };

    syncMemoryModelCatalog(root, memory, { roleRouting: memory.roleRouting });

    expect((root.modelAssignments as any).byok).toMatchObject({
      memorySummary: "agent-chat",
      memoryEvolution: "agent-chat"
    });
  });

  it("makes a following summary reuse a fixed evolution model", () => {
    const root: Record<string, unknown> = {
      app: { userMode: "byok" },
      modelAssignments: {
        byok: {
          agent: { candidates: ["agent-chat"], default: "agent-chat" }
        }
      }
    };
    const memory = {
      roleRouting: { summary: "follow", evolution: "fixed" },
      evolution: {
        provider: "openai_compatible",
        endpoint: "https://evolution.example/v1",
        model: "strong-evolution",
        apiKey: "sk-evolution"
      }
    };

    syncMemoryModelCatalog(root, memory, {
      roleRouting: memory.roleRouting,
      evolution: memory.evolution
    });

    const assignment = (root.modelAssignments as any).byok;
    expect(assignment.memoryEvolution).toEqual(expect.any(String));
    expect(assignment.memorySummary).toBe(assignment.memoryEvolution);
  });

  it("refreshes a following summary when only evolution changes", () => {
    const root: Record<string, unknown> = {
      app: { userMode: "byok" },
      modelAssignments: {
        byok: {
          agent: { candidates: ["agent-chat"], default: "agent-chat" },
          memorySummary: "old-evolution",
          memoryEvolution: "old-evolution"
        }
      }
    };
    const memory = {
      roleRouting: { summary: "follow", evolution: "fixed" },
      evolution: {
        provider: "openai_compatible",
        endpoint: "https://new-evolution.example/v1",
        model: "new-evolution",
        apiKey: "synthetic-key"
      }
    };

    syncMemoryModelCatalog(root, memory, { evolution: memory.evolution });

    const assignment = (root.modelAssignments as any).byok;
    expect(assignment.memoryEvolution).toEqual(expect.any(String));
    expect(assignment.memoryEvolution).not.toBe("old-evolution");
    expect(assignment.memorySummary).toBe(assignment.memoryEvolution);
  });

  it("never makes evolution inherit a fixed summary model", () => {
    const root: Record<string, unknown> = {
      app: { userMode: "byok" },
      modelAssignments: {
        byok: {
          agent: { candidates: ["agent-chat"], default: "agent-chat" }
        }
      }
    };
    const memory = {
      roleRouting: { summary: "fixed", evolution: "follow" },
      summary: {
        provider: "openai_compatible",
        endpoint: "https://summary.example/v1",
        model: "fast-summary",
        apiKey: "sk-summary"
      }
    };

    syncMemoryModelCatalog(root, memory, {
      roleRouting: memory.roleRouting,
      summary: memory.summary
    });

    const assignment = (root.modelAssignments as any).byok;
    expect(assignment.memoryEvolution).toBe("agent-chat");
    expect(assignment.memorySummary).not.toBe("agent-chat");
    expect(assignment.memorySummary).not.toBe(assignment.memoryEvolution);
  });
});
