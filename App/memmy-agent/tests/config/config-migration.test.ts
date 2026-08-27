import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigLoadError, loadConfig, saveConfig } from "../../src/config/loader.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function configFile(value?: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-current-config-"));
  roots.push(root);
  const target = path.join(root, "config.yaml");
  if (value !== undefined) fs.writeFileSync(target, typeof value === "string" ? value : YAML.stringify(value), "utf8");
  return target;
}

function currentCatalog() {
  return {
    providers: {
      openai: {
        apiKey: "sk-test",
        futureProviderField: { keep: true },
        endpoints: {
          chat: {
            apiBase: "https://api.example.test/v1",
            protocol: "openai-chat-completions",
            futureEndpointField: { keep: true },
          },
        },
      },
    },
    modelPresets: {
      stable: {
        provider: "openai",
        endpoint: "chat",
        model: "gpt-5",
        source: "byok",
        capabilities: ["agent"],
        futurePresetField: { keep: true },
      },
    },
    modelAssignments: {
      byok: {
        agent: { candidates: ["stable"], default: "stable" },
        memorySummary: null,
        memoryEvolution: null,
        embedding: null,
        asr: null,
        imageGeneration: null,
      },
      account: {
        agent: { candidates: [], default: null },
        memorySummary: null,
        memoryEvolution: null,
        embedding: null,
        asr: null,
        imageGeneration: null,
      },
    },
  };
}

describe("runtime config migration boundary", () => {
  it("loads only the current catalog contract without changing the file", () => {
    const file = configFile({ futureSection: { keepMe: true }, ...currentCatalog() });
    const before = fs.readFileSync(file, "utf8");
    const config = loadConfig(file);
    expect(config.modelPresets.stable.model).toBe("gpt-5");
    expect(config.providers.openai.endpoints.chat.protocol).toBe("openai-chat-completions");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("rejects legacy root and tool shapes instead of migrating them during load", () => {
    for (const legacy of [
      { agent: { model: "gpt-old" } },
      { model: "gpt-old" },
      { uuid: "legacy" },
      { identity: { userId: "legacy" } },
      { tools: { my: { enable: true } } },
      { tools: { myEnabled: true } },
      { tools: { mySet: true } },
    ]) {
      expect(() => loadConfig(configFile(legacy))).toThrow(ConfigLoadError);
    }
  });

  it("rejects legacy Provider aliases and snake-case fields during load", () => {
    for (const providers of [
      { openai_compatible: { apiKey: "secret" } },
      { openai: { api_key: "secret" } },
      { openai: { api_base: "https://example.test/v1" } },
      { openai: { apiType: "responses" } },
    ]) {
      expect(() => loadConfig(configFile({ providers }))).toThrow(ConfigLoadError);
    }
  });

  it("preserves unknown root and nested catalog fields through the shared mutation writer", () => {
    const file = configFile({ futureSection: { keepMe: true }, ...currentCatalog() });
    const config = loadConfig(file);
    config.agents.defaults.botName = "updated";
    saveConfig(config, file);
    const saved = YAML.parse(fs.readFileSync(file, "utf8"));
    expect(saved.futureSection.keepMe).toBe(true);
    expect(saved.providers.openai.futureProviderField.keep).toBe(true);
    expect(saved.providers.openai.endpoints.chat.futureEndpointField.keep).toBe(true);
    expect(saved.modelPresets.stable.futurePresetField.keep).toBe(true);
    expect(saved.agents.defaults.botName).toBe("updated");
  });

  it("persists preset and endpoint deletion without dropping unknown fields on survivors", () => {
    const input: any = currentCatalog();
    input.providers.openai.endpoints.spare = {
      apiBase: "https://spare.example.test/v1",
      protocol: "openai-chat-completions",
      futureEndpointField: { keep: "spare" },
    };
    input.modelPresets.spare = {
      provider: "openai",
      endpoint: "spare",
      model: "gpt-spare",
      source: "byok",
      capabilities: ["agent"],
      futurePresetField: { keep: "spare" },
    };
    const file = configFile(input);
    const config = loadConfig(file);
    config.modelAssignments.byok.agent.candidates = ["spare"];
    config.modelAssignments.byok.agent.default = "spare";
    delete config.modelPresets.stable;
    delete config.providers.openai.endpoints.chat;

    saveConfig(config, file);

    const saved = YAML.parse(fs.readFileSync(file, "utf8"));
    expect(saved.modelPresets.stable).toBeUndefined();
    expect(saved.providers.openai.endpoints.chat).toBeUndefined();
    expect(saved.providers.openai.futureProviderField.keep).toBe(true);
    expect(saved.providers.openai.endpoints.spare.futureEndpointField.keep).toBe("spare");
    expect(saved.modelPresets.spare.futurePresetField.keep).toBe("spare");
  });

  it("keeps account and BYOK assignments byte-independent on an unrelated save", () => {
    const file = configFile(currentCatalog());
    const before = YAML.parse(fs.readFileSync(file, "utf8")).modelAssignments;
    const config = loadConfig(file);
    config.agents.defaults.botIcon = "test";
    saveConfig(config, file);
    const after = YAML.parse(fs.readFileSync(file, "utf8")).modelAssignments;
    expect(after.byok).toEqual(before.byok);
    expect(after.account).toEqual(before.account);
  });

  it("fails loudly for invalid YAML and schema violations, but defaults a missing file", () => {
    expect(() => loadConfig(configFile("providers: ["))).toThrow(ConfigLoadError);
    expect(() => loadConfig(configFile({ providers: { openai: { endpoints: { chat: { apiBase: "x", protocol: "bad" } } } } }))).toThrow(ConfigLoadError);
    expect(loadConfig(configFile()).modelPresets).toEqual({});
  });
});
