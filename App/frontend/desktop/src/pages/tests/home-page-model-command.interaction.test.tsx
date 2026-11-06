// @vitest-environment happy-dom

import { webcrypto } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppClients } from "../../api/client-types.js";
import { AppProviders, useApiClients, type ApiClientsContextValue } from "../../app/providers.js";
import { agentActions, appActions } from "../../state/app-actions.js";
import { useAppState, type AppStateContextValue } from "../../state/app-state.js";
import { assignCatalogPreset, createModelWorkspace, upsertByokPreset } from "../../state/model-workspace.js";
import { HomePage } from "../home-page.js";
import { mockBootstrap } from "./fixtures/bootstrap.js";

const runtime = vi.hoisted(() => ({
  connection: {
    getReadyGeneration: vi.fn(() => 1),
    submitMessage: vi.fn(() => Promise.resolve()),
    onStatusResult: vi.fn(() => () => undefined),
    onHistoryDagResult: vi.fn(() => () => undefined),
    onChat: vi.fn(() => () => undefined)
  },
  ensureChatSubscription: vi.fn(),
  taskStateCoordinator: { refreshTaskState: vi.fn() }
}));

vi.mock("../../app/agent-runtime-bridge.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../app/agent-runtime-bridge.js")>(),
  useAgentRuntimeBridge: () => runtime
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HASH_PRESET = "memmy-account-db8cf6de6ab1-agent";
const CHAT_ID = "model-command-test";

describe("HomePage model command keyboard submission", () => {
  let root: Root;
  let app: AppStateContextValue;
  let api: ApiClientsContextValue;

  function ObserveContexts() {
    app = useAppState();
    api = useApiClients();
    return null;
  }

  beforeEach(async () => {
    vi.stubGlobal("crypto", webcrypto);
    vi.clearAllMocks();
    Object.defineProperty(window, "localStorage", { configurable: true, value: createMemoryStorage() });
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: createMemoryStorage() });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const preset = upsertByokPreset(createModelWorkspace(), {
      presetId: HASH_PRESET,
      provider: "openai",
      endpoint: "https://model.example.test/v1",
      protocol: "openai-chat-completions",
      model: "test-model",
      capabilities: ["agent"]
    });
    const workspace = assignCatalogPreset(preset.workspace, "byok", "agent", preset.presetId);
    const clients = {
      runtimeConfig: {},
      memmyAgent: {
        listSlashCommands: vi.fn().mockResolvedValue([
          { command: "/model", title: "Model", description: "Show or switch model", icon: "brain", argHint: "[list|preset]" }
        ]),
        readWorkspaceEnvironment: vi.fn().mockResolvedValue(null)
      }
    } as unknown as AppClients;

    await act(async () => root.render(<AppProviders><ObserveContexts /><HomePage /></AppProviders>));
    await act(async () => {
      api.setClients(clients);
      app.dispatch(appActions.bootstrapLoaded({ ...mockBootstrap, app: { ...mockBootstrap.app, userMode: "byok" } }, "/main"));
      app.dispatch(appActions.modelConfigUpdated({ catalog: workspace.catalog }));
      app.dispatch(agentActions.modelCatalogLoaded([
        { name: HASH_PRESET, provider: "openai", model: "test-model", is_default: true, available: true }
      ], HASH_PRESET));
      app.dispatch(agentActions.newChatCreated(CHAT_ID));
      app.dispatch(agentActions.wsEventReceived({ event: "ready", connection_generation: 1 }));
      app.dispatch(agentActions.recoveryFinished(1));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it.each(["/model", "/model list"])("sends exact %s on the first Enter", async (command) => {
    setDraft(command);
    const options = [...document.querySelectorAll('[role="option"]')];
    expect(options.map((option) => option.querySelector(".font-mono")?.textContent))
      .toEqual(command === "/model" ? ["/model list", "/model"] : ["/model list"]);
    expect(document.querySelector('[role="listbox"]')?.textContent).not.toContain(HASH_PRESET);

    await pressKey("Enter");

    expect(runtime.connection.submitMessage).toHaveBeenCalledOnce();
    expect(runtime.connection.submitMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: CHAT_ID, content: command }),
      1
    );
    expect(composer().value).toBe("");
  });

  it("keeps Tab as completion without submitting", async () => {
    setDraft("/model");

    await pressKey("Tab");

    expect(runtime.connection.submitMessage).not.toHaveBeenCalled();
    expect(composer().value).toBe("/model");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it("completes a model prefix before submitting it", async () => {
    setDraft("/mod");

    await pressKey("Enter");

    expect(runtime.connection.submitMessage).not.toHaveBeenCalled();
    expect(composer().value).toBe("/model");
    await pressKey("Enter");
    expect(runtime.connection.submitMessage).toHaveBeenCalledOnce();
    expect(runtime.connection.submitMessage).toHaveBeenCalledWith(expect.objectContaining({ content: "/model" }), 1);
  });

  it.each([`/model ${HASH_PRESET}`, "/model test-model"])("submits the manually entered command %s", async (command) => {
    setDraft(command);
    expect(document.querySelector('[role="listbox"]')).toBeNull();

    await pressKey("Enter");

    expect(runtime.connection.submitMessage).toHaveBeenCalledOnce();
    expect(runtime.connection.submitMessage).toHaveBeenCalledWith(expect.objectContaining({ content: command }), 1);
  });

  function setDraft(value: string) {
    const input = composer();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(composer().value).toBe(value);
  }
});

function composer(): HTMLTextAreaElement {
  const input = document.querySelector<HTMLTextAreaElement>(".agent-composer-shell textarea");
  if (!input) throw new Error("Missing model command composer");
  return input;
}

async function pressKey(key: string) {
  await act(async () => composer().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  };
}
