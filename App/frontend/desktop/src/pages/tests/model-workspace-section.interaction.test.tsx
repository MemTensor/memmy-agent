// @vitest-environment happy-dom

import type { ModelConfigView } from "@memmy/local-api-contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../../api/config-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ModelWorkspaceSection } from "../model-workspace-section.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ModelWorkspaceSection BYOK connection deletion", () => {
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

  it("disables deletion when only one BYOK connection remains", () => {
    renderWorkspace(createSeedConfig(1));

    const deleteButton = getDeleteButtons()[0]!;
    expect(deleteButton.disabled).toBe(true);

    act(() => deleteButton.click());

    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps deletion available when another BYOK connection remains", () => {
    renderWorkspace(createSeedConfig(2));

    const deleteButtons = getDeleteButtons();
    expect(deleteButtons).toHaveLength(2);
    expect(deleteButtons.every((button) => !button.disabled)).toBe(true);

    act(() => deleteButtons[0]!.click());

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("删除配置？");
  });

  it("shows an actionable save error above the model assignment title", async () => {
    const seedConfig = createSeedConfig(1);
    const configClient = {
      getModelConfig: vi.fn(async () => {
        throw Object.assign(new Error("internal busy detail"), { code: "config_write_busy" });
      }),
      saveModelCatalog: vi.fn(async () => seedConfig),
      testModelConfig: vi.fn(async () => ({
        ok: true,
        message: "ok",
        checkedAt: "2026-08-13T00:00:00.000Z"
      }))
    };

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <ModelWorkspaceSection mode="byok" seedConfig={seedConfig} configClient={configClient} />
        </I18nProvider>
      );
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(container.querySelector("[role=alert]")).not.toBeNull());

    const alert = container.querySelector<HTMLElement>("[role=alert]")!;
    expect(alert.textContent).toContain("模型配置正在被其他操作占用，请稍后重试。");
    expect(alert.textContent).not.toContain("internal busy detail");
    const assignmentTitle = [...container.querySelectorAll("h3")]
      .find((heading) => heading.textContent === "模型分配")!;
    expect(alert.compareDocumentPosition(assignmentTitle) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(alert.className).toContain("mt-2");
    expect(alert.className).toContain("mb-5");
  });

  it("inherits the embedding connection type when adding bge-m3", async () => {
    const seedConfig = createEmbeddingSeedConfig();
    const configClient = {
      getModelConfig: vi.fn(async () => seedConfig),
      saveModelCatalog: vi.fn(async () => seedConfig),
      testModelConfig: vi.fn(async () => ({
        ok: true,
        message: "ok",
        checkedAt: "2026-08-13T00:00:00.000Z"
      }))
    };

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <ModelWorkspaceSection mode="byok" seedConfig={seedConfig} configClient={configClient} />
        </I18nProvider>
      );
      await Promise.resolve();
    });

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="编辑 openai 配置"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="添加模型"]')!.click());

    const modelInput = container.querySelector<HTMLInputElement>('input[placeholder="输入模型 ID"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(modelInput, "bge-m3");
      modelInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector(".model-capability-select")?.textContent).toContain("Embedding");

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="添加模型"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="保存"]')!.click());

    await vi.waitFor(() => expect(configClient.saveModelCatalog).toHaveBeenCalledTimes(1));
    const input = configClient.saveModelCatalog.mock.calls[0]![0];
    const bgeModel = input.providers[0]?.models.find((model) => model.model === "bge-m3");
    expect(input.providers[0]?.endpoints[0]?.protocol).toBe("openai-embeddings");
    expect(bgeModel?.capabilities).toEqual(["embedding"]);
  });

  it("shows the built-in embedding option for BYOK without changing labels", () => {
    renderWorkspace(createSeedConfig(1));

    const embeddingSelect = getAssignmentCombobox("Embedding 检索");
    expect(embeddingSelect.disabled).toBe(false);
    expect(embeddingSelect.textContent).toContain("本地 Embedding");

    act(() => embeddingSelect.click());
    expect(getOption("本地 · Xenova/all-MiniLM-L6-v2")).not.toBeNull();
  });

  it("does not offer the built-in embedding option in account mode", () => {
    const seedConfig = createEmbeddingSeedConfig();
    const presetId = seedConfig.catalog.modelAssignments.byok.embedding!;
    seedConfig.catalog.modelAssignments.account.embedding = presetId;

    renderWorkspace(seedConfig, "account");

    const embeddingSelect = getAssignmentCombobox("Embedding 检索");
    expect(embeddingSelect.textContent).toContain("text-embedding-3-small");
    act(() => embeddingSelect.click());
    expect(getOption("本地 · Xenova/all-MiniLM-L6-v2")).toBeNull();
  });

  it("persists the built-in BYOK embedding as a null assignment", async () => {
    const seedConfig = createEmbeddingSeedConfig();
    const presetId = seedConfig.catalog.modelAssignments.byok.embedding!;
    seedConfig.catalog.modelAssignments.account.embedding = presetId;
    const configClient = {
      getModelConfig: vi.fn(async () => seedConfig),
      saveModelCatalog: vi.fn(async () => seedConfig),
      testModelConfig: vi.fn(async () => ({
        ok: true,
        message: "ok",
        checkedAt: "2026-08-13T00:00:00.000Z"
      }))
    };

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <ModelWorkspaceSection mode="byok" seedConfig={seedConfig} configClient={configClient} />
        </I18nProvider>
      );
      await Promise.resolve();
    });

    act(() => getAssignmentCombobox("Embedding 检索").click());
    const localOption = getOption("本地 · Xenova/all-MiniLM-L6-v2");
    expect(localOption).not.toBeNull();
    act(() => localOption!.click());

    await vi.waitFor(() => expect(configClient.saveModelCatalog).toHaveBeenCalledTimes(1));
    const input = configClient.saveModelCatalog.mock.calls[0]![0];
    expect(input.modelAssignments.byok.embedding).toBeNull();
    expect(input.modelAssignments.account.embedding).toBe(presetId);
  });

  function renderWorkspace(seedConfig: ModelProviderConfig, mode: "byok" | "account" = "byok") {
    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <ModelWorkspaceSection mode={mode} seedConfig={seedConfig} />
        </I18nProvider>
      );
    });
  }

  function getAssignmentCombobox(label: string): HTMLButtonElement {
    const labelNode = [...container.querySelectorAll<HTMLElement>(".model-assignment-label")]
      .find((node) => node.textContent === label)!;
    return labelNode.closest("div.flex.items-center.justify-between")!
      .querySelector<HTMLButtonElement>('[role="combobox"]')!;
  }

  function getOption(label: string): HTMLButtonElement | null {
    return [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((option) => option.textContent?.includes(label)) ?? null;
  }

  function getDeleteButtons(): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="删除 openai 配置"]')];
  }
});

function createEmbeddingSeedConfig(): ModelProviderConfig {
  const seed = createSeedConfig(1);
  const provider = seed.catalog.providers[0]!;
  const endpoint = provider.endpoints[0]!;
  const model = provider.models[0]!;
  endpoint.protocol = "openai-embeddings";
  model.protocol = "openai-embeddings";
  model.model = "text-embedding-3-small";
  model.capabilities = ["embedding"];
  seed.catalog.modelAssignments.byok.agent = { candidates: [], default: null };
  seed.catalog.modelAssignments.byok.embedding = model.presetId;
  seed.catalog.effectiveCandidates.byok = [model];
  seed.model = model.model;
  return seed;
}

function createSeedConfig(connectionCount: 1 | 2): ModelProviderConfig {
  const endpoints = Array.from({ length: connectionCount }, (_value, index) => ({
    endpointId: `endpoint-${index + 1}`,
    apiBase: `https://api-${index + 1}.example.com/v1`,
    protocol: "openai-chat-completions" as const,
    hasApiKey: true,
    apiKeyMasked: "••••test",
    apiKey: ""
  }));
  const models = endpoints.map((endpoint, index) => ({
    presetId: `preset-${index + 1}`,
    provider: "openai" as const,
    endpointId: endpoint.endpointId,
    protocol: endpoint.protocol,
    model: `model-${index + 1}`,
    source: "byok" as const,
    capabilities: ["agent" as const],
    available: true
  }));
  const catalog: ModelConfigView = {
    configRevision: "revision-delete-guard",
    providers: [{
      provider: "openai",
      configured: true,
      hasApiKey: true,
      apiKeyMasked: "••••test",
      apiKey: "",
      endpoints,
      accountManaged: false,
      editable: true,
      models
    }],
    modelAssignments: {
      byok: {
        agent: { candidates: models.map((model) => model.presetId), default: models[0]!.presetId },
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
    effectiveCandidates: { byok: models, account: [] },
    configured: true,
    updatedAt: "2026-08-12T00:00:00.000Z"
  };

  return {
    catalog,
    provider: "openai",
    endpoint: endpoints[0]!.apiBase,
    model: models[0]!.model,
    apiKey: "",
    apiKeyMasked: "••••test",
    configured: true
  };
}
