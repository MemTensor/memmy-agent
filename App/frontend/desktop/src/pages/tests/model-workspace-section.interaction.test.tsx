// @vitest-environment happy-dom

import {
  BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID,
  type ModelConfigView
} from "@memmy/local-api-contracts";
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

  it("shows the saved API Key as a masked hint when a connection is reopened", () => {
    renderWorkspace(createSeedConfig(1));

    const editButton = container.querySelector<HTMLButtonElement>('button[aria-label="编辑 openai 配置"]')!;
    act(() => editButton.click());
    const firstInput = container.querySelector<HTMLInputElement>('[role="dialog"] input[type="password"]')!;
    expect(firstInput.placeholder).toBe("••••test");
    expect(firstInput.value).toBe("");

    act(() => container.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="保存"]')!.click());
    act(() => editButton.click());
    const reopenedInput = container.querySelector<HTMLInputElement>('[role="dialog"] input[type="password"]')!;
    expect(reopenedInput.placeholder).toBe("••••test");
    expect(reopenedInput.value).toBe("");
  });

  it("edits Custom thinking and image declarations for each model independently", () => {
    renderWorkspace(createCustomSeedConfig());

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="编辑 custom 配置"]')!.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelector(".custom-thinking-config")).toBeNull();
    const modelRows = dialog.querySelectorAll(".provider-model-list__row");
    expect(modelRows).toHaveLength(2);
    expect(modelRows[0]?.textContent).toContain("model-a");
    expect(modelRows[1]?.textContent).toContain("model-b");
    expect(modelRows[0]?.textContent).not.toContain("思考");
    expect(modelRows[1]?.textContent).not.toContain("思考");

    act(() => dialog.querySelector<HTMLButtonElement>('button[aria-label="编辑模型 model-a"]')!.click());
    expect(dialog.querySelectorAll<HTMLInputElement>('.custom-thinking-config__checkbox')[0]?.checked).toBe(true);
    expect(dialog.querySelectorAll<HTMLInputElement>('.custom-thinking-config__checkbox')[1]?.checked).toBe(true);
    expect(dialog.querySelectorAll<HTMLInputElement>('.custom-thinking-config__checkbox')[2]?.checked).toBe(true);
    expect(dialog.querySelectorAll<HTMLInputElement>('.custom-thinking-config__checkbox')[3]?.checked).toBe(true);
    expect(dialog.querySelectorAll(".custom-thinking-level-option")).toHaveLength(5);
    act(() => dialog.querySelectorAll<HTMLInputElement>('.custom-thinking-config__checkbox')[2]!.click());
    expect(dialog.querySelectorAll('.custom-thinking-config__checkbox')).toHaveLength(3);
    expect(dialog.textContent).not.toContain("默认开启思考");
    act(() => dialog.querySelectorAll<HTMLInputElement>('.custom-thinking-config__checkbox')[2]!.click());
    expect(dialog.querySelectorAll('.custom-thinking-config__checkbox')).toHaveLength(4);
    act(() => dialog.querySelector<HTMLButtonElement>(".model-editor-actions button")!.click());

    act(() => dialog.querySelector<HTMLButtonElement>('button[aria-label="编辑模型 model-b"]')!.click());
    expect(dialog.querySelectorAll<HTMLInputElement>('.custom-thinking-config__checkbox')[0]?.checked).toBe(false);
    expect(dialog.querySelectorAll<HTMLInputElement>('.custom-thinking-config__checkbox')[1]?.checked).toBe(false);
    expect(dialog.querySelectorAll('.custom-thinking-config__checkbox')).toHaveLength(2);
    expect(dialog.querySelector(".custom-thinking-level-options")).toBeNull();
    act(() => dialog.querySelectorAll<HTMLInputElement>('.custom-thinking-config__checkbox')[1]!.click());
    expect(dialog.querySelectorAll<HTMLInputElement>('.custom-thinking-config__checkbox')[2]?.checked).toBe(false);
    expect(dialog.textContent).not.toContain("默认开启思考");
    act(() => dialog.querySelectorAll<HTMLInputElement>('.custom-thinking-config__checkbox')[0]!.click());
    act(() => dialog.querySelector<HTMLButtonElement>('button[aria-label="保存模型"]')!.click());

    act(() => dialog.querySelector<HTMLButtonElement>('button[aria-label="保存"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="编辑 custom 配置"]')!.click());
    const reopened = container.querySelector<HTMLElement>('[role="dialog"]')!;
    act(() => reopened.querySelector<HTMLButtonElement>('button[aria-label="编辑模型 model-a"]')!.click());
    expect(reopened.querySelectorAll<HTMLInputElement>('.custom-thinking-config__checkbox')[0]?.checked).toBe(true);
    expect(reopened.querySelectorAll<HTMLInputElement>('.custom-thinking-config__checkbox')[2]?.checked).toBe(true);
    act(() => reopened.querySelector<HTMLButtonElement>(".model-editor-actions button")!.click());
    act(() => reopened.querySelector<HTMLButtonElement>('button[aria-label="编辑模型 model-b"]')!.click());
    expect(reopened.querySelectorAll<HTMLInputElement>('.custom-thinking-config__checkbox')[0]?.checked).toBe(true);
    expect(reopened.querySelectorAll<HTMLInputElement>('.custom-thinking-config__checkbox')[1]?.checked).toBe(true);
    expect(reopened.querySelectorAll<HTMLInputElement>('.custom-thinking-config__checkbox')[2]?.checked).toBe(false);
    expect(reopened.textContent).not.toContain("默认开启思考");
  });

  it("hides thinking choices when the model's thinking mode is unchecked", () => {
    renderWorkspace(createCustomSeedConfig());

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="编辑 custom 配置"]')!.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    act(() => dialog.querySelector<HTMLButtonElement>('button[aria-label="编辑模型 model-a"]')!.click());
    const thinkingToggle = dialog.querySelectorAll<HTMLInputElement>('.custom-thinking-config__checkbox')[1]!;
    expect(thinkingToggle.checked).toBe(true);

    act(() => thinkingToggle.click());
    expect(dialog.querySelectorAll('.custom-thinking-config__checkbox')).toHaveLength(2);
    expect(dialog.querySelector(".custom-thinking-level-options")).toBeNull();
    expect(dialog.textContent).not.toContain("新会话默认强度");
    act(() => dialog.querySelector<HTMLButtonElement>('button[aria-label="保存模型"]')!.click());
    act(() => dialog.querySelector<HTMLButtonElement>('button[aria-label="保存"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="编辑 custom 配置"]')!.click());
    const reopened = container.querySelector<HTMLElement>('[role="dialog"]')!;
    act(() => reopened.querySelector<HTMLButtonElement>('button[aria-label="编辑模型 model-a"]')!.click());
    expect(reopened.querySelectorAll<HTMLInputElement>('.custom-thinking-config__checkbox')[1]?.checked).toBe(false);
    expect(reopened.querySelector(".custom-thinking-level-options")).toBeNull();
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

  it("tests and saves an existing independent no-auth connection without borrowing the Provider mask", async () => {
    const seedConfig = createSeedConfig(1), endpoint = seedConfig.catalog!.providers[0]!.endpoints[0]!;
    endpoint.inheritProviderDefaults = false;
    endpoint.hasApiKey = false; endpoint.apiKeyMasked = ""; endpoint.apiKey = "";
    const configClient = {
      getModelConfig: vi.fn(async () => seedConfig),
      saveModelCatalog: vi.fn(async (_input: unknown) => seedConfig),
      testModelConfig: vi.fn(async (_input: unknown) => ({ ok: true, message: "ok", checkedAt: "2026-08-13T00:00:00.000Z" }))
    };
    await act(async () => {
      root.render(<I18nProvider language="zh-CN"><ModelWorkspaceSection mode="byok" seedConfig={seedConfig} configClient={configClient} /></I18nProvider>);
      await Promise.resolve();
    });
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="编辑 openai 配置"]')!.click());
    const save = container.querySelector<HTMLButtonElement>('button[aria-label="保存"]')!;
    expect(save.disabled).toBe(false);
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("");
    const test = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "测试")!;
    await act(async () => { test.click(); await Promise.resolve(); });
    expect(configClient.testModelConfig).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "", apiKeyMasked: "", endpointId: endpoint.endpointId }), "chat", expect.anything());
    await act(async () => { save.click(); await Promise.resolve(); });
    await vi.waitFor(() => expect(configClient.saveModelCatalog).toHaveBeenCalledTimes(1));
    const input = configClient.saveModelCatalog.mock.calls[0]![0] as { providers: Array<{ endpoints: Array<{ inheritProviderDefaults?: boolean; apiKey?: string }> }> };
    expect(input.providers[0]!.endpoints[0]).toMatchObject({ inheritProviderDefaults: false });
    expect(input.providers[0]!.endpoints[0]!.apiKey).toBeUndefined();
  });

  it.each(["endpoint", "protocol"] as const)(
    "does not reuse independent no-auth credentials after changing the %s",
    async (changedField) => {
      const seedConfig = createCustomSeedConfig();
      const endpoint = seedConfig.catalog!.providers[0]!.endpoints[0]!;
      endpoint.inheritProviderDefaults = false;
      endpoint.hasApiKey = false;
      endpoint.apiKeyMasked = "";
      endpoint.apiKey = "";
      const configClient = {
        getModelConfig: vi.fn(async () => seedConfig),
        saveModelCatalog: vi.fn(async (_input: unknown) => seedConfig),
        testModelConfig: vi.fn(async (_input: unknown) => ({
          ok: true, message: "ok", checkedAt: "2026-08-13T00:00:00.000Z"
        }))
      };
      await act(async () => {
        root.render(<I18nProvider language="zh-CN"><ModelWorkspaceSection mode="byok" seedConfig={seedConfig} configClient={configClient} /></I18nProvider>);
        await Promise.resolve();
      });
      act(() => container.querySelector<HTMLButtonElement>('button[aria-label="编辑 custom 配置"]')!.click());
      const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
      const save = () => dialog.querySelector<HTMLButtonElement>('button[aria-label="保存"]')!;
      expect(save().disabled).toBe(false);
      expect(dialog.querySelector('[role="alert"]')).toBeNull();
      if (changedField === "endpoint") {
        const input = [...dialog.querySelectorAll<HTMLInputElement>("input")]
          .find((element) => element.value === endpoint.apiBase)!;
        act(() => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "https://changed.example/v1");
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
      } else {
        const selector = [...dialog.querySelectorAll<HTMLButtonElement>('[role="combobox"]')]
          .find((button) => button.textContent?.includes("OpenAI Responses"))!;
        act(() => selector.click());
        const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
          .find((button) => button.textContent?.includes("Anthropic Messages"))!;
        act(() => option.click());
      }
      expect(save().disabled).toBe(true);
      const test = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "测试")!;
      await act(async () => { test.click(); await Promise.resolve(); });
      expect(configClient.testModelConfig).not.toHaveBeenCalled();
      act(() => save().click());
      expect(configClient.saveModelCatalog).not.toHaveBeenCalled();
    }
  );

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
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="保存"]')!.disabled).toBe(true);
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "测试")!.click();
    });
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="保存"]')!.click());

    await vi.waitFor(() => expect(configClient.saveModelCatalog).toHaveBeenCalledTimes(1));
    const input = configClient.saveModelCatalog.mock.calls[0]![0];
    const bgeModel = input.providers[0]?.models.find((model) => model.model === "bge-m3");
    expect(input.providers[0]?.endpoints[0]?.protocol).toBe("openai-embeddings");
    expect(bgeModel?.capabilities).toEqual(["embedding"]);
  });

  it("shows the platform local Embedding option for BYOK", () => {
    renderWorkspace(createSeedConfig(1));

    const embeddingSelect = getAssignmentCombobox("Embedding 检索");
    expect(embeddingSelect.disabled).toBe(false);
    expect(embeddingSelect.textContent).toContain("Memmy Platform 本地 Embedding");

    act(() => embeddingSelect.click());
    expect(getOption("Memmy Platform 本地 Embedding")).not.toBeNull();
    expect(getOption("Memmy Platform 云端 Embedding")).toBeNull();
    expect([...container.querySelectorAll(".select-control__group-label")].map((node) => node.textContent))
      .toEqual(["平台模型"]);
  });

  it("orders account Embedding options by platform and configured custom groups", () => {
    renderWorkspace(createAccountSeedConfig(), "account");

    const embeddingSelect = getAssignmentCombobox("Embedding 检索");
    expect(embeddingSelect.textContent).toContain("Memmy Platform 云端 Embedding");
    act(() => embeddingSelect.click());

    expect([...container.querySelectorAll(".select-control__group-label")].map((node) => node.textContent))
      .toEqual(["平台模型", "自定义模型"]);
    expect([...container.querySelectorAll('[role="option"]')].map((node) => node.textContent?.trim()))
      .toEqual([
        "Memmy Platform 本地 Embedding",
        "Memmy Platform 云端 Embedding",
        "OpenAI Completions · text-embedding-3-small"
      ]);
  });

  it("shows an unconfigured account Embedding assignment without treating it as local", () => {
    const seedConfig = createAccountSeedConfig();
    seedConfig.catalog.modelAssignments.account.embedding = null;

    renderWorkspace(seedConfig, "account");

    expect(getAssignmentCombobox("Embedding 检索").textContent).toContain("未配置");
    expect(getAssignmentCombobox("Embedding 检索").textContent).not.toContain("本地 Embedding");
  });

  it("persists the built-in local Embedding as a distinct account assignment", async () => {
    const seedConfig = createAccountSeedConfig();
    const byokPresetId = seedConfig.catalog.modelAssignments.byok.embedding!;
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
          <ModelWorkspaceSection mode="account" seedConfig={seedConfig} configClient={configClient} />
        </I18nProvider>
      );
      await Promise.resolve();
    });

    act(() => getAssignmentCombobox("Embedding 检索").click());
    const localOption = getOption("Memmy Platform 本地 Embedding");
    expect(localOption).not.toBeNull();
    act(() => localOption!.click());

    await vi.waitFor(() => expect(configClient.saveModelCatalog).toHaveBeenCalledTimes(1));
    const input = configClient.saveModelCatalog.mock.calls[0]![0];
    expect(input.modelAssignments.account.embedding).toBe(BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID);
    expect(input.modelAssignments.byok.embedding).toBe(byokPresetId);
  });

  it("keeps only the platform card shell and uses the platform Agent identity", () => {
    renderWorkspace(createAccountSeedConfig(), "account");

    const platformCard = [...container.querySelectorAll("article")]
      .find((article) => article.querySelector("h4")?.textContent?.includes("Memmy Platform"))!;
    expect(platformCard).not.toBeNull();
    expect(platformCard.querySelector(".provider-model-list")).toBeNull();
    expect(container.querySelectorAll(".provider-model-list")).toHaveLength(1);
    expect(container.querySelector(".task-model-selection-summary")?.textContent).toContain("agent_chat");

    act(() => [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("2 个已选"))!.click());

    const platformChoice = [...container.querySelectorAll<HTMLElement>(".task-model-picker__choice")]
      .find((choice) => choice.textContent?.includes("agent_chat"))!;
    expect(platformChoice.textContent).toContain("agent_chat");
    expect(platformChoice.textContent).toContain("Memmy Platform");
    expect(platformChoice.textContent).not.toContain("通用文本");
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

function createCustomSeedConfig(): ModelProviderConfig {
  const seed = createSeedConfig(1);
  const provider = seed.catalog.providers[0]!;
  const endpoint = provider.endpoints[0]!;
  provider.provider = "custom";
  endpoint.protocol = "openai-responses";
  const first = {
    ...provider.models[0]!,
    provider: "custom" as const,
    protocol: "openai-responses" as const,
    model: "model-a",
    custom: true,
    thinking: {
      switchable: true,
      defaultEnabled: true,
      levels: ["low", "medium", "high"] as Array<"low" | "medium" | "high">,
      defaultLevel: "medium" as const
    },
    inputModalities: ["text", "image"] as Array<"text" | "image">
  };
  const second = {
    ...first,
    presetId: "preset-2",
    model: "model-b",
    thinking: undefined,
    inputModalities: ["text"] as Array<"text" | "image">
  };
  provider.models = [first, second];
  seed.catalog.modelAssignments.byok.agent = {
    candidates: [first.presetId, second.presetId],
    default: first.presetId
  };
  seed.catalog.effectiveCandidates.byok = [first, second];
  seed.provider = "custom";
  seed.model = first.model;
  return seed;
}

function createAccountSeedConfig(): ModelProviderConfig {
  const seed = createEmbeddingSeedConfig();
  const customProvider = seed.catalog.providers[0]!;
  const customAgent = {
    presetId: "custom-agent",
    provider: "openai" as const,
    endpointId: customProvider.endpoints[0]!.endpointId,
    protocol: "openai-chat-completions" as const,
    model: "gpt-4o",
    source: "byok" as const,
    capabilities: ["agent" as const],
    available: true
  };
  customProvider.models.push(customAgent);

  const platformAgent = {
    presetId: "platform-agent",
    provider: "memmy_account" as const,
    endpointId: "platform",
    protocol: "memmy-account" as const,
    model: "agent_chat",
    source: "account" as const,
    ownerAccountId: "owner-a",
    capabilities: ["agent" as const],
    available: true
  };
  const platformEmbedding = {
    ...platformAgent,
    presetId: "platform-embedding",
    model: "embedding",
    capabilities: ["embedding" as const]
  };
  seed.catalog.providers.push({
    provider: "memmy_account",
    configured: true,
    hasApiKey: true,
    apiKeyMasked: "••••cloud",
    apiKey: "",
    ownerAccountId: "owner-a",
    endpoints: [{
      endpointId: "platform",
      apiBase: "https://platform.example.com/v1",
      protocol: "memmy-account",
      hasApiKey: false,
      apiKeyMasked: "",
      apiKey: ""
    }],
    accountManaged: true,
    editable: false,
    models: [platformAgent, platformEmbedding]
  });
  seed.catalog.modelAssignments.account = {
    ownerAccountId: "owner-a",
    agent: { candidates: [platformAgent.presetId, customAgent.presetId], default: platformAgent.presetId },
    memorySummary: null,
    memoryEvolution: null,
    embedding: platformEmbedding.presetId,
    asr: null,
    imageGeneration: null
  };
  seed.catalog.effectiveCandidates.account = [platformAgent, customAgent];
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
