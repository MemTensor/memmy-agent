// @vitest-environment happy-dom

import type { ModelConfigView } from "@memmy/local-api-contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../../api/config-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { createModelWorkspace } from "../../state/model-workspace.js";
import {
  MODEL_CONNECTION_TEST_STATE_STORAGE_KEY,
  readConnectionTestStates,
  writeConnectionTestState
} from "../model-workspace-connection-test-state.js";
import { ModelWorkspaceSection } from "../model-workspace-section.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ModelWorkspaceSection connection test status", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/settings#model-config");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("keeps a successful connection state after leaving and reopening model settings", async () => {
    const seedConfig = createSeedConfig({ revision: "revision-before-save", apiKeyMasked: "••••test" });
    const savedConfig = createSeedConfig({ revision: "revision-after-save", apiKeyMasked: "sk-••••test" });
    let currentConfig = seedConfig;
    const configClient = {
      getModelConfig: vi.fn(async () => currentConfig),
      saveModelCatalog: vi.fn(async () => {
        currentConfig = savedConfig;
        return savedConfig;
      }),
      testModelConfig: vi.fn(async () => ({
        ok: true,
        message: "ok",
        checkedAt: "2026-08-12T00:00:00.000Z"
      }))
    };

    await renderWorkspace(seedConfig, configClient);
    expect(container.textContent).toContain("未测试");
    expect(container.textContent).not.toContain("连接成功");
    act(() => getButtonByLabel("编辑 openai 配置").click());

    await act(async () => {
      getButtonByText("测试").click();
      await Promise.resolve();
    });
    expect(getButtonByText("连接成功")).toBeDefined();

    await act(async () => {
      getButtonByLabel("保存").click();
      await Promise.resolve();
    });
    expect(configClient.testModelConfig).toHaveBeenCalledTimes(1);
    expect(configClient.saveModelCatalog).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("连接成功");

    act(() => root.unmount());
    root = createRoot(container);
    await renderWorkspace(currentConfig, configClient);

    expect(container.textContent).toContain("连接成功");
    expect(container.textContent).not.toContain("未测试");
  });

  it("does not restore a cached result for changed connection details or malformed storage", () => {
    const original = createModelWorkspace(createSeedConfig()).spaces.byok.connections[0]!;
    writeConnectionTestState(original, "success", window.sessionStorage);
    expect(readConnectionTestStates([original], window.sessionStorage)[original.id]?.status).toBe("success");

    const changed = createModelWorkspace(createSeedConfig({ endpoint: "https://changed.example.com/v1" }))
      .spaces.byok.connections[0]!;
    expect(readConnectionTestStates([changed], window.sessionStorage)).toEqual({});

    window.sessionStorage.setItem(MODEL_CONNECTION_TEST_STATE_STORAGE_KEY, "{");
    expect(readConnectionTestStates([original], window.sessionStorage)).toEqual({});
  });

  async function renderWorkspace(
    seedConfig: ModelProviderConfig,
    configClient: ModelWorkspaceSectionProps["configClient"]
  ) {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <ModelWorkspaceSection mode="byok" seedConfig={seedConfig} configClient={configClient} />
        </I18nProvider>
      );
      await Promise.resolve();
    });
  }

  function getButtonByLabel(label: string): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!button) throw new Error(`Missing button: ${label}`);
    return button;
  }

  function getButtonByText(text: string): HTMLButtonElement {
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent?.trim() === text);
    if (!button) throw new Error(`Missing button text: ${text}`);
    return button;
  }
});

type ModelWorkspaceSectionProps = Parameters<typeof ModelWorkspaceSection>[0];

function createSeedConfig(options: {
  revision?: string;
  apiKeyMasked?: string;
  endpoint?: string;
} = {}): ModelProviderConfig {
  const apiKeyMasked = options.apiKeyMasked ?? "••••test";
  const endpoint = options.endpoint ?? "https://api.openai.com/v1";
  const model = {
    presetId: "preset-openai",
    provider: "openai" as const,
    endpointId: "endpoint-openai",
    protocol: "openai-chat-completions" as const,
    model: "gpt-4o",
    source: "byok" as const,
    capabilities: ["agent" as const],
    available: true
  };
  const catalog: ModelConfigView = {
    configRevision: options.revision ?? "revision-connection-status",
    providers: [{
      provider: "openai",
      configured: true,
      hasApiKey: true,
      apiKeyMasked,
      apiKey: "",
      endpoints: [{
        endpointId: model.endpointId,
        apiBase: endpoint,
        protocol: model.protocol,
        hasApiKey: true,
        apiKeyMasked,
        apiKey: ""
      }],
      accountManaged: false,
      editable: true,
      models: [model]
    }],
    modelAssignments: {
      byok: {
        agent: { candidates: [model.presetId], default: model.presetId },
        memorySummary: null,
        memoryEvolution: null,
        embedding: null,
        asr: null,
        imageGeneration: null
      },
      account: {
        agent: { candidates: [], default: null },
        memorySummary: null,
        memoryEvolution: null,
        embedding: null,
        asr: null,
        imageGeneration: null
      }
    },
    effectiveCandidates: { byok: [model], account: [] },
    configured: true,
    updatedAt: "2026-08-12T00:00:00.000Z"
  };

  return {
    catalog,
    provider: "openai",
    endpointId: model.endpointId,
    protocol: model.protocol,
    endpoint,
    model: model.model,
    apiKey: "",
    apiKeyMasked,
    configured: true
  };
}
