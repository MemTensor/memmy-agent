import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  committedSelectionFromMetadata,
  readModelCatalog,
  resolveModelSelection,
} from "../../src/providers/model-catalog.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("model catalog", () => {
  it("restores the complete committed model identity from session metadata", () => {
    expect(committedSelectionFromMetadata({
      modelSelection: {
        presetId: "byok-openai",
        provider: "openai",
        endpointId: "chat",
        protocol: "openai-responses",
        model: "gpt-5.4",
        source: "byok",
        ownerAccountId: null,
      },
    })).toEqual({
      presetId: "byok-openai",
      provider: "openai",
      endpointId: "chat",
      protocol: "openai-responses",
      model: "gpt-5.4",
      source: "byok",
      ownerAccountId: null,
    });
  });

  it("lists only the active assignment and resolves its default with complete context", () => {
    const configPath = writeConfig(catalogConfig());

    expect(readModelCatalog(configPath)).toMatchObject({
      defaultPreset: "work-gpt",
      items: [
        {
          preset: "work-gpt",
          provider: "openai",
          endpointId: "responses",
          protocol: "openai-responses",
          model: "gpt-5",
          source: "byok",
          ownerAccountId: null,
          capabilities: ["agent"],
          isDefault: true,
          available: true,
        },
        {
          preset: "work-claude",
          provider: "anthropic",
          endpointId: "messages",
          protocol: "anthropic-messages",
          model: "claude-sonnet",
          source: "byok",
          ownerAccountId: null,
          capabilities: ["agent"],
          isDefault: false,
          available: true,
        },
      ],
    });

    const selected = resolveModelSelection({ configPath, mode: "byok", capability: "agent" });
    expect(selected).toMatchObject({
      preset: "work-gpt",
      presetId: "work-gpt",
      provider: "openai",
      endpointId: "responses",
      protocol: "openai-responses",
      model: "gpt-5",
      capability: "agent",
      source: "byok",
      ownerAccountId: null,
    });
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.snapshot)).toBe(true);
    expect((selected?.snapshot.provider as any).apiBase).toBe("https://responses.example/v1");
    expect((selected?.snapshot.provider as any).extraHeaders).toEqual({
      "x-provider": "default",
      "x-shared": "endpoint",
      "x-endpoint": "exact",
    });
    expect((selected?.snapshot.provider as any).extraBody).toEqual({
      providerFlag: true,
      shared: "endpoint",
      endpointFlag: true,
    });
  });

  it("does not fall back when an explicit requested preset is missing", () => {
    const configPath = writeConfig(catalogConfig());

    expect(resolveModelSelection({
      configPath,
      mode: "byok",
      capability: "agent",
      requestedPreset: "deleted-preset",
    })).toBeNull();
  });

  it("uses a committed selection only when its source and owner identity still match", () => {
    const configPath = writeConfig(catalogConfig());

    expect(resolveModelSelection({
      configPath,
      mode: "byok",
      capability: "agent",
      committedSelection: {
        presetId: "work-claude",
        source: "byok",
        ownerAccountId: null,
      },
    })).toMatchObject({ presetId: "work-claude", provider: "anthropic" });

    expect(resolveModelSelection({
      configPath,
      mode: "byok",
      capability: "agent",
      committedSelection: {
        presetId: "work-claude",
        source: "account",
        ownerAccountId: "account-a",
      },
    })).toBeNull();
  });

  it("enforces account assignment ownership while allowing assigned BYOK models", () => {
    const configPath = writeConfig(catalogConfig({ userMode: "account" }));

    expect(readModelCatalog(configPath, {
      mode: "account",
      activeAccountId: "account-a",
    }).items.map((item) => item.preset)).toEqual(["platform-agent", "work-gpt"]);
    expect(resolveModelSelection({
      configPath,
      mode: "account",
      activeAccountId: "account-a",
      capability: "agent",
    })).toMatchObject({ presetId: "platform-agent", source: "account", ownerAccountId: "account-a" });
    expect(resolveModelSelection({
      configPath,
      mode: "account",
      activeAccountId: "account-b",
      capability: "agent",
    })).toBeNull();
  });

  it("rejects a same-id account preset when the committed owner changed", () => {
    const data = catalogConfig({ userMode: "account" });
    data.app.userId = "account-b";
    data.providers.memmy_account.ownerAccountId = "account-b";
    data.modelPresets["platform-agent"].ownerAccountId = "account-b";
    data.modelAssignments.account.ownerAccountId = "account-b";
    const configPath = writeConfig(data);

    expect(resolveModelSelection({
      configPath,
      mode: "account",
      activeAccountId: "account-b",
      capability: "agent",
      committedSelection: {
        presetId: "platform-agent",
        source: "account",
        ownerAccountId: "account-a",
      },
    })).toBeNull();
    expect(resolveModelSelection({
      configPath,
      mode: "account",
      activeAccountId: "account-b",
      capability: "agent",
      sessionPreset: "platform-agent",
    })).toBeNull();
  });

  it("keeps catalog eligibility and selection stable when credentials are missing", () => {
    const data = catalogConfig();
    delete data.providers.openai.apiKey;
    const configPath = writeConfig(data);

    expect(readModelCatalog(configPath).items[0]).toMatchObject({
      preset: "work-gpt",
      available: true,
    });
    expect(resolveModelSelection({ configPath, mode: "byok", capability: "agent" }))
      .toMatchObject({ presetId: "work-gpt" });
  });

  it("resolves a single-capability assignment without consulting Agent defaults", () => {
    const configPath = writeConfig(catalogConfig());

    expect(resolveModelSelection({
      configPath,
      mode: "byok",
      capability: "image_generation",
    })).toMatchObject({
      presetId: "image-model",
      endpointId: "images",
      protocol: "openai-images",
      capability: "image_generation",
    });
  });
});

function catalogConfig({ userMode = "byok" }: { userMode?: "account" | "byok" } = {}): any {
  return {
    app: { userMode, userId: "account-a" },
    providers: {
      openai: {
        apiKey: "sk-openai",
        extraHeaders: { "x-provider": "default", "x-shared": "provider" },
        extraBody: { providerFlag: true, shared: "provider" },
        endpoints: {
          responses: {
            apiBase: "https://responses.example/v1",
            protocol: "openai-responses",
            extraHeaders: { "x-shared": "endpoint", "x-endpoint": "exact" },
            extraBody: { shared: "endpoint", endpointFlag: true },
          },
          images: { apiBase: "https://images.example/v1", protocol: "openai-images" },
        },
      },
      anthropic: {
        apiKey: "sk-anthropic",
        endpoints: {
          messages: { apiBase: "https://anthropic.example", protocol: "anthropic-messages" },
        },
      },
      memmy_account: {
        apiKey: "cloud-token",
        ownerAccountId: "account-a",
        endpoints: {
          gateway: { apiBase: "https://cloud.example/api/agentExternal/v1", protocol: "memmy-account" },
        },
      },
    },
    modelPresets: {
      "work-gpt": {
        provider: "openai",
        endpoint: "responses",
        model: "gpt-5",
        source: "byok",
        capabilities: ["agent"],
      },
      "work-claude": {
        provider: "anthropic",
        endpoint: "messages",
        model: "claude-sonnet",
        source: "byok",
        capabilities: ["agent"],
      },
      "image-model": {
        provider: "openai",
        endpoint: "images",
        model: "gpt-image-1",
        source: "byok",
        capabilities: ["image_generation"],
      },
      "platform-agent": {
        provider: "memmy_account",
        endpoint: "gateway",
        model: "agent_chat",
        source: "account",
        ownerAccountId: "account-a",
        capabilities: ["agent"],
      },
    },
    modelAssignments: {
      byok: {
        agent: { candidates: ["work-gpt", "work-claude"], default: "work-gpt" },
        imageGeneration: "image-model",
      },
      account: {
        ownerAccountId: "account-a",
        agent: { candidates: ["platform-agent", "work-gpt"], default: "platform-agent" },
      },
    },
    agents: { defaults: { modelPreset: "work-gpt" } },
  };
}

function writeConfig(data: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-model-catalog-"));
  roots.push(root);
  const configPath = path.join(root, "config.yaml");
  fs.writeFileSync(configPath, YAML.stringify(data), "utf8");
  return configPath;
}
