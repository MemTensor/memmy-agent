import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import { Config, ModelPresetConfig } from "../../../src/config/schema.js";
import { ProviderSnapshot } from "../../../src/providers/factory.js";

function provider(defaultModel: string, maxTokens = 123): any {
  return {
    model: defaultModel,
    getDefaultModel: () => defaultModel,
    generation: {
      maxTokens,
      temperature: 0.1,
      reasoningEffort: null,
    },
  };
}

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memmy-self-model-preset-"));
}

function makeLoop(presets: Record<string, ModelPresetConfig> = {}, activePreset: string | null = null): AgentLoop {
  return new AgentLoop({
    config: new Config({ fileMemory: { enabled: true } }),
    bus: new MessageBus(),
    provider: provider("base-model"),
    workspace: workspace(),
    model: "base-model",
    contextWindowTokens: 1000,
    modelPresets: presets,
    modelPreset: activePreset,
  });
}

describe("model preset runtime", () => {
  it("returns no active model preset when not set", () => {
    const loop = makeLoop();

    expect(loop.modelPreset).toBeNull();
    expect(loop.modelPreset).toBeNull();
  });

  it("updates model preset state and model-dependent helpers through the setter", () => {
    const presets = {
      fast: new ModelPresetConfig({
        model: "openai/gpt-4.1",
        provider: "openai",
        maxTokens: 4096,
        contextWindowTokens: 32_768,
        temperature: 0.5,
        reasoningEffort: "low",
      }),
    };
    const loop = makeLoop(presets);

    loop.modelPreset = "fast";

    expect(loop.modelPreset).toBe("fast");
    expect(loop.model).toBe("openai/gpt-4.1");
    expect(loop.contextWindowTokens).toBe(32_768);
    expect(loop.provider.generation.temperature).toBe(0.5);
    expect(loop.provider.generation.maxTokens).toBe(4096);
    expect(loop.provider.generation.reasoningEffort).toBe("low");
    expect(loop.subagents.model).toBe("openai/gpt-4.1");
    expect(loop.consolidator.model).toBe("openai/gpt-4.1");
    expect(loop.consolidator.contextWindowTokens).toBe(32_768);
    expect(loop.consolidator.maxCompletionTokens).toBe(4096);
    expect(loop.dream?.model).toBe("openai/gpt-4.1");
  });

  it("publishes runtime model updates when setModelPreset is called", () => {
    const published: Array<[string | null, string | null | undefined]> = [];
    const loop = new AgentLoop({
      config: new Config({ fileMemory: { enabled: true } }),
      bus: new MessageBus(),
      provider: provider("base-model"),
      workspace: workspace(),
      model: "base-model",
      contextWindowTokens: 1000,
      modelPresets: { fast: new ModelPresetConfig({ model: "openai/gpt-4.1" }) },
      runtimeModelPublisher: (model, preset) => published.push([model, preset]),
    });

    loop.setModelPreset("fast");

    expect(published).toEqual([["openai/gpt-4.1", "fast"]]);
  });

  it("replaces provider instances from preset snapshots", () => {
    const oldProvider = provider("base-model");
    const newProvider = provider("anthropic/claude-opus-4-5", 2048);
    const preset = new ModelPresetConfig({
      model: "anthropic/claude-opus-4-5",
      provider: "anthropic",
      maxTokens: 2048,
      contextWindowTokens: 200_000,
    });
    const loop = new AgentLoop({
      config: new Config({ fileMemory: { enabled: true } }),
      bus: new MessageBus(),
      provider: oldProvider,
      workspace: workspace(),
      model: "base-model",
      contextWindowTokens: 1000,
      modelPresets: { deep: preset },
      presetSnapshotLoader: (name) =>
        new ProviderSnapshot({
          provider: newProvider,
          model: preset.model,
          contextWindowTokens: preset.contextWindowTokens,
          signature: [name, preset.model],
        }),
    });

    loop.setModelPreset("deep");

    expect(loop.provider).toBe(newProvider);
    expect(loop.runner.provider).toBe(newProvider);
    expect(loop.subagents.provider).toBe(newProvider);
    expect(loop.subagents.runner.provider).toBe(newProvider);
    expect(loop.consolidator.provider).toBe(newProvider);
    expect(loop.dream?.provider).toBe(newProvider);
    expect(loop.dream?.runner.provider).toBe(newProvider);
    expect(loop.model).toBe("anthropic/claude-opus-4-5");
    expect(loop.contextWindowTokens).toBe(200_000);
    expect(loop.consolidator.maxCompletionTokens).toBe(2048);
  });

  it("leaves old runtime state intact when preset snapshot loading fails", () => {
    const loop = new AgentLoop({
      config: new Config({ fileMemory: { enabled: true } }),
      bus: new MessageBus(),
      provider: provider("base-model", 123),
      workspace: workspace(),
      model: "base-model",
      contextWindowTokens: 1000,
      modelPresets: { fast: new ModelPresetConfig({ model: "openai/gpt-4.1", maxTokens: 4096 }) },
      presetSnapshotLoader: () => {
        throw new Error("provider unavailable");
      },
    });

    expect(() => loop.setModelPreset("fast")).toThrow(/provider unavailable/);
    expect(loop.modelPreset).toBeNull();
    expect(loop.model).toBe("base-model");
    expect(loop.subagents.model).not.toBe("openai/gpt-4.1");
    expect(loop.consolidator.model).toBe("base-model");
    expect(loop.dream?.model).toBe("base-model");
    expect(loop.contextWindowTokens).toBe(1000);
    expect(loop.consolidator.maxCompletionTokens).toBe(123);
  });

  it("keeps an active model preset during unchanged config refresh", () => {
    const baseProvider = provider("base-model", 123);
    const fastProvider = provider("openai/gpt-4.1", 4096);
    const defaultSnapshot = new ProviderSnapshot({
      provider: baseProvider,
      model: "base-model",
      contextWindowTokens: 1000,
      signature: ["base-model", "auto", "openai", "sk-old"],
    });
    const fastSnapshot = new ProviderSnapshot({
      provider: fastProvider,
      model: "openai/gpt-4.1",
      contextWindowTokens: 32_768,
      signature: ["openai/gpt-4.1", "auto", "openai", "sk-old"],
    });
    const loop = new AgentLoop({
      bus: new MessageBus(),
      provider: baseProvider,
      workspace: workspace(),
      model: "base-model",
      contextWindowTokens: 1000,
      providerSignature: defaultSnapshot.signature,
      modelPresets: { fast: new ModelPresetConfig({ model: "openai/gpt-4.1" }) },
      providerSnapshotLoader: () => defaultSnapshot,
      presetSnapshotLoader: () => fastSnapshot,
    });

    loop.setModelPreset("fast");
    loop.refreshProviderSnapshot();

    expect(loop.modelPreset).toBe("fast");
    expect(loop.provider).toBe(fastProvider);
    expect(loop.model).toBe("openai/gpt-4.1");
  });

  it("clears an active model preset when the config-selected model changes", () => {
    const baseProvider = provider("base-model", 123);
    const fastProvider = provider("openai/gpt-4.1", 4096);
    const webuiProvider = provider("anthropic/claude-opus-4-5", 2048);
    const webuiSnapshot = new ProviderSnapshot({
      provider: webuiProvider,
      model: "anthropic/claude-opus-4-5",
      contextWindowTokens: 200_000,
      signature: ["anthropic/claude-opus-4-5", "anthropic", "anthropic", "sk-old"],
    });
    const fastSnapshot = new ProviderSnapshot({
      provider: fastProvider,
      model: "openai/gpt-4.1",
      contextWindowTokens: 32_768,
      signature: ["openai/gpt-4.1", "auto", "openai", "sk-old"],
    });
    const loop = new AgentLoop({
      bus: new MessageBus(),
      provider: baseProvider,
      workspace: workspace(),
      model: "base-model",
      contextWindowTokens: 1000,
      providerSignature: ["base-model", "auto", "openai", "sk-old"],
      modelPresets: { fast: new ModelPresetConfig({ model: "openai/gpt-4.1" }) },
      providerSnapshotLoader: () => webuiSnapshot,
      presetSnapshotLoader: () => fastSnapshot,
    });

    loop.setModelPreset("fast");
    loop.refreshProviderSnapshot();

    expect(loop.modelPreset).toBeNull();
    expect(loop.provider).toBe(webuiProvider);
    expect(loop.model).toBe("anthropic/claude-opus-4-5");
    expect(loop.contextWindowTokens).toBe(200_000);
  });

  it("raises for unknown model presets", () => {
    const loop = makeLoop();

    expect(() => {
      loop.modelPreset = "missing";
    }).toThrow(/modelPreset 'missing' not found/);
  });

  it("raises for empty model preset names", () => {
    const loop = makeLoop();

    expect(() => {
      loop.modelPreset = "";
    }).toThrow(/modelPreset must be a non-empty string/);
  });

  it("injects the default preset when building from config", () => {
    const config = Config.fromObject({
      agents: { defaults: { model: "openai/gpt-4.1", workspace: workspace() } },
    });
    const loop = AgentLoop.fromConfig(config, undefined as any, { provider: provider("openai/gpt-4.1") });

    expect(loop.model).toBe("openai/gpt-4.1");
    expect(loop.modelPreset).toBeNull();
    expect(Object.keys(loop.modelPresets)).toContain("default");
    expect(loop.modelPresets.default.model).toBe("openai/gpt-4.1");
  });

  it("uses a static preset loader from config without enabling provider hot reload", () => {
    const config = Config.fromObject({
      agents: { defaults: { model: "openai/gpt-4.1", workspace: workspace() } },
      modelPresets: { fast: { model: "openai/gpt-4.1-mini" } },
    });
    const loop = AgentLoop.fromConfig(config, undefined as any, { provider: provider("openai/gpt-4.1") });

    expect(loop.providerSnapshotLoader).toBeNull();
    expect(loop.presetSnapshotLoader).not.toBeNull();
  });
});
