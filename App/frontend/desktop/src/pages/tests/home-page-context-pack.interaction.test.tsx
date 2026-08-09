// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectContextPackOutput } from "@memmy/local-api-contracts";
import { AgentRuntimeBridge } from "../../app/agent-runtime-bridge.js";
import { AppProviders, useApiClients } from "../../app/providers.js";
import type { AppClients } from "../../api/client-types.js";
import { agentActions } from "../../state/app-actions.js";
import { useAppState } from "../../state/app-state.js";
import { HomePage } from "../home-page.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("HomePage project context pack session coverage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, value: createMemoryStorage() });
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: createMemoryStorage() });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("keeps the entry in running and historical project chats and closes it on project switch", async () => {
    const getProjectContextPack = vi.fn(async (projectId: string) => contextPack(projectId));

    await act(async () => {
      root.render(
        <AppProviders>
          <AgentRuntimeBridge>
            <SessionHarness getProjectContextPack={getProjectContextPack} />
            <HomePage />
          </AgentRuntimeBridge>
        </AppProviders>
      );
    });

    expect(contextPackTrigger()).not.toBeNull();
    await act(async () => contextPackTrigger()?.click());
    expect(getProjectContextPack).toHaveBeenLastCalledWith("project-running");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Running Project");

    await act(async () => switchButton("history").click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(contextPackTrigger()).not.toBeNull();

    await act(async () => switchButton("running").click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => switchButton("history").click());

    await act(async () => contextPackTrigger()?.click());
    expect(getProjectContextPack).toHaveBeenLastCalledWith("project-history");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("History Project");

    await act(async () => switchButton("standalone").click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(contextPackTrigger()).toBeNull();
  });
});

function SessionHarness(props: {
  getProjectContextPack: (projectId: string) => Promise<ProjectContextPackOutput>;
}) {
  const { dispatch } = useAppState();
  const { setClients } = useApiClients();

  useEffect(() => {
    setClients({ memoryRuntime: { getProjectContextPack: props.getProjectContextPack } } as unknown as AppClients);
    dispatch(agentActions.sessionSnapshotApplied({
      projectRegistryState: "ready",
      projects: [
        { id: "project-running", name: "Running Project", rootPath: "/running", pinned: false, createdAt: "2026-08-08T00:00:00.000Z" },
        { id: "project-history", name: "History Project", rootPath: "/history", pinned: false, createdAt: "2026-08-08T00:00:00.000Z" }
      ],
      sessions: [
        { key: "websocket:running", title: "Running", projectId: "project-running", cwd: "/running", run_started_at: 1 },
        { key: "websocket:history", title: "History", projectId: "project-history", cwd: "/history" },
        { key: "websocket:standalone", title: "Standalone", projectId: null, cwd: "/tmp" }
      ]
    }));
    openChat(dispatch, "running", false);
  }, [dispatch, props.getProjectContextPack, setClients]);

  return (
    <>
      <button type="button" data-switch="running" onClick={() => openChat(dispatch, "running", false)}>running</button>
      <button type="button" data-switch="history" onClick={() => openChat(dispatch, "history", true)}>history</button>
      <button type="button" data-switch="standalone" onClick={() => openChat(dispatch, "standalone", true)}>standalone</button>
    </>
  );
}

function openChat(dispatch: ReturnType<typeof useAppState>["dispatch"], chatId: string, closed: boolean) {
  const sessionKey = `websocket:${chatId}`;
  const requestId = `request-${chatId}`;
  dispatch(agentActions.historyLoading(sessionKey, chatId, requestId));
  dispatch(agentActions.historyLoaded({
    schemaVersion: 1,
    sessionKey,
    last_turn_closed: closed,
    messages: [
      { role: "user", content: `${chatId} question` },
      { role: "assistant", content: `${chatId} answer` }
    ]
  }, requestId));
}

function contextPackTrigger(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(".home-context-pack-trigger");
}

function switchButton(target: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`[data-switch="${target}"]`);
  if (!button) throw new Error(`Missing ${target} switch button`);
  return button;
}

function contextPack(projectId: string): ProjectContextPackOutput {
  return {
    namespace: { projectId },
    conventions: [],
    commands: [],
    architectureFacts: [],
    recentTasks: [{ id: `task-${projectId}`, title: projectId, updatedAt: "2026-08-08T12:00:00.000Z" }],
    userPreferences: [],
    graph: { nodes: [], edges: [] },
    markdown: `# Project Memory Pack: ${projectId}`,
    generatedAt: "2026-08-08T12:00:00.000Z"
  };
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  };
}
