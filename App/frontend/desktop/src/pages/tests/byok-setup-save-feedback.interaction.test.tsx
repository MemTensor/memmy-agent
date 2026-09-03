// @vitest-environment happy-dom

import type { ModelConfigInput, ModelConfigView } from "@memmy/local-api-contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppClients } from "../../api/client-types.js";
import type { ModelProviderConfig } from "../../api/config-client.js";
import { appActions } from "../../state/app-actions.js";
import { createInitialAppState, type AppState } from "../../state/app-reducer.js";
import {
  assignedCatalogEndpointId,
  assignCatalogPreset,
  createModelWorkspace,
  maskApiKey,
  modelConfigInput,
  upsertByokPreset
} from "../../state/model-workspace.js";
import { ApiKeyOptionalPage } from "../api-key-optional-page.js";
import { ApiKeyPage } from "../api-key-page.js";
import { ModelPage } from "../model-page.js";

const mocks = vi.hoisted(() => ({
  clients: null as AppClients | null,
  state: null as AppState | null,
  dispatch: vi.fn(),
  track: vi.fn()
}));

vi.mock("../../app/providers.js", () => ({
  useApiClients: () => ({ clients: mocks.clients, setClients: vi.fn() })
}));

vi.mock("../../state/app-state.js", () => ({
  useAppState: () => ({ state: mocks.state, dispatch: mocks.dispatch })
}));

vi.mock("../../analytics/use-analytics.js", () => ({
  useAnalytics: () => ({ track: mocks.track, ready: true })
}));

vi.mock("../../i18n/use-translation.js", () => ({
  useTranslation: () => ({ t: (key: string) => key, language: "zh-CN" })
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("BYOK setup save feedback", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.state = { ...createInitialAppState(), modelConfig: savedModelConfig() };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    mocks.clients = null;
    mocks.state = null;
    vi.restoreAllMocks();
  });

  it("advances from the first step after persistence succeeds", async () => {
    mocks.clients = createClients(vi.fn(async () => savedModelConfig()));
    await render(<ApiKeyPage />);

    await click(button("apiKey.next"));

    expect(mocks.dispatch).toHaveBeenCalledWith(appActions.navigate("/api-key-models"));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("defaults a genuinely absent BYOK embedding assignment to the local model", async () => {
    const catalog = configuredCatalog(false);
    catalog.modelAssignments.byok.embedding = null;
    mocks.state = {
      ...createInitialAppState(),
      modelConfig: { ...savedModelConfig(catalog), embedding: null }
    };
    mocks.clients = createClients(vi.fn(async () => savedModelConfig(catalog)));

    await render(<ApiKeyPage />);

    expect(combobox("apiKey.embeddingMode").textContent).toContain("apiKey.localEmbedding");
    expect(hasField("apiKey.embeddingModel")).toBe(false);
    expect(hasField("apiKey.embeddingEndpoint")).toBe(false);
    expect(hasField("apiKey.embeddingKey")).toBe(false);
  });

  it("keeps an explicit invalid BYOK embedding assignment in custom mode", async () => {
    const catalog = configuredCatalog(false);
    catalog.modelAssignments.byok.embedding = "missing-embedding-preset";
    mocks.state = {
      ...createInitialAppState(),
      modelConfig: { ...savedModelConfig(catalog), embedding: null }
    };
    mocks.clients = createClients(vi.fn(async () => savedModelConfig(catalog)));

    await render(<ApiKeyPage />);

    expect(combobox("apiKey.embeddingMode").textContent).toContain("apiKey.customEmbedding");
    expect(hasField("apiKey.embeddingModel")).toBe(true);
    expect(button("apiKey.next").disabled).toBe(true);
  });

  it("saves local embedding without deleting the custom preset or account assignment", async () => {
    const initialCatalog = catalogWithSharedEmbeddingAssignment();
    const embeddingPresetId = initialCatalog.modelAssignments.byok.embedding;
    const server = createCatalogServer(initialCatalog);
    mocks.state = { ...createInitialAppState(), modelConfig: maskedSavedModelConfig(server.catalog()) };
    mocks.clients = createClients(server.saveModelCatalog, { getModelConfig: server.getModelConfig });
    await render(<ApiKeyPage />);

    await selectOption("apiKey.embeddingMode", "apiKey.localEmbedding");
    await click(button("apiKey.next"));

    const saved = server.catalog();
    expect(saved.modelAssignments.byok.embedding).toBeNull();
    expect(saved.modelAssignments.account.embedding).toBe(embeddingPresetId);
    expect(saved.providers.flatMap((provider) => provider.models).map((model) => model.presetId))
      .toContain(embeddingPresetId);
  });

  it("reuses masked custom embedding identity after a partial local-mode save", async () => {
    const initialCatalog = catalogWithSharedEmbeddingAssignment();
    const initialEmbeddingEndpointId = assignedCatalogEndpointId(
      createModelWorkspace(initialCatalog),
      "byok",
      "embedding"
    );
    const initialEmbeddingPresetId = initialCatalog.modelAssignments.byok.embedding;
    const initialProviderCount = initialCatalog.providers.length;
    const initialPresetCount = initialCatalog.providers.flatMap((provider) => provider.models).length;
    const server = createCatalogServer(initialCatalog);
    const updateSettings = vi.fn(async (settings: unknown) => settings)
      .mockRejectedValueOnce(new Error("settings offline"));
    mocks.state = { ...createInitialAppState(), modelConfig: maskedSavedModelConfig(server.catalog()) };
    mocks.clients = createClients(server.saveModelCatalog, {
      getModelConfig: server.getModelConfig,
      updateSettings
    });
    await render(<ApiKeyPage />);

    await selectOption("apiKey.embeddingMode", "apiKey.localEmbedding");
    await click(button("apiKey.next"));
    expect(server.catalog().modelAssignments.byok.embedding).toBeNull();

    await selectOption("apiKey.embeddingMode", "apiKey.customEmbedding");
    await click(button("apiKey.next"));

    const restored = server.catalog();
    expect(server.saveModelCatalog).toHaveBeenCalledTimes(2);
    expect(assignedCatalogEndpointId(createModelWorkspace(restored), "byok", "embedding"))
      .toBe(initialEmbeddingEndpointId);
    expect(restored.modelAssignments.byok.embedding).toBe(initialEmbeddingPresetId);
    expect(restored.modelAssignments.account.embedding).toBe(initialEmbeddingPresetId);
    expect(restored.providers).toHaveLength(initialProviderCount);
    expect(restored.providers.flatMap((provider) => provider.models)).toHaveLength(initialPresetCount);
  });

  it("shows a first-step conflict, stays put, and allows a successful retry", async () => {
    const firstSave = deferred<ModelProviderConfig>();
    const saveModelCatalog = vi.fn()
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce(savedModelConfig());
    mocks.clients = createClients(saveModelCatalog);
    await render(<ApiKeyPage />);
    const nextButton = button("apiKey.next");

    await click(nextButton);
    expect(nextButton.disabled).toBe(true);

    await reject(firstSave, Object.assign(new Error("stale revision"), { code: "model_config_changed" }));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("settings.model.configChanged");
    expect(nextButton.disabled).toBe(false);
    expect(mocks.dispatch).not.toHaveBeenCalledWith(appActions.navigate("/api-key-models"));

    await click(nextButton);
    expect(mocks.dispatch).toHaveBeenCalledWith(appActions.navigate("/api-key-models"));
  });

  it("does not save the first-step catalog again when mode persistence is retried", async () => {
    const saveModelCatalog = vi.fn(async () => savedModelConfig());
    const updateSettings = vi.fn(async (settings: unknown) => settings)
      .mockRejectedValueOnce(new Error("settings offline"));
    mocks.clients = createClients(saveModelCatalog, { updateSettings });
    await render(<ApiKeyPage />);
    const nextButton = button("apiKey.next");

    await click(nextButton);

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("settings offline");
    expect(saveModelCatalog).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).not.toHaveBeenCalledWith(appActions.navigate("/api-key-models"));

    await click(nextButton);

    expect(saveModelCatalog).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledWith(appActions.navigate("/api-key-models"));
  });

  it("saves the catalog again when a partial custom save is retried as local", async () => {
    const initialCatalog = catalogWithSharedEmbeddingAssignment();
    const server = createCatalogServer(initialCatalog);
    const updateSettings = vi.fn(async (settings: unknown) => settings)
      .mockRejectedValueOnce(new Error("settings offline"));
    mocks.state = { ...createInitialAppState(), modelConfig: maskedSavedModelConfig(server.catalog()) };
    mocks.clients = createClients(server.saveModelCatalog, {
      getModelConfig: server.getModelConfig,
      updateSettings
    });
    await render(<ApiKeyPage />);

    await click(button("apiKey.next"));
    expect(server.saveModelCatalog).toHaveBeenCalledTimes(1);
    expect(server.catalog().modelAssignments.byok.embedding).not.toBeNull();

    await selectOption("apiKey.embeddingMode", "apiKey.localEmbedding");
    await click(button("apiKey.next"));

    expect(server.saveModelCatalog).toHaveBeenCalledTimes(2);
    expect(server.catalog().modelAssignments.byok.embedding).toBeNull();
    expect(server.catalog().modelAssignments.account.embedding)
      .toBe(initialCatalog.modelAssignments.account.embedding);
  });

  it("reuses first-step endpoint identities when only the model changes after partial success", async () => {
    const server = createCatalogServer(configuredCatalog(false));
    const updateSettings = vi.fn(async (settings: unknown) => settings)
      .mockRejectedValueOnce(new Error("settings offline"));
    mocks.state = { ...createInitialAppState(), modelConfig: savedModelConfig(server.catalog()) };
    mocks.clients = createClients(server.saveModelCatalog, {
      getModelConfig: server.getModelConfig,
      updateSettings
    });
    await render(<ApiKeyPage />);
    const nextButton = button("apiKey.next");

    await click(nextButton);
    const firstCatalog = server.catalog();
    const firstAgentEndpointId = assignedCatalogEndpointId(createModelWorkspace(firstCatalog), "byok", "agent");
    expect(endpointCount(firstCatalog)).toBe(2);
    expect(mocks.dispatch).not.toHaveBeenCalledWith(appActions.navigate("/api-key-models"));

    await changeField("apiKey.model", "gpt-4.1");
    await click(button("apiKey.test"));
    await vi.waitFor(() => expect(nextButton.disabled).toBe(false));
    await click(nextButton);

    const retriedCatalog = server.catalog();
    expect(server.saveModelCatalog).toHaveBeenCalledTimes(2);
    expect(endpointCount(retriedCatalog)).toBe(2);
    expect(assignedCatalogEndpointId(createModelWorkspace(retriedCatalog), "byok", "agent"))
      .toBe(firstAgentEndpointId);
    expect(mocks.dispatch).toHaveBeenCalledWith(appActions.navigate("/api-key-models"));
  });

  it("reuses existing first-step endpoints when saved keys are entered again", async () => {
    const server = createCatalogServer(configuredCatalog(false));
    const initialAgentEndpointId = assignedCatalogEndpointId(createModelWorkspace(server.catalog()), "byok", "agent");
    const initialEmbeddingEndpointId = assignedCatalogEndpointId(createModelWorkspace(server.catalog()), "byok", "embedding");
    mocks.state = { ...createInitialAppState(), modelConfig: maskedSavedModelConfig(server.catalog()) };
    mocks.clients = createClients(server.saveModelCatalog, {
      getModelConfig: vi.fn(async () => maskedSavedModelConfig(server.catalog()))
    });
    await render(<ApiKeyPage />);

    await changeField("apiKey.key", "sk-primary");
    await click(testButton());
    await changeField("apiKey.embeddingKey", "sk-embedding");
    await click(testButton(1));
    await vi.waitFor(() => expect(button("apiKey.next").disabled).toBe(false));
    await click(button("apiKey.next"));

    const savedCatalog = server.catalog();
    expect(endpointCount(savedCatalog)).toBe(2);
    expect(assignedCatalogEndpointId(createModelWorkspace(savedCatalog), "byok", "agent"))
      .toBe(initialAgentEndpointId);
    expect(assignedCatalogEndpointId(createModelWorkspace(savedCatalog), "byok", "embedding"))
      .toBe(initialEmbeddingEndpointId);
  });

  it("invalidates only the changed first-step credential identity", async () => {
    const server = createCatalogServer(configuredCatalog(false));
    const updateSettings = vi.fn(async (settings: unknown) => settings)
      .mockRejectedValueOnce(new Error("settings offline"));
    mocks.state = { ...createInitialAppState(), modelConfig: savedModelConfig(server.catalog()) };
    mocks.clients = createClients(server.saveModelCatalog, {
      getModelConfig: server.getModelConfig,
      updateSettings
    });
    await render(<ApiKeyPage />);
    const nextButton = button("apiKey.next");

    await click(nextButton);
    const firstCatalog = server.catalog();
    const firstAgentEndpointId = assignedCatalogEndpointId(createModelWorkspace(firstCatalog), "byok", "agent");

    await changeField("apiKey.key", "sk-primary-changed");
    await click(button("apiKey.test"));
    await vi.waitFor(() => expect(nextButton.disabled).toBe(false));
    await click(nextButton);

    const retriedCatalog = server.catalog();
    expect(endpointCount(retriedCatalog)).toBe(3);
    expect(assignedCatalogEndpointId(createModelWorkspace(retriedCatalog), "byok", "agent"))
      .not.toBe(firstAgentEndpointId);
  });

  it("shows a busy error after Skip, stays put, and allows a successful retry", async () => {
    const firstSave = deferred<ModelProviderConfig>();
    const saveModelCatalog = vi.fn()
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce(savedModelConfig());
    mocks.clients = createClients(saveModelCatalog);
    await render(<ApiKeyOptionalPage />);
    const skipButton = button("apiKey.optionalPage.skip");
    const nextButton = button("apiKey.next");

    await click(skipButton);
    expect(skipButton.disabled).toBe(true);
    expect(nextButton.disabled).toBe(true);

    await reject(firstSave, Object.assign(new Error("busy"), { code: "config_write_busy" }));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("settings.modelWorkspace.saveBusy");
    expect(skipButton.disabled).toBe(false);
    expect(nextButton.disabled).toBe(false);
    expect(mocks.dispatch).not.toHaveBeenCalledWith(appActions.navigate("/onboarding"));

    await click(skipButton);
    expect(mocks.dispatch).toHaveBeenCalledWith(appActions.navigate("/onboarding"));
  });

  it("shows a raw save error after Next, stays put, and allows a successful retry", async () => {
    const firstSave = deferred<ModelProviderConfig>();
    const saveModelCatalog = vi.fn()
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce(savedModelConfig());
    mocks.clients = createClients(saveModelCatalog);
    await render(<ApiKeyOptionalPage />);
    const skipButton = button("apiKey.optionalPage.skip");
    const nextButton = button("apiKey.next");

    await click(nextButton);
    await reject(firstSave, new Error("catalog offline"));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("catalog offline");
    expect(skipButton.disabled).toBe(false);
    expect(nextButton.disabled).toBe(false);
    expect(mocks.dispatch).not.toHaveBeenCalledWith(appActions.navigate("/onboarding"));

    await click(nextButton);
    expect(mocks.dispatch).toHaveBeenCalledWith(appActions.navigate("/onboarding"));
  });

  it("does not save the optional catalog again when onboarding persistence is retried", async () => {
    const saveModelCatalog = vi.fn(async () => savedModelConfig());
    const updateOnboarding = vi.fn(async (onboarding: unknown) => onboarding)
      .mockRejectedValueOnce(new Error("onboarding offline"));
    mocks.clients = createClients(saveModelCatalog, { updateOnboarding });
    await render(<ApiKeyOptionalPage />);
    const nextButton = button("apiKey.next");

    await click(nextButton);

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("onboarding offline");
    expect(saveModelCatalog).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).not.toHaveBeenCalledWith(appActions.navigate("/onboarding"));

    await click(nextButton);

    expect(saveModelCatalog).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledWith(appActions.navigate("/onboarding"));
  });

  it("reuses optional endpoint identities when only the image model changes after partial success", async () => {
    const server = createCatalogServer(configuredCatalog(false));
    const updateOnboarding = vi.fn(async (onboarding: unknown) => onboarding)
      .mockRejectedValueOnce(new Error("onboarding offline"));
    mocks.state = { ...createInitialAppState(), modelConfig: savedModelConfig(server.catalog()) };
    mocks.clients = createClients(server.saveModelCatalog, {
      getModelConfig: server.getModelConfig,
      updateOnboarding
    });
    await render(<ApiKeyOptionalPage />);
    const nextButton = button("apiKey.next");

    await click(nextButton);
    const firstCatalog = server.catalog();
    const firstImageEndpointId = assignedCatalogEndpointId(createModelWorkspace(firstCatalog), "byok", "image_generation");
    expect(endpointCount(firstCatalog)).toBe(4);
    expect(mocks.dispatch).not.toHaveBeenCalledWith(appActions.navigate("/onboarding"));

    await changeField("apiKey.imageGenModel", "gpt-image-2");
    await click(button("apiKey.test", 1));
    await vi.waitFor(() => expect(nextButton.disabled).toBe(false));
    await click(nextButton);

    const retriedCatalog = server.catalog();
    expect(server.saveModelCatalog).toHaveBeenCalledTimes(2);
    expect(endpointCount(retriedCatalog)).toBe(4);
    expect(assignedCatalogEndpointId(createModelWorkspace(retriedCatalog), "byok", "image_generation"))
      .toBe(firstImageEndpointId);
    expect(mocks.dispatch).toHaveBeenCalledWith(appActions.navigate("/onboarding"));
  });

  it("reuses existing optional endpoints when saved keys are entered again", async () => {
    const server = createCatalogServer(configuredCatalog());
    const initialAsrEndpointId = assignedCatalogEndpointId(createModelWorkspace(server.catalog()), "byok", "asr");
    const initialImageEndpointId = assignedCatalogEndpointId(createModelWorkspace(server.catalog()), "byok", "image_generation");
    mocks.state = { ...createInitialAppState(), modelConfig: maskedSavedModelConfig(server.catalog()) };
    mocks.clients = createClients(server.saveModelCatalog, {
      getModelConfig: vi.fn(async () => maskedSavedModelConfig(server.catalog()))
    });
    await render(<ApiKeyOptionalPage />);

    await changeField("apiKey.asrKey", "sk-asr");
    await click(testButton());
    await changeField("apiKey.imageGenKey", "sk-image");
    await click(testButton(1));
    await vi.waitFor(() => expect(button("apiKey.next").disabled).toBe(false));
    await click(button("apiKey.next"));

    const savedCatalog = server.catalog();
    expect(endpointCount(savedCatalog)).toBe(4);
    expect(assignedCatalogEndpointId(createModelWorkspace(savedCatalog), "byok", "asr"))
      .toBe(initialAsrEndpointId);
    expect(assignedCatalogEndpointId(createModelWorkspace(savedCatalog), "byok", "image_generation"))
      .toBe(initialImageEndpointId);
  });

  it("keeps the middle step pending and retryable when its catalog save fails", async () => {
    const firstSave = deferred<ModelProviderConfig>();
    const saveModelCatalog = vi.fn()
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce(savedModelConfig());
    mocks.clients = createClients(saveModelCatalog);
    await render(<ModelPage />);
    const nextButton = button("apiKey.next");

    await click(nextButton);
    expect(nextButton.disabled).toBe(true);

    await reject(firstSave, new Error("middle step offline"));

    expect(container.textContent).toContain("middle step offline");
    expect(nextButton.disabled).toBe(false);
    expect(mocks.dispatch).not.toHaveBeenCalledWith(appActions.navigate("/api-key-optional"));

    await click(nextButton);
    expect(mocks.dispatch).toHaveBeenCalledWith(appActions.navigate("/api-key-optional"));
  });

  async function render(page: React.ReactNode) {
    await act(async () => root.render(page));
  }

  async function click(target: HTMLButtonElement) {
    await act(async () => target.click());
  }

  function button(label: string, index = 0): HTMLButtonElement {
    const target = [...container.querySelectorAll("button")]
      .filter((candidate) => candidate.textContent === label)[index];
    if (!(target instanceof HTMLButtonElement)) {
      throw new Error(`button not found: ${label}`);
    }
    return target;
  }

  function testButton(index = 0): HTMLButtonElement {
    const target = [...container.querySelectorAll("button")]
      .filter((candidate) => candidate.textContent?.startsWith("apiKey.test"))[index];
    if (!(target instanceof HTMLButtonElement)) {
      throw new Error(`test button not found: ${index}`);
    }
    return target;
  }

  function combobox(labelText: string): HTMLButtonElement {
    const label = [...container.querySelectorAll(".select-control__label")]
      .find((candidate) => candidate.textContent === labelText);
    const target = label?.parentElement?.querySelector('button[role="combobox"]');
    if (!(target instanceof HTMLButtonElement)) {
      throw new Error(`combobox not found: ${labelText}`);
    }
    return target;
  }

  async function selectOption(labelText: string, optionText: string) {
    await click(combobox(labelText));
    const target = [...container.querySelectorAll('button[role="option"]')]
      .find((candidate) => candidate.textContent?.includes(optionText));
    if (!(target instanceof HTMLButtonElement)) {
      throw new Error(`option not found: ${optionText}`);
    }
    await click(target);
  }

  function hasField(labelText: string): boolean {
    return [...container.querySelectorAll("label")]
      .some((candidate) => candidate.textContent === labelText);
  }

  async function changeField(labelText: string, value: string) {
    const label = [...container.querySelectorAll("label")]
      .find((candidate) => candidate.textContent === labelText);
    const input = label?.parentElement?.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error(`input not found: ${labelText}`);
    }
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
});

function createClients(
  saveModelCatalog: ReturnType<typeof vi.fn>,
  overrides: {
    getModelConfig?: ReturnType<typeof vi.fn>;
    testModelConfig?: ReturnType<typeof vi.fn>;
    updateSettings?: ReturnType<typeof vi.fn>;
    updateOnboarding?: ReturnType<typeof vi.fn>;
  } = {}
): AppClients {
  return {
    config: {
      getModelConfig: vi.fn(async () => mocks.state!.modelConfig),
      saveModelCatalog,
      testModelConfig: vi.fn(async () => ({
        ok: true,
        message: "ok",
        checkedAt: "2026-08-19T00:00:00.000Z"
      })),
      updateSettings: vi.fn(async (settings) => settings),
      updateOnboarding: vi.fn(async (onboarding) => onboarding),
      ...overrides
    }
  } as unknown as AppClients;
}

function savedModelConfig(catalog = configuredCatalog()): ModelProviderConfig {
  return {
    provider: "openai",
    endpoint: "https://api.openai.com/v1",
    model: "gpt-4o",
    apiKey: "sk-primary",
    apiKeyMasked: "",
    configured: true,
    embedding: {
      mode: "custom",
      endpoint: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
      apiKey: "sk-embedding",
      apiKeyMasked: "",
      configured: true
    },
    asr: {
      provider: "qwen",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen3-asr-flash",
      apiKey: "sk-asr",
      apiKeyMasked: "",
      configured: true
    },
    imageGen: {
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-image-1",
      apiKey: "sk-image",
      apiKeyMasked: "",
      configured: true
    },
    catalog
  };
}

function maskedSavedModelConfig(catalog = configuredCatalog()): ModelProviderConfig {
  const saved = savedModelConfig(catalog);
  return {
    ...saved,
    apiKey: "",
    apiKeyMasked: maskApiKey("sk-primary"),
    embedding: saved.embedding ? {
      ...saved.embedding,
      apiKey: "",
      apiKeyMasked: maskApiKey("sk-embedding")
    } : undefined,
    asr: saved.asr ? {
      ...saved.asr,
      apiKey: "",
      apiKeyMasked: maskApiKey("sk-asr")
    } : undefined,
    imageGen: saved.imageGen ? {
      ...saved.imageGen,
      apiKey: "",
      apiKeyMasked: maskApiKey("sk-image")
    } : undefined
  };
}

function configuredCatalog(includeOptional = true): ModelConfigView {
  const empty = emptyCatalog();
  let workspace = createModelWorkspace(empty);
  const agent = upsertByokPreset(workspace, {
    provider: "openai",
    endpoint: "https://api.openai.com/v1",
    protocol: "openai-chat-completions",
    apiKey: "sk-primary",
    model: "gpt-4o",
    capabilities: ["agent"]
  });
  workspace = assignCatalogPreset(agent.workspace, "byok", "agent", agent.presetId);
  const embedding = upsertByokPreset(workspace, {
    provider: "openai",
    endpoint: "https://api.openai.com/v1",
    protocol: "openai-embeddings",
    apiKey: "sk-embedding",
    model: "text-embedding-3-small",
    capabilities: ["embedding"]
  });
  workspace = assignCatalogPreset(embedding.workspace, "byok", "embedding", embedding.presetId);
  if (!includeOptional) {
    return catalogFromInput(modelConfigInput(workspace), empty, 1);
  }
  const asr = upsertByokPreset(workspace, {
    provider: "qwen",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    protocol: "dashscope-input-audio-chat",
    apiKey: "sk-asr",
    model: "qwen3-asr-flash",
    capabilities: ["asr"]
  });
  workspace = assignCatalogPreset(asr.workspace, "byok", "asr", asr.presetId);
  const image = upsertByokPreset(workspace, {
    provider: "openai",
    endpoint: "https://api.openai.com/v1",
    protocol: "openai-images",
    apiKey: "sk-image",
    model: "gpt-image-1",
    capabilities: ["image_generation"]
  });
  workspace = assignCatalogPreset(image.workspace, "byok", "image_generation", image.presetId);
  return catalogFromInput(modelConfigInput(workspace), empty, 1);
}

function catalogWithSharedEmbeddingAssignment(): ModelConfigView {
  const catalog = configuredCatalog(false);
  catalog.modelAssignments.account.embedding = catalog.modelAssignments.byok.embedding;
  return catalog;
}

function endpointCount(catalog: ModelConfigView): number {
  return catalog.providers.reduce((total, provider) => total + provider.endpoints.length, 0);
}

function emptyCatalog(): ModelConfigView {
  const assignment = {
    agent: { candidates: [], default: null },
    memorySummary: null,
    memoryEvolution: null,
    embedding: null,
    asr: null,
    imageGeneration: null
  };
  return {
    configRevision: "revision-0",
    providers: [],
    modelAssignments: {
      byok: structuredClone(assignment),
      account: structuredClone(assignment)
    },
    effectiveCandidates: { byok: [], account: [] },
    configured: false,
    updatedAt: "2026-08-19T00:00:00.000Z"
  };
}

function createCatalogServer(initialCatalog = emptyCatalog()) {
  let catalog = structuredClone(initialCatalog);
  let revision = 0;
  return {
    getModelConfig: vi.fn(async () => savedModelConfig(catalog)),
    saveModelCatalog: vi.fn(async (input: ModelConfigInput | ModelConfigView) => {
      const writable = "configured" in input
        ? modelConfigInput(createModelWorkspace(input))
        : input;
      catalog = catalogFromInput(writable, catalog, ++revision);
      return savedModelConfig(catalog);
    }),
    catalog: () => structuredClone(catalog)
  };
}

function catalogFromInput(input: ModelConfigInput, previous: ModelConfigView, revision: number): ModelConfigView {
  const providers: ModelConfigView["providers"] = input.providers.map((provider) => {
    const previousProvider = previous.providers.find((candidate) => candidate.provider === provider.provider);
    const endpoints = provider.endpoints.map((endpoint) => {
      const previousEndpoint = previousProvider?.endpoints.find((candidate) => candidate.endpointId === endpoint.endpointId);
      const rawApiKey = endpoint.apiKey?.trim() ?? "";
      const apiKeyMasked = rawApiKey ? maskApiKey(rawApiKey) : previousEndpoint?.apiKeyMasked ?? "";
      return {
        endpointId: endpoint.endpointId,
        apiBase: endpoint.apiBase,
        protocol: endpoint.protocol,
        hasApiKey: Boolean(rawApiKey || apiKeyMasked),
        apiKeyMasked,
        apiKey: ""
      };
    });
    const models = provider.models.map((model) => {
      const endpoint = endpoints.find((candidate) => candidate.endpointId === model.endpointId)!;
      return {
        ...model,
        provider: provider.provider,
        protocol: endpoint.protocol,
        available: true
      };
    });
    const apiKeyMasked = provider.apiKey
      ? maskApiKey(provider.apiKey)
      : previousProvider?.apiKeyMasked ?? "";
    return {
      provider: provider.provider,
      configured: endpoints.some((endpoint) => endpoint.hasApiKey),
      hasApiKey: Boolean(apiKeyMasked) || endpoints.some((endpoint) => endpoint.hasApiKey),
      apiKeyMasked,
      apiKey: "",
      endpoints,
      accountManaged: false,
      editable: true,
      models
    };
  });
  const models = providers.flatMap((provider) => provider.models);
  const byokIds = new Set(input.modelAssignments.byok.agent.candidates);
  const accountIds = new Set(input.modelAssignments.account.agent.candidates);
  return {
    configRevision: `revision-${revision}`,
    providers,
    modelAssignments: structuredClone(input.modelAssignments),
    effectiveCandidates: {
      byok: models.filter((model) => byokIds.has(model.presetId)),
      account: models.filter((model) => accountIds.has(model.presetId))
    },
    configured: byokIds.size > 0 || accountIds.size > 0,
    updatedAt: "2026-08-19T00:00:00.000Z"
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function reject<T>(pending: ReturnType<typeof deferred<T>>, error: unknown) {
  await act(async () => {
    pending.reject(error);
    await Promise.resolve();
  });
}
