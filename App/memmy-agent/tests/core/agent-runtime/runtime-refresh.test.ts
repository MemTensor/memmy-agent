import { describe, expect, it } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { Config } from "../../../src/config/schema.js";
import { LLMResponse } from "../../../src/providers/base.js";

function provider(defaultModel: string, maxTokens = 123): any {
  return {
    generation: { maxTokens },
    getDefaultModel: () => defaultModel,
  };
}

describe("runtime refresh", () => {
  it("refreshes provider snapshots across model-dependent runtime helpers", () => {
    const oldProvider = provider("old-model");
    const newProvider = provider("new-model", 456);
    const loop = new AgentLoop({
      config: new Config({ fileMemory: { enabled: true } }),
      provider: oldProvider,
      workspace: "/tmp/memmy-runtime-refresh-provider",
      model: "old-model",
      contextWindowTokens: 1000,
      providerSnapshotLoader: () => ({
        provider: newProvider,
        model: "new-model",
        contextWindowTokens: 2000,
        signature: ["new-model"],
      }),
    });

    loop.refreshProviderSnapshot();

    expect(loop.provider).toBe(newProvider);
    expect(loop.model).toBe("new-model");
    expect(loop.contextWindowTokens).toBe(2000);
    expect(loop.runner.provider).toBe(newProvider);
    expect(loop.subagents.provider).toBe(newProvider);
    expect(loop.subagents.model).toBe("new-model");
    expect(loop.subagents.contextWindowTokens).toBe(2000);
    expect(loop.subagents.runner.provider).toBe(newProvider);
    expect(loop.consolidator.provider).toBe(newProvider);
    expect(loop.consolidator.model).toBe("new-model");
    expect(loop.consolidator.contextWindowTokens).toBe(2000);
    expect(loop.consolidator.maxCompletionTokens).toBe(456);
    expect(loop.dream?.provider).toBe(newProvider);
    expect(loop.dream?.model).toBe("new-model");
    expect(loop.dream?.runner.provider).toBe(newProvider);
  });

  it("refreshes non-Dream helpers without creating Dream when file memory is off", () => {
    const oldProvider = provider("old-model");
    const newProvider = provider("new-model", 456);
    const loop = new AgentLoop({
      provider: oldProvider,
      workspace: "/tmp/memmy-runtime-refresh-file-memory-off",
      model: "old-model",
      providerSnapshotLoader: () => ({
        provider: newProvider,
        model: "new-model",
        contextWindowTokens: 2000,
        signature: ["new-model"],
      }),
    });

    loop.refreshProviderSnapshot();

    expect(loop.fileMemoryEnabled).toBe(false);
    expect(loop.dream).toBeNull();
    expect(loop.runner.provider).toBe(newProvider);
    expect(loop.subagents.provider).toBe(newProvider);
    expect(loop.consolidator.provider).toBe(newProvider);
  });

  it("refreshes provider snapshots before returning llm runtime", () => {
    const oldProvider = provider("old-model");
    const newProvider = provider("new-model", 456);
    const loop = new AgentLoop({
      provider: oldProvider,
      workspace: "/tmp/memmy-runtime-refresh-llm-runtime",
      model: "old-model",
      contextWindowTokens: 1000,
      providerSnapshotLoader: () => ({
        provider: newProvider,
        model: "new-model",
        contextWindowTokens: 2000,
        signature: ["new-model"],
      }),
    });

    const runtime = loop.llmRuntime();

    expect(runtime.provider).toBe(newProvider);
    expect(runtime.model).toBe("new-model");
    expect(loop.provider).toBe(newProvider);
    expect(loop.runner.provider).toBe(newProvider);
  });

  it("refreshes provider snapshots before ordinary message processing", async () => {
    const oldProvider = {
      generation: { maxTokens: 123 },
      chat: () => {
        throw new Error("old provider should not be called");
      },
      getDefaultModel: () => "old-model",
    };
    const newProvider = {
      generation: { maxTokens: 456 },
      chat: async () => new LLMResponse({ content: "new provider answer", toolCalls: [], usage: {} }),
      getDefaultModel: () => "new-model",
    };
    const loop = new AgentLoop({
      provider: oldProvider,
      workspace: "/tmp/memmy-runtime-refresh-process",
      model: "old-model",
      contextWindowTokens: 1000,
      providerSnapshotLoader: () => ({
        provider: newProvider,
        model: "new-model",
        contextWindowTokens: 2000,
        signature: ["new-model"],
      }),
    });

    const response = await loop.processDirect("hello", { sessionKey: "cli:refresh" });

    expect(response?.content).toBe("new provider answer");
    expect(loop.provider).toBe(newProvider);
    expect(loop.model).toBe("new-model");
    expect(loop.contextWindowTokens).toBe(2000);
  });

  it("updates runtime model fields when switching presets", () => {
    const provider = { generation: { maxTokens: 1, temperature: 0 }, getDefaultModel: () => "base" };
    const loop = new AgentLoop({
      provider,
      workspace: "/tmp/memmy-runtime-refresh",
      modelPresets: { fast: { model: "openai/gpt-4.1", maxTokens: 222, temperature: 0.2, contextWindowTokens: 333 } },
    });

    loop.setModelPreset("fast");

    expect(loop.model).toBe("openai/gpt-4.1");
    expect(provider.generation.maxTokens).toBe(222);
    expect(loop.contextWindowTokens).toBe(333);
    expect(loop.subagents.contextWindowTokens).toBe(333);
  });
});
