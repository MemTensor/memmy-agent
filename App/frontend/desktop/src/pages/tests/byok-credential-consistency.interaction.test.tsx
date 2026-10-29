// @vitest-environment happy-dom

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCapability, ModelConfigInput, ModelConfigTestInput } from "@memmy/local-api-contracts";
import { createMemmyConfigWriter } from "../../../../../backend/src/infrastructure/memmy-config/index.js";
import { createAppConfigService, type CreateAppConfigServiceOptions } from "../../../../../backend/src/services/app-config-service.js";
import { createHttpConfigClient } from "../../api/config-client.js";
import type { AppClients } from "../../api/client-types.js";
import { createInitialAppState, type AppState } from "../../state/app-reducer.js";
import { assignedCatalogEndpointId, assignCatalogPreset, createModelWorkspace, modelConfigInput, upsertByokPreset } from "../../state/model-workspace.js";
import { ApiKeyPage } from "../api-key-page.js";
import { ApiKeyOptionalPage } from "../api-key-optional-page.js";
import { ModelWorkspaceSection } from "../model-workspace-section.js";
import { ModelPage } from "../model-page.js";

const mocks = vi.hoisted(() => ({ clients: null as AppClients | null, state: null as AppState | null, dispatch: vi.fn() }));
vi.mock("../../app/providers.js", () => ({ useApiClients: () => ({ clients: mocks.clients }) }));
vi.mock("../../state/app-state.js", () => ({ useAppState: () => ({ state: mocks.state, dispatch: mocks.dispatch }) }));
vi.mock("../../analytics/use-analytics.js", () => ({ useAnalytics: () => ({ track: vi.fn() }) }));
vi.mock("../../i18n/use-translation.js", () => ({ useTranslation: () => ({ t: (key: string) => key, language: "zh-CN" }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Use the real HTTP client conversion, backend secret resolution and catalog file writer.
// Only transport and the external model provider are replaced; no real keys or network calls.
async function createServer(directory: string, independent = true) {
  const writer = createMemmyConfigWriter({ configPath: join(directory, "config.yaml") });
  const probe = vi.fn(async (input: ModelConfigTestInput & { apiKey: string }) => {
    void input;
    return { ok: true, message: "ok", checkedAt: "2026-10-16T00:00:00.000Z" };
  });
  const service = createAppConfigService({
    bootstrapRepository: {} as CreateAppConfigServiceOptions["bootstrapRepository"],
    memmyConfigWriter: writer,
    modelConfigTester: { test: probe }
  });
  const persistModelConfig = service.setModelConfig.bind(service);
  const write = vi.spyOn(service, "setModelConfig");
  vi.stubGlobal("fetch", vi.fn(async (url: URL, init: RequestInit) => {
    const path = new URL(url).pathname;
    let data: unknown;
    if (path.endsWith("/test")) data = await service.testModelConfig(JSON.parse(String(init.body)));
    else if (path === "/api/app/model-config") data = init.method === "GET"
      ? await service.getModelConfig() : await service.setModelConfig(JSON.parse(String(init.body)) as ModelConfigInput);
    else throw new Error(`Unexpected request: ${path}`);
    return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  }));
  const client = createHttpConfigClient({ baseUrl: "http://test.invalid", localToken: "test-only" });
  client.updateSettings = vi.fn(async (input) => input) as typeof client.updateSettings;
  client.updateOnboarding = vi.fn(async (input) => input) as typeof client.updateOnboarding;
  let workspace = createModelWorkspace(await service.getModelConfig());
  for (const [capability, provider, protocol, model, key] of [
    ["agent", "openai", "openai-chat-completions", "same-model", "sk-personal-1111"],
    ["embedding", "openai", "openai-embeddings", "embed-model", "sk-embedding-2222"],
    ["asr", "qwen", "dashscope-input-audio-chat", "qwen3-asr-flash", "sk-asr-3333"],
    ["image_generation", "openai", "openai-images", "image-model", "sk-image-4444"],
    ...(independent ? [
      ["memory_evolution", "openai", "openai-chat-completions", "same-model", "sk-team-1111"],
      ["memory_summary", "openai", "openai-chat-completions", "same-model", "sk-summary-1111"]
    ] : [])
  ] as const) {
    const preset = upsertByokPreset(workspace, {
      provider, protocol, model, apiKey: key, endpoint: "https://provider.example/v1", capabilities: [capability]
    });
    workspace = assignCatalogPreset(preset.workspace, "byok", capability, preset.presetId);
  }
  // Same route/model/capabilities and same displayed mask, but a different secret.
  // Saving the primary key must never resolve to this unassigned alternative.
  workspace = upsertByokPreset(workspace, {
    provider: "openai", protocol: "openai-chat-completions", model: "same-model",
    apiKey: "sk-alternative-1111", endpoint: "https://provider.example/v1", capabilities: ["agent"]
  }).workspace;
  await client.saveModelCatalog(modelConfigInput(workspace));
  write.mockClear();
  const saveCatalog = vi.spyOn(client, "saveModelCatalog");
  return {
    client, probe, write, writer, saveCatalog, persistModelConfig,
    read: () => client.getModelConfig(),
    async key(capability: ModelCapability) {
      const config = await client.getModelConfig();
      const workspace = createModelWorkspace(config);
      const id = assignedCatalogEndpointId(workspace, "byok", capability)!;
      const provider = config.catalog!.providers.find((provider) => provider.endpoints.some((endpoint) => endpoint.endpointId === id))!;
      return writer.readEndpointApiKey!(provider.provider, id);
    }
  };
}

type Scenario = { role: ModelCapability; page: () => ReactNode; endpoint: string; model: string; key: string; expected: string; index: number; fieldIndex?: number };
const scenarios: Scenario[] = [
  { role: "agent", page: () => <ApiKeyPage />, endpoint: "apiKey.endpoint", model: "apiKey.model", key: "apiKey.key", expected: "sk-personal-1111", index: 0 },
  { role: "embedding", page: () => <ApiKeyPage />, endpoint: "apiKey.embeddingEndpoint", model: "apiKey.embeddingModel", key: "apiKey.embeddingKey", expected: "sk-embedding-2222", index: 1 },
  { role: "asr", page: () => <ApiKeyOptionalPage />, endpoint: "apiKey.asrEndpoint", model: "apiKey.asrModel", key: "apiKey.asrKey", expected: "sk-asr-3333", index: 0 },
  { role: "image_generation", page: () => <ApiKeyOptionalPage />, endpoint: "apiKey.imageGenEndpoint", model: "apiKey.imageGenModel", key: "apiKey.imageGenKey", expected: "sk-image-4444", index: 1 },
  { role: "memory_evolution", page: () => <ModelPage />, endpoint: "apiKey.endpoint", model: "apiKey.model", key: "API Key", expected: "sk-team-1111", index: 1, fieldIndex: 1 },
  { role: "memory_summary", page: () => <ModelPage />, endpoint: "apiKey.endpoint", model: "apiKey.model", key: "API Key", expected: "sk-summary-1111", index: 0, fieldIndex: 0 }
];

describe("BYOK displayed, tested and saved credentials", () => {
  let directory: string;
  let container: HTMLDivElement;
  let root: Root;
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    directory = await mkdtemp(join(tmpdir(), "memmy-byok-review-"));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    server = await createServer(directory);
    mocks.state = { ...createInitialAppState(), modelConfig: await server.read() };
    mocks.clients = { config: server.client } as AppClients;
  });
  afterEach(async () => {
    await act(async () => {
      await Promise.allSettled(server.saveCatalog.mock.results.map((result) => result.value));
    });
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  async function render(page: ReactNode) { await act(async () => root.render(page)); }
  async function click(button: HTMLButtonElement) { await act(async () => button.click()); }
  function navigationCount() {
    return mocks.dispatch.mock.calls.filter(([action]) => action?.type === "navigation/changed").length;
  }
  async function saveAndWaitForCatalog(button: HTMLButtonElement) {
    const previousSaves = server.saveCatalog.mock.calls.length;
    const previousWrites = server.write.mock.calls.length;
    await click(button);
    await vi.waitFor(() => expect(server.saveCatalog.mock.calls.length).toBeGreaterThan(previousSaves));
    // A new preset is created before its assignment is published. A server write
    // starting is not proof that the complete client save has finished.
    await act(async () => {
      await Promise.all(server.saveCatalog.mock.results.slice(previousSaves).map((result) => result.value));
    });
    expect(server.write.mock.calls.length).toBeGreaterThan(previousWrites);
  }
  function next() { return [...container.querySelectorAll("button")].find((button) => button.textContent === "apiKey.next")!; }
  function test(index: number) { return [...container.querySelectorAll("button")].filter((button) => button.textContent?.startsWith("apiKey.test"))[index]!; }
  function field(label: string, index = 0) {
    return [...container.querySelectorAll("label")].filter((node) => node.textContent === label)[index]!.parentElement!.querySelector("input")!;
  }
  async function change(input: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function testAndSave(scenario: Scenario) {
    const count = server.probe.mock.calls.length;
    await click(test(scenario.index));
    await vi.waitFor(() => expect(server.probe).toHaveBeenCalledTimes(count + 1));
    await vi.waitFor(() => expect(test(scenario.index).textContent).toBe("apiKey.testSuccess"));
    const tested = server.probe.mock.calls.at(-1)![0];
    const previousNavigations = navigationCount();
    await saveAndWaitForCatalog(next());
    await vi.waitFor(() => expect(navigationCount()).toBeGreaterThan(previousNavigations));
    expect(await server.key(scenario.role)).toBe(tested.apiKey);
    return tested;
  }

  it.each(scenarios.slice(0, 4))("onboarding $role: waits for assignment publication before leaving", async (scenario) => {
    const persist = server.persistModelConfig;
    let releaseAssignment!: () => void;
    let assignmentStarted!: () => void;
    const assignmentGate = new Promise<void>((resolve) => { releaseAssignment = resolve; });
    const started = new Promise<void>((resolve) => { assignmentStarted = resolve; });
    server.write.mockImplementationOnce(persist).mockImplementationOnce(async (input) => {
      assignmentStarted();
      await assignmentGate;
      return persist(input);
    });
    try {
      await render(scenario.page());
      await change(field(scenario.key), "sk-new-onboarding-9999");
      await click(test(scenario.index));
      await vi.waitFor(() => expect(test(scenario.index).textContent).toBe("apiKey.testSuccess"));
      const button = next();
      const previousNavigations = navigationCount();
      await click(button);
      await started;
      const saving = server.saveCatalog.mock.results.at(-1)!.value;
      // The old write-start observation is already true while publication is pending.
      expect(server.write).toHaveBeenCalled();
      expect(button.disabled).toBe(true);
      expect(navigationCount()).toBe(previousNavigations);
      await act(async () => {
        releaseAssignment();
        await saving;
      });
      await vi.waitFor(() => expect(navigationCount()).toBeGreaterThan(previousNavigations));
      expect(await server.key(scenario.role)).toBe("sk-new-onboarding-9999");
    } finally {
      releaseAssignment();
    }
  });

  it.each(scenarios)("$role: unchanged masked credential resolves and persists the same real key", async (scenario) => {
    await render(scenario.page());
    expect(field(scenario.key, scenario.fieldIndex).value).toBe("");
    expect(field(scenario.key, scenario.fieldIndex).placeholder).toContain(scenario.expected.slice(-4));
    expect((await testAndSave(scenario)).apiKey).toBe(scenario.expected);
  });

  it.each(scenarios)("$role: changed URL blocks old credentials; explicit key tests and saves a separate connection", async (scenario) => {
    const original = await server.read();
    const oldId = assignedCatalogEndpointId(createModelWorkspace(original), "byok", scenario.role)!;
    const oldProvider = original.catalog!.providers.find((provider) => provider.endpoints.some((endpoint) => endpoint.endpointId === oldId))!.provider;
    await render(scenario.page());
    await click(test(scenario.index));
    await vi.waitFor(() => expect(test(scenario.index).textContent).toBe("apiKey.testSuccess"));
    await change(field(scenario.endpoint, scenario.fieldIndex), "https://changed.example/v1");
    expect(field(scenario.key, scenario.fieldIndex).placeholder).toBe("sk-...");
    expect(container.textContent).toContain("apiKey.credentialsChanged");
    expect(test(scenario.index).textContent).not.toBe("apiKey.testSuccess");
    const calls = server.probe.mock.calls.length;
    await click(test(scenario.index));
    expect(server.probe).toHaveBeenCalledTimes(calls);
    await click(next());
    expect(server.write).not.toHaveBeenCalled();
    // The same key may be entered again; no new provider credential is required.
    await change(field(scenario.key, scenario.fieldIndex), scenario.expected);
    const result = await testAndSave(scenario);
    expect(result.apiBase).toBe("https://changed.example/v1");
    expect(result.apiKey).toBe(scenario.expected);
    const saved = await server.read();
    expect(assignedCatalogEndpointId(createModelWorkspace(saved), "byok", scenario.role)).not.toBe(oldId);
    expect(await server.writer.readEndpointApiKey!(oldProvider, oldId)).toBe(scenario.expected);
    expect(saved.catalog!.providers.find((provider) => provider.provider === oldProvider)!.endpoints.find((endpoint) => endpoint.endpointId === oldId)!.apiBase).toBe("https://provider.example/v1");
  });

  it.each(scenarios.filter((scenario) => scenario.role !== "asr"))("$role: model-only edits retain the key but invalidate the test", async (scenario) => {
    const oldId = assignedCatalogEndpointId(createModelWorkspace(await server.read()), "byok", scenario.role);
    await render(scenario.page());
    await change(field(scenario.model, scenario.fieldIndex), "changed-model");
    expect(container.textContent).toContain("apiKey.testStale");
    expect(field(scenario.key, scenario.fieldIndex).placeholder).toContain(scenario.expected.slice(-4));
    const tested = await testAndSave(scenario);
    expect(tested.apiKey).toBe(scenario.expected);
    expect(tested.modelId).toBe("changed-model");
    expect(assignedCatalogEndpointId(createModelWorkspace(await server.read()), "byok", scenario.role)).toBe(oldId);
  });

  it.each(scenarios)("$role: URL whitespace and trailing slash keep the saved credential usable", async (scenario) => {
    await render(scenario.page());
    await change(field(scenario.endpoint, scenario.fieldIndex), "  https://provider.example/v1///  ");
    expect(container.textContent).not.toContain("apiKey.credentialsChanged");
    expect((await testAndSave(scenario)).apiKey).toBe(scenario.expected);
  });

  it.each([0, 1])("role %i: same URL/model and identical masks do not imply reuse; toggling restores the independent key", async (index) => {
    await render(<ModelPage />);
    const checkbox = () => [...container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')][index]!;
    expect(checkbox().getAttribute("aria-checked")).toBe("false");
    const scenario = scenarios[index === 0 ? 5 : 4]!;
    await click(test(index));
    await vi.waitFor(() => expect(server.probe).toHaveBeenCalledTimes(1));
    expect(server.probe.mock.calls[0]![0].apiKey).toBe(scenario.expected);
    await click(checkbox());
    await click(checkbox());
    expect(checkbox().getAttribute("aria-checked")).toBe("false");
    expect(test(index).textContent).not.toBe("apiKey.testSuccess");
    expect((await testAndSave(scenario)).apiKey).toBe(scenario.expected);
  });
  // Deduplication is verified against the real file writer, not a catalog stub.
  it.each(scenarios)("$role: reentering the same trimmed key reuses the canonical saved endpoint", async (scenario) => {
    const before = await server.read();
    const oldId = assignedCatalogEndpointId(createModelWorkspace(before), "byok", scenario.role);
    await render(scenario.page());
    await change(field(scenario.key, scenario.fieldIndex), `  ${scenario.expected}  `);
    expect((await testAndSave(scenario)).apiKey).toBe(scenario.expected);
    const saved = await server.read();
    expect(assignedCatalogEndpointId(createModelWorkspace(saved), "byok", scenario.role)).toBe(oldId);
    expect(saved.catalog!.providers.flatMap((provider) => provider.endpoints)).toHaveLength(
      before.catalog!.providers.flatMap((provider) => provider.endpoints).length
    );
  });

  it.each(scenarios)("$role: replacing a key with an identical mask tests and saves the new key without overwriting the old one", async (scenario) => {
    const before = await server.read();
    const oldId = assignedCatalogEndpointId(createModelWorkspace(before), "byok", scenario.role)!;
    const provider = before.catalog!.providers.find((item) => item.endpoints.some((endpoint) => endpoint.endpointId === oldId))!.provider;
    const replacement = `sk-replacement-${scenario.expected.slice(-4)}`;
    await render(scenario.page());
    await change(field(scenario.key, scenario.fieldIndex), replacement);
    expect((await testAndSave(scenario)).apiKey).toBe(replacement);
    expect(assignedCatalogEndpointId(createModelWorkspace(await server.read()), "byok", scenario.role)).not.toBe(oldId);
    expect(await server.writer.readEndpointApiKey!(provider, oldId)).toBe(scenario.expected);
  });

  it.each([0, 1])("role %i: enabling reuse saves the inherited credential instead of the independent credential", async (index) => {
    await render(<ModelPage />);
    await click([...container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')][index]!);
    await click(next());
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "navigation/changed" })));
    expect(await server.key(index === 0 ? "memory_summary" : "memory_evolution")).toBe(index === 0 ? "sk-team-1111" : "sk-personal-1111");
  });

  it.each([0, 1])("role %i: disabling explicit follow copies the displayed inherited key and its actual source", async (index) => {
    server = await createServer(join(directory, "follow"), false);
    mocks.state = { ...createInitialAppState(), modelConfig: await server.read() };
    mocks.clients = { config: server.client } as AppClients;
    await render(<ModelPage />);
    const checkbox = [...container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')][index]!;
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    await click(checkbox);
    const scenario = { ...scenarios[index === 0 ? 5 : 4]!, index: 0, fieldIndex: 0 };
    expect(field("API Key").placeholder).toContain("1111");
    expect((await testAndSave(scenario)).apiKey).toBe("sk-personal-1111");
  });

  it.each(scenarios.filter((scenario) => ["agent", "image_generation", "memory_evolution", "memory_summary"].includes(scenario.role)))(
    "$role: changing provider and protocol requires an explicit key before testing and saving", async (scenario) => {
      await render(scenario.page());
      const comboIndex = scenario.fieldIndex ?? 0;
      await click([...container.querySelectorAll<HTMLButtonElement>('button[role="combobox"]')][comboIndex]!);
      // Select an actual different provider through the rendered control.
      const option = [...container.querySelectorAll<HTMLButtonElement>('button[role="option"]')].find((item) => item.getAttribute("aria-selected") === "false")!;
      await click(option);
      await change(field(scenario.model, scenario.fieldIndex), "changed-provider-model");
      // Same URL does not make credentials interchangeable across providers/protocols.
      await change(field(scenario.endpoint, scenario.fieldIndex), "https://provider.example/v1");
      expect(field(scenario.key, scenario.fieldIndex).placeholder).toBe("sk-...");
      expect(container.textContent).toContain("apiKey.credentialsChanged");
      await click(test(scenario.index));
      expect(server.probe).not.toHaveBeenCalled();
      await click(next());
      expect(server.write).not.toHaveBeenCalled();
      await change(field(scenario.key, scenario.fieldIndex), scenario.expected);
      expect((await testAndSave(scenario)).apiKey).toBe(scenario.expected);
    }
  );

  it("an explicitly fixed incomplete role is not silently changed to follow", async () => {
    mocks.state!.modelConfig.memmyMemory!.evolution = {
      mode: "fixed", provider: "openai", endpoint: "https://provider.example/v1",
      model: "", apiKey: "", apiKeyMasked: "", configured: false
    };
    await render(<ModelPage />);
    expect([...container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')][1]!.getAttribute("aria-checked")).toBe("false");
    expect(next().disabled).toBe(true);
  });

  it("a rejected independent key cannot fall back to the valid primary key or be saved", async () => {
    await render(<ModelPage />);
    server.probe.mockResolvedValueOnce({ ok: false, message: "rejected team key", checkedAt: "2026-10-16T00:00:00.000Z" });
    await click(test(1));
    await vi.waitFor(() => expect(container.textContent).toContain("rejected team key"));
    expect(server.probe.mock.calls[0]![0].apiKey).toBe("sk-team-1111");
    expect(next().disabled).toBe(true);
    expect(server.write).not.toHaveBeenCalled();
  });

  it("returning after Next hydrates the saved mask and tests the same persisted key", async () => {
    await render(<ApiKeyPage />);
    await change(field("apiKey.key"), "sk-new-onboarding-1111");
    await testAndSave(scenarios[0]!);
    await render(null);
    mocks.state = { ...createInitialAppState(), modelConfig: await server.read() };
    mocks.dispatch.mockClear();
    await render(<ApiKeyPage />);
    expect(field("apiKey.key").value).toBe("");
    expect(field("apiKey.key").placeholder).toContain("1111");
    expect((await testAndSave(scenarios[0]!)).apiKey).toBe("sk-new-onboarding-1111");
  });

  it("an old in-flight success cannot validate a changed connection", async () => {
    let finish!: (result: Awaited<ReturnType<typeof server.probe>>) => void;
    server.probe.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render(<ApiKeyPage />);
    await click(test(0));
    await vi.waitFor(() => expect(server.probe).toHaveBeenCalledTimes(1));
    await change(field("apiKey.endpoint"), "https://changed.example/v1");
    await act(async () => finish({ ok: true, message: "ok", checkedAt: "2026-10-16T00:00:00.000Z" }));
    expect(container.textContent).toContain("apiKey.credentialsChanged");
    expect(test(0).textContent).not.toBe("apiKey.testSuccess");
    expect(next().disabled).toBe(true);
    expect(server.write).not.toHaveBeenCalled();
  });

  it("retry after assignment-write failure reuses the newly saved key without duplicate connections", async () => {
    await render(<ApiKeyPage />);
    await change(field("apiKey.key"), "sk-retry-1111");
    await click(test(0));
    await vi.waitFor(() => expect(test(0).textContent).toBe("apiKey.testSuccess"));
    const persist = server.persistModelConfig;
    server.write.mockImplementationOnce(persist).mockRejectedValueOnce(new Error("assignment-write-failed"));
    await click(next());
    await vi.waitFor(() => expect(container.textContent).toContain("assignment-write-failed"));
    expect(mocks.dispatch).not.toHaveBeenCalled();
    const endpointsAfterCreate = (await server.read()).catalog!.providers.flatMap((provider) => provider.endpoints).length;
    await click(next());
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "navigation/changed" })));
    expect(await server.key("agent")).toBe("sk-retry-1111");
    expect((await server.read()).catalog!.providers.flatMap((provider) => provider.endpoints)).toHaveLength(endpointsAfterCreate);
  });

  async function openSettings(role: ModelCapability) {
    const config = await server.read();
    const workspace = createModelWorkspace(config);
    const id = assignedCatalogEndpointId(workspace, "byok", role);
    const index = workspace.spaces.byok.connections.findIndex((connection) => connection.endpointId === id);
    await render(<ModelWorkspaceSection mode="byok" seedConfig={config} configClient={server.client} />);
    await click(container.querySelectorAll<HTMLButtonElement>('[aria-label="settings.modelWorkspace.editConnection"]')[index]!);
  }
  function settingsSave() { return document.querySelector<HTMLButtonElement>('[aria-label="common.save"]')!; }
  function settingsTest() { return [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent === "settings.modelWorkspace.test" || button.textContent === "apiKey.testSuccess" || button.textContent === "apiKey.testRetry")!; }
  function modalField(label: string) {
    return [...document.querySelectorAll("label")].find((node) => node.textContent === label)!.parentElement!.querySelector("input")!;
  }

  it.each(scenarios.slice(0, 4))("settings $role: URL edit blocks the saved key; retest and save preserve other connections", async (scenario) => {
    const before = await server.read();
    const oldId = assignedCatalogEndpointId(createModelWorkspace(before), "byok", scenario.role)!;
    const others = before.catalog!.providers.flatMap((p) => p.endpoints).filter((e) => e.endpointId !== oldId);
    await openSettings(scenario.role);
    const beforeTest1 = server.probe.mock.calls.length;
    await click(settingsTest());
    await vi.waitFor(() => expect(server.probe.mock.calls.length).toBeGreaterThan(beforeTest1));
    await vi.waitFor(() => expect(document.body.textContent).toContain("settings.modelWorkspace.testSuccess"));
    expect(server.probe.mock.calls.at(-1)![0].apiKey).toBe(scenario.expected);
    await change(modalField("apiKey.endpoint"), "https://changed.example/v2");
    expect(document.body.textContent).toContain("apiKey.credentialsChanged");
    expect(modalField("apiKey.key").placeholder).toBe("sk-...");
    expect(settingsSave().disabled).toBe(true);
    const calls = server.probe.mock.calls.length;
    await click(settingsTest());
    await click(settingsSave());
    expect(server.probe).toHaveBeenCalledTimes(calls);
    expect(server.write).not.toHaveBeenCalled();
    await change(modalField("apiKey.key"), `  ${scenario.expected}  `);
    expect(settingsSave().disabled).toBe(true);
    const beforeTest2 = server.probe.mock.calls.length;
    await click(settingsTest());
    await vi.waitFor(() => expect(server.probe.mock.calls.length).toBeGreaterThan(beforeTest2));
    await vi.waitFor(() => expect(document.body.textContent).toContain("settings.modelWorkspace.testSuccess"));
    expect(server.probe.mock.calls.at(-1)![0]).toMatchObject({ apiKey: scenario.expected, apiBase: "https://changed.example/v2" });
    expect(settingsSave().disabled).toBe(false);
    await saveAndWaitForCatalog(settingsSave());
    await vi.waitFor(async () => {
      const config = await server.read();
      expect(config.catalog!.providers.flatMap((p) => p.endpoints).find((e) => e.endpointId === oldId)?.apiBase).toBe("https://changed.example/v2");
    });
    expect(await server.key(scenario.role)).toBe(scenario.expected);
    const saved = await server.read();
    expect(saved.catalog!.providers.flatMap((p) => p.endpoints).filter((e) => e.endpointId !== oldId)).toEqual(others);
    await render(null);
    await openSettings(scenario.role);
    expect(modalField("settings.modelWorkspace.replaceKey").value).toBe("");
    const beforeTest3 = server.probe.mock.calls.length;
    await click(settingsTest());
    await vi.waitFor(() => expect(server.probe.mock.calls.length).toBeGreaterThan(beforeTest3));
    await vi.waitFor(() => expect(document.body.textContent).toContain("settings.modelWorkspace.testSuccess"));
    expect(server.probe.mock.calls.at(-1)![0]).toMatchObject({ apiKey: scenario.expected, apiBase: "https://changed.example/v2" });
  });

  it("settings: normalized URL retains the key; a model-only edit requires retesting", async () => {
    await openSettings("agent");
    await click(settingsTest());
    await change(modalField("apiKey.endpoint"), "  https://provider.example/v1///  ");
    expect(modalField("settings.modelWorkspace.replaceKey").placeholder).toContain("1111");
    await click(document.querySelector<HTMLButtonElement>('[aria-label="settings.modelWorkspace.editModel"]')!);
    await change(modalField("apiKey.model"), "changed-model");
    expect(settingsSave().disabled).toBe(true);
    expect(document.body.textContent).toContain("apiKey.testStale");
    const beforeTest4 = server.probe.mock.calls.length;
    await click(settingsTest());
    await vi.waitFor(() => expect(server.probe.mock.calls.length).toBeGreaterThan(beforeTest4));
    await vi.waitFor(() => expect(document.body.textContent).toContain("settings.modelWorkspace.testSuccess"));
    expect(server.probe.mock.calls.at(-1)![0]).toMatchObject({ apiKey: "sk-personal-1111", modelId: "changed-model", apiBase: "https://provider.example/v1" });
    await saveAndWaitForCatalog(settingsSave());
    expect(await server.key("agent")).toBe("sk-personal-1111");
  });

  it.each(["address", "key", "model", "close"])("settings: a late success after %s changes cannot validate the editor", async (edit) => {
    await openSettings("agent");
    let finish!: (result: Awaited<ReturnType<typeof server.probe>>) => void;
    server.probe.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await click(settingsTest());
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    if (edit === "address") await change(modalField("apiKey.endpoint"), "https://changed.example/v2");
    if (edit === "key") await change(modalField("settings.modelWorkspace.replaceKey"), "sk-new-1111");
    if (edit === "model") {
      await click(document.querySelector<HTMLButtonElement>('[aria-label="settings.modelWorkspace.editModel"]')!);
      await change(modalField("apiKey.model"), "changed-model");
    }
    if (edit === "close") {
      await click(document.querySelector<HTMLButtonElement>('[aria-label="common.close"]')!);
      await openSettings("agent");
    }
    await act(async () => finish({ ok: true, message: "ok", checkedAt: "2026-10-16T00:00:00.000Z" }));
    expect(document.body.textContent).not.toContain("settings.modelWorkspace.testSuccess");
    if (edit !== "close") expect(settingsSave().disabled).toBe(true);
    expect(server.write).not.toHaveBeenCalled();
  });

  it.each(["model", "key", "reuse"])("roles: a late success after %s changes cannot validate the current credential", async (edit) => {
    let finish!: (result: Awaited<ReturnType<typeof server.probe>>) => void;
    server.probe.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render(<ModelPage />);
    await click(test(1));
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    if (edit === "model") await change(field("apiKey.model", 1), "changed-model");
    if (edit === "key") await change(field("API Key", 1), "sk-new-team-1111");
    if (edit === "reuse") {
      const checkbox = () => container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')[1]!;
      await click(checkbox());
      await click(checkbox());
    }
    await act(async () => finish({ ok: true, message: "ok", checkedAt: "2026-10-16T00:00:00.000Z" }));
    expect(test(1).textContent).not.toBe("apiKey.testSuccess");
    expect(next().disabled).toBe(true);
    expect(server.write).not.toHaveBeenCalled();
    await testAndSave(scenarios[4]!);
  });

  function deferProbe() {
    let finish!: (result: Awaited<ReturnType<typeof server.probe>>) => void;
    server.probe.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    return async (ok = true) => {
      await act(async () => finish({ ok, message: ok ? "ok" : "old request failed", checkedAt: "2026-10-17T00:00:00.000Z" }));
    };
  }

  it.each(scenarios.flatMap((scenario) =>
    ["success", "failure", "rejection"].flatMap((outcome) =>
      ["while-away", "new-pending", "new-succeeded"].map((timing) => ({ scenario, outcome, timing }))
    )
  ))("$scenario.role: leaving during a request isolates its $outcome ($timing) from reentry and save", async ({ scenario, outcome, timing }) => {
    let finishOld: () => Promise<void>;
    if (outcome === "rejection") {
      let rejectOld!: (error: Error) => void;
      server.probe.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
      finishOld = async () => { await act(async () => rejectOld(new Error("request from unmounted page rejected"))); };
    } else {
      const finish = deferProbe();
      finishOld = () => finish(outcome === "success");
    }
    const finishNew = deferProbe();
    await render(scenario.page());
    await change(field(scenario.key, scenario.fieldIndex), "sk-before-leaving-7777");
    await click(test(scenario.index));
    await vi.waitFor(() => expect(server.probe).toHaveBeenCalledTimes(1));
    expect(test(scenario.index).textContent).toBe("apiKey.testing");

    // Route departure unmounts the page, while the real client/server promise stays pending.
    await render(null);
    expect(container.childElementCount).toBe(0);
    if (timing === "while-away") await finishOld();
    expect(server.write).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    await render(scenario.page());
    expect(test(scenario.index).disabled).toBe(false);
    expect(test(scenario.index).textContent).toBe("apiKey.test");
    expect(field(scenario.key, scenario.fieldIndex).value).toBe("");
    expect(field(scenario.key, scenario.fieldIndex).placeholder).toContain(scenario.expected.slice(-4));

    await change(field(scenario.key, scenario.fieldIndex), "sk-after-reentry-9999");
    await click(next());
    expect(server.write).not.toHaveBeenCalled();
    await click(test(scenario.index));
    await vi.waitFor(() => expect(server.probe).toHaveBeenCalledTimes(2));
    expect(server.probe.mock.calls[0]![0].apiKey).toBe("sk-before-leaving-7777");
    expect(server.probe.mock.calls[1]![0].apiKey).toBe("sk-after-reentry-9999");
    if (timing === "new-pending") await finishOld();
    expect(test(scenario.index).textContent).toBe("apiKey.testing");
    expect(test(scenario.index).disabled).toBe(true);
    await click(next());
    expect(server.write).not.toHaveBeenCalled();
    await finishNew();
    if (timing === "new-succeeded") await finishOld();
    expect(test(scenario.index).textContent).toBe("apiKey.testSuccess");
    expect(next().disabled).toBe(false);
    expect(server.write).not.toHaveBeenCalled();
    await saveAndWaitForCatalog(next());
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "navigation/changed" })));
    expect(await server.key(scenario.role)).toBe("sk-after-reentry-9999");
  });

  it.each(scenarios.slice(0, 4))("onboarding $role: new success survives an older failure and saves the new key", async (scenario) => {
    const finishOld = deferProbe();
    const finishNew = deferProbe();
    await render(scenario.page());
    await click(test(scenario.index));
    await vi.waitFor(() => expect(server.probe).toHaveBeenCalledTimes(1));
    await change(field(scenario.endpoint), "https://changed.example/v1");
    // Exact review reproduction: validate the now-missing credential before re-entry.
    await click(test(scenario.index));
    expect(server.probe).toHaveBeenCalledTimes(1);
    await change(field(scenario.key), "sk-new-onboarding-9999");
    await click(test(scenario.index));
    await vi.waitFor(() => expect(server.probe).toHaveBeenCalledTimes(2));
    await finishNew();
    expect(test(scenario.index).textContent).toBe("apiKey.testSuccess");
    await finishOld(false);
    expect(test(scenario.index).textContent).toBe("apiKey.testSuccess");
    await saveAndWaitForCatalog(next());
    expect(await server.key(scenario.role)).toBe("sk-new-onboarding-9999");
  });

  it.each(scenarios.slice(0, 4).flatMap((scenario) =>
    ["old-first", "new-first-success", "new-first-rejection", "new-failure", "return-to-original"].map((order) => ({ scenario, order }))
  ))("onboarding $scenario.role: overlapping requests $order preserve the latest result", async ({ scenario, order }) => {
    let rejectOld!: (error: Error) => void;
    let finishOld: (ok?: boolean) => Promise<void>;
    if (order === "new-first-rejection") {
      server.probe.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
      finishOld = async () => { await act(async () => rejectOld(new Error("old transport failure"))); };
    } else finishOld = deferProbe();
    const finishNew = deferProbe();
    await render(scenario.page());
    await click(test(scenario.index));
    await vi.waitFor(() => expect(server.probe).toHaveBeenCalledTimes(1));
    await change(field(scenario.key), "sk-new-onboarding-9999");
    if (order === "return-to-original") await change(field(scenario.key), "");
    expect(test(scenario.index).disabled).toBe(false);
    expect(test(scenario.index).textContent).toBe("apiKey.test");
    await click(next());
    expect(server.write).not.toHaveBeenCalled();
    await click(test(scenario.index));
    await vi.waitFor(() => expect(server.probe).toHaveBeenCalledTimes(2));
    if (order === "old-first") {
      await finishOld();
      expect(test(scenario.index).textContent).toBe("apiKey.testing");
      expect(test(scenario.index).disabled).toBe(true);
      await finishNew();
    } else {
      await finishNew(order !== "new-failure");
      await finishOld();
    }
    if (order === "new-failure") {
      expect(test(scenario.index).textContent).toBe("apiKey.testRetry");
      await click(next());
      expect(server.write).not.toHaveBeenCalled();
      await testAndSave(scenario);
    } else {
      expect(test(scenario.index).textContent).toBe("apiKey.testSuccess");
      await saveAndWaitForCatalog(next());
    }
    expect(await server.key(scenario.role)).toBe(order === "return-to-original" ? scenario.expected : "sk-new-onboarding-9999");
  });

  it.each(scenarios.slice(0, 4).flatMap((scenario) =>
    (scenario.role === "asr" ? ["key"] : ["key", "model"]).map((edit) => ({ scenario, edit }))
  ))("onboarding $scenario.role: $edit edit unlocks retry before the old response", async ({ scenario, edit }) => {
    const finishOld = deferProbe();
    await render(scenario.page());
    await click(test(scenario.index));
    await vi.waitFor(() => expect(server.probe).toHaveBeenCalledTimes(1));
    await change(field(edit === "key" ? scenario.key : scenario.model), edit === "key" ? "sk-new-onboarding-9999" : "new-model");
    expect(test(scenario.index).disabled).toBe(false);
    await finishOld();
    expect(test(scenario.index).textContent).toBe("apiKey.test");
    await click(next());
    expect(server.write).not.toHaveBeenCalled();
    const tested = await testAndSave(scenario);
    expect(tested).toMatchObject(edit === "key" ? { apiKey: "sk-new-onboarding-9999" } : { modelId: "new-model" });
  });

  it.each(scenarios.slice(0, 4))("onboarding $role: visibility, normalized URL and other-card edits preserve the pending request", async (scenario) => {
    const finish = deferProbe();
    await render(scenario.page());
    await click(test(scenario.index));
    await vi.waitFor(() => expect(server.probe).toHaveBeenCalledTimes(1));
    await click(container.querySelectorAll<HTMLButtonElement>('[aria-label="apiKey.showKey"]')[scenario.index]!);
    await click(container.querySelector<HTMLButtonElement>('[aria-label="apiKey.hideKey"]')!);
    await change(field(scenario.endpoint), "  https://provider.example/v1///  ");
    const other = scenarios[(scenario.role === "agent" || scenario.role === "embedding" ? 0 : 2) + 1 - scenario.index]!;
    await change(field(other.key), "sk-independent-8888");
    expect(test(scenario.index).disabled).toBe(true);
    await finish();
    expect(test(scenario.index).textContent).toBe("apiKey.testSuccess");
    await testAndSave(other);
    expect(await server.key(scenario.role)).toBe(scenario.expected);
  });

  it.each([scenarios[0]!, scenarios[3]!])("onboarding $role: changing protocol during a request invalidates it and permits retry", async (scenario) => {
    const finishOld = deferProbe();
    await render(scenario.page());
    await click(test(scenario.index));
    await vi.waitFor(() => expect(server.probe).toHaveBeenCalledTimes(1));
    await click(container.querySelector<HTMLButtonElement>('button[role="combobox"]')!);
    await click([...container.querySelectorAll<HTMLButtonElement>('button[role="option"]')].find((item) => item.getAttribute("aria-selected") === "false")!);
    await change(field(scenario.model), "new-protocol-model");
    expect(test(scenario.index).disabled).toBe(false);
    await finishOld();
    expect(test(scenario.index).textContent).not.toBe("apiKey.testSuccess");
    await change(field(scenario.key), "sk-new-onboarding-9999");
    await testAndSave(scenario);
  });

  it("onboarding embedding: disabling and reenabling invalidates the pending request", async () => {
    const finish = deferProbe();
    await render(<ApiKeyPage />);
    await click(test(1));
    await vi.waitFor(() => expect(server.probe).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 2; i++) {
      await click(container.querySelectorAll<HTMLButtonElement>('button[role="combobox"]')[1]!);
      await click([...container.querySelectorAll<HTMLButtonElement>('button[role="option"]')].find((item) => item.getAttribute("aria-selected") === "false")!);
    }
    await finish();
    expect(test(1).textContent).toBe("apiKey.test");
    expect(next().disabled).toBe(true);
    await testAndSave(scenarios[1]!);
  });

  it.each([0, 1].flatMap((index) => ["model", "key"].map((edit) => ({ index, edit }))))(
    "role $index: editing $edit during a test unlocks retry and allows saving the new configuration",
    async ({ index, edit }) => {
      const finishOld = deferProbe();
      await render(<ModelPage />);
      await click(test(index));
      await vi.waitFor(() => expect(server.probe).toHaveBeenCalledTimes(1));
      expect(test(index).disabled).toBe(true);
      await change(field(edit === "model" ? "apiKey.model" : "API Key", index), edit === "model" ? "corrected-model" : "sk-corrected-9999");
      expect(test(index).disabled).toBe(false);
      expect(test(index).textContent).toBe("apiKey.test");
      expect(next().disabled).toBe(true);
      await finishOld();
      expect(test(index).disabled).toBe(false);
      expect(test(index).textContent).toBe("apiKey.test");
      const scenario = scenarios[index === 0 ? 5 : 4]!;
      const tested = await testAndSave(scenario);
      expect(tested).toMatchObject(edit === "model" ? { modelId: "corrected-model" } : { apiKey: "sk-corrected-9999" });
    }
  );

  it.each([0, 1])("role %i: showing and hiding a key does not invalidate a pending test", async (index) => {
    const finish = deferProbe();
    await render(<ModelPage />);
    await click(test(index));
    await vi.waitFor(() => expect(server.probe).toHaveBeenCalledTimes(1));
    await click(container.querySelectorAll<HTMLButtonElement>('[aria-label="apiKey.showKey"]')[index]!);
    await click(container.querySelector<HTMLButtonElement>('[aria-label="apiKey.hideKey"]')!);
    expect(test(index).disabled).toBe(true);
    await finish();
    expect(test(index).textContent).toBe("apiKey.testSuccess");
    expect(next().disabled).toBe(false);
    await saveAndWaitForCatalog(next());
  });

  it.each([0, 1])("role %i: editing the other independent card leaves this request valid", async (index) => {
    const finish = deferProbe();
    await render(<ModelPage />);
    await click(test(index));
    await vi.waitFor(() => expect(server.probe).toHaveBeenCalledTimes(1));
    await change(field("apiKey.model", 1 - index), "other-model");
    await finish();
    expect(test(index).textContent).toBe("apiKey.testSuccess");
    expect(next().disabled).toBe(true);
    await testAndSave(scenarios[index === 0 ? 4 : 5]!);
    expect(await server.key("memory_evolution")).toBe("sk-team-1111");
    expect(await server.key("memory_summary")).toBe("sk-summary-1111");
  });

  it.each(["old-first", "new-first", "return-to-original"])("roles: overlapping requests (%s) cannot overwrite the latest result", async (order) => {
    const finishOld = deferProbe();
    const finishNew = deferProbe();
    await render(<ModelPage />);
    await click(test(1));
    await vi.waitFor(() => expect(server.probe).toHaveBeenCalledTimes(1));
    await change(field("apiKey.model", 1), "new-model");
    if (order === "return-to-original") await change(field("apiKey.model", 1), "same-model");
    await click(test(1));
    await vi.waitFor(() => expect(server.probe).toHaveBeenCalledTimes(2));
    if (order === "old-first") {
      await finishOld();
      expect(test(1).textContent).toBe("apiKey.testing");
      expect(next().disabled).toBe(true);
      await finishNew();
    } else {
      await finishNew();
      await finishOld(false);
    }
    expect(test(1).textContent).toBe("apiKey.testSuccess");
    expect(next().disabled).toBe(false);
    await saveAndWaitForCatalog(next());
    expect(await server.key("memory_evolution")).toBe("sk-team-1111");
  });

  it("roles: upstream edits invalidate a following summary and recover after retesting", async () => {
    const finishOld = deferProbe();
    await render(<ModelPage />);
    await click(test(0));
    await vi.waitFor(() => expect(server.probe).toHaveBeenCalledTimes(1));
    await click(container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')[0]!);
    await change(field("API Key"), "sk-updated-team-9999");
    expect(next().disabled).toBe(true);
    await finishOld();
    expect(next().disabled).toBe(true);
    await testAndSave({ ...scenarios[4]!, index: 0, fieldIndex: 0 });
    expect(await server.key("memory_evolution")).toBe("sk-updated-team-9999");
    expect(await server.key("memory_summary")).toBe("sk-updated-team-9999");
  });

  it("follow chain: primary rotation flows through evolution and summary, while a fixed role keeps its own key", async () => {
    await render(<ModelPage />);
    await click(container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')[0]!);
    await click(container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')[1]!);
    await click(next());
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "navigation/changed" })));
    expect(await server.key("memory_evolution")).toBe("sk-personal-1111");
    expect(await server.key("memory_summary")).toBe("sk-personal-1111");
    await render(null);
    mocks.state!.modelConfig = await server.read();
    mocks.dispatch.mockClear();
    await render(<ApiKeyPage />);
    await change(field("apiKey.key"), "sk-rotated-9999");
    await testAndSave(scenarios[0]!);
    await render(null);
    mocks.state!.modelConfig = await server.read();
    await render(<ModelPage />);
    const boxes = () => container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]');
    expect([...boxes()].map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "true"]);
    await click(boxes()[1]!); // Copy the new primary into an independent evolution configuration.
    expect(field("API Key").placeholder).toContain("9999");
    await change(field("API Key"), "sk-chain-team-7777");
    expect(next().disabled).toBe(true);
    await testAndSave({ ...scenarios[4]!, index: 0, fieldIndex: 0 });
    expect(await server.key("agent")).toBe("sk-rotated-9999");
    expect(await server.key("memory_evolution")).toBe("sk-chain-team-7777");
    expect(await server.key("memory_summary")).toBe("sk-chain-team-7777");
    await render(null);
    mocks.state!.modelConfig = await server.read();
    await render(<ModelPage />);
    expect([...boxes()].map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    await click(boxes()[0]!);
    expect(field("API Key").placeholder).toContain("7777");
    expect((await testAndSave(scenarios[5]!)).apiKey).toBe("sk-chain-team-7777");
    expect(await server.key("agent")).toBe("sk-rotated-9999");
  });

  it("settings: changing provider cannot reuse a masked key", async () => {
    await openSettings("agent");
    await click(document.querySelector<HTMLButtonElement>('.model-connection-modal [role="combobox"]')!);
    await click([...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((b) => b.getAttribute("aria-selected") === "false")!);
    await change(modalField("apiKey.endpoint"), "https://provider.example/v1");
    expect(modalField("apiKey.key").placeholder).toBe("sk-...");
    await click(settingsTest());
    expect(server.probe).not.toHaveBeenCalled();
    expect(settingsSave().disabled).toBe(true);
  });

  it("shared endpoint: rotating the primary leaves fixed evolution and summary on their old saved key", async () => {
    const before = await server.read();
    const oldId = assignedCatalogEndpointId(createModelWorkspace(before), "byok", "agent")!;
    let workspace = createModelWorkspace(before);
    const shared = upsertByokPreset(workspace, { provider: before.provider, endpointId: oldId,
      endpoint: before.endpoint, protocol: "openai-chat-completions", model: "fixed-role-model",
      apiKeyMasked: before.apiKeyMasked, capabilities: ["memory_evolution", "memory_summary"] });
    workspace = assignCatalogPreset(shared.workspace, "byok", "memory_evolution", shared.presetId);
    workspace = assignCatalogPreset(workspace, "byok", "memory_summary", shared.presetId);
    await server.client.saveModelCatalog(modelConfigInput(workspace));
    mocks.state!.modelConfig = await server.read();
    await render(<ApiKeyPage />);
    await change(field("apiKey.key"), "sk-new-primary-8888");
    await testAndSave(scenarios[0]!);
    expect(await server.key("agent")).toBe("sk-new-primary-8888");
    expect(await server.key("memory_evolution")).toBe("sk-personal-1111");
    expect(await server.key("memory_summary")).toBe("sk-personal-1111");
    await render(null);
    mocks.state!.modelConfig = await server.read();
    await render(<ModelPage />);
    await click(test(0));
    await vi.waitFor(() => expect(server.probe.mock.calls.at(-1)![0].apiKey).toBe("sk-personal-1111"));
    expect(assignedCatalogEndpointId(createModelWorkspace(await server.read()), "byok", "memory_evolution")).toBe(oldId);
  });

  it("settings: protocol-only change on the same provider and address requires a key", async () => {
    await openSettings("agent");
    await click(document.querySelector<HTMLButtonElement>('[aria-label="settings.modelWorkspace.editModel"]')!);
    await click(document.querySelector<HTMLButtonElement>('.model-capability-select [role="combobox"], button.model-capability-select')!);
    await click([...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((b) => b.textContent?.includes("capability.embedding"))!);
    expect(modalField("apiKey.key").placeholder).toBe("sk-...");
    await click(settingsTest());
    expect(server.probe).not.toHaveBeenCalled();
    expect(settingsSave().disabled).toBe(true);
  });

});
