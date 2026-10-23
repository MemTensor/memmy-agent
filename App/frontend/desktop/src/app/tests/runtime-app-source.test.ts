/** Runtime app source tests. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyMainWindowRouteTarget } from "../../app.js";

describe("RuntimeApp bootstrap loading", () => {
  it("dispatches only the reconciled bootstrap into reducer", () => {
    const source = readFileSync(resolve(__dirname, "../..", "app.tsx"), "utf8");
    const calls = [...source.matchAll(/bootstrapLoaded\(([^)]*)\)/gu)].map((match) => match[1]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("effectiveBootstrap");
    expect(source).not.toContain("bootstrapLoaded(bootstrap");
  });

  it("includes machine-level guidance completion in initial window routing", () => {
    const source = readFileSync(resolve(__dirname, "../..", "app.tsx"), "utf8");

    expect(source).toContain("const guidanceCompleted = readGuidanceCompleted(");
    expect(source).toContain("accountSession,\n          guidanceCompleted,\n          modelConfig");
  });

  it("handles existing main-window route targets without reloading the renderer", () => {
    const source = readFileSync(resolve(__dirname, "../..", "app.tsx"), "utf8");

    expect(source).toContain("window.memmy.onRouteTargetRequest");
    expect(source).toContain("resolveMainWindowRouteTarget(rawTarget)");
    expect(source).toContain("focusMainWindowAgentChat(target.agentChatId, agentClient, dispatch, agentState);");
    expect(source).toContain("dispatch(appActions.navigate(target.route));");
    expect(source).toContain("window.history.replaceState(window.history.state");
    expect(source).toContain("FOCUSED_AGENT_CHAT_STORAGE_KEY");
    expect(source).not.toContain("window.location.reload");
    expect(source).not.toContain("window.location.href =");
  });

  it("localizes Agent scan errors with the current App language", () => {
    const source = readFileSync(resolve(__dirname, "../..", "app.tsx"), "utf8");

    expect(source).toContain("const translationRef = useRef(t);");
    expect(source).toContain("translationRef.current = t;");
    const completions = readFileSync(resolve(__dirname, "..", "use-scan-completions.ts"), "utf8");
    expect(source).toContain("useScanCompletions(clients?.agentSources ?? null, state.agentSources, dispatch, t)");
    expect(completions).toContain("formatScanCompletedError(completion.results, sources, latest.current.translate)");
    expect(completions).toContain("formatAgentSourceScanRequestError(error, undefined, latest.current.translate)");
  });

  it("reconciles scan status on heartbeat for active scans and unavailable services", () => {
    const source = readFileSync(resolve(__dirname, "../..", "app.tsx"), "utf8");

    expect(source).toContain("const isScanningRef = useRef(false);");
    expect(source).toContain("isScanningRef.current = state.agentSources.isScanning;");
    expect(source).toContain("events.addEventListener(\"app.heartbeat\", () => {");
    expect(source).toContain("if (isScanningRef.current || scanUnavailableRef.current || scanStateRef.current.scanProgress || scanStateRef.current.scanControl) {");
    expect(source).toContain("dispatch(appActions.agentSourceScanAvailability(status.unavailable ?? null));");
    expect(source).toContain("if (status.unavailable) return;");
    expect(source).toContain("void reconcileAgentSourceScanStatus(clients.agentSources);");
    expect(source).not.toContain("events.addEventListener(\"app.heartbeat\", () => dispatch(appActions.eventStatusChanged(\"heartbeat\")));");
  });

  it("keeps desktop update coordination above route-scoped content", () => {
    const appSource = readFileSync(resolve(__dirname, "../..", "app.tsx"), "utf8");
    const routerSource = readFileSync(resolve(__dirname, "..", "router.tsx"), "utf8");

    expect(appSource).toContain("<UpdateCoordinatorProvider>");
    expect(appSource).toContain("<AgentRuntimeBridge taskStateCoordinator={taskStateCoordinator ?? undefined}>");
    expect(appSource.indexOf("<UpdateCoordinatorProvider>")).toBeLessThan(appSource.indexOf("<AppRouter onRetry={retry} />"));
    expect(routerSource).toContain("<GlobalUpdateDialog");
    expect(routerSource).toContain("isPetWindowContext\n          || Boolean(petGuideRequest)");
    expect(routerSource).not.toContain("tokenModalOpen");
    expect(routerSource).toContain('|| workspaceGuidanceStep === "product_tour"');
    expect(routerSource).toContain('|| workspaceGuidanceStep === "nickname"');
  });

  it("loads the selected mini-list agent chat when restoring an existing main window", async () => {
    const dispatch = vi.fn();
    const client = {
      chatIdToSessionKey: vi.fn((chatId: string) => `websocket:${chatId}`),
      readWebuiThread: vi.fn(async (sessionKey: string) => ({
        schemaVersion: 1,
        sessionKey,
        messages: [{ role: "user", content: "hi" }]
      })),
      getSessionSnapshot: vi.fn(async () => ({
        projectRegistryState: "ready" as const,
        projects: [],
        sessions: [{
          key: "websocket:chat-2",
          title: "Chat 2",
          projectId: null,
          cwd: "/workspace"
        }]
      })),
      readSidebarState: vi.fn(async () => ({
        schema_version: 1 as const,
        pinned_keys: [],
        archived_keys: [],
        title_overrides: {},
        tags_by_key: {},
        collapsed_groups: {},
        view: {
          density: "comfortable" as const,
          show_previews: true,
          show_timestamps: true,
          show_archived: false,
          show_project_archived: false,
          sort: "updated_desc" as const
        },
        updated_at: null
      }))
    };

    applyMainWindowRouteTarget({ route: "/main", agentChatId: "chat-2" }, dispatch, client);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.readWebuiThread).toHaveBeenCalledWith("websocket:chat-2");
    expect(dispatch).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: "agent/historyLoading",
      chatId: "chat-2",
      sessionKey: "websocket:chat-2"
    }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "agent/historyLoaded",
      thread: expect.objectContaining({ sessionKey: "websocket:chat-2" })
    }));
    expect(dispatch).toHaveBeenCalledWith({ type: "navigation/changed", path: "/main" });
  });

  it("keeps route-target fetch failures local instead of marking the agent connection failed", async () => {
    const dispatch = vi.fn();
    const client = {
      chatIdToSessionKey: vi.fn((chatId: string) => `websocket:${chatId}`),
      readWebuiThread: vi.fn(async () => {
        throw new Error("Failed to fetch");
      }),
      getSessionSnapshot: vi.fn(async () => {
        throw new Error("Failed to fetch");
      }),
      readSidebarState: vi.fn(async () => ({
        schema_version: 1 as const,
        pinned_keys: [],
        archived_keys: [],
        title_overrides: {},
        tags_by_key: {},
        collapsed_groups: {},
        view: {
          density: "comfortable" as const,
          show_previews: true,
          show_timestamps: true,
          show_archived: false,
          show_project_archived: false,
          sort: "updated_desc" as const
        },
        updated_at: null
      }))
    };

    applyMainWindowRouteTarget({ route: "/main", agentChatId: "chat-2" }, dispatch, client);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "agent/historyOpenFailed",
      chatId: "chat-2"
    }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "agent/taskStateSettled",
      sidebarState: expect.objectContaining({ schema_version: 1 }),
      error: expect.objectContaining({ source: "sessions", message: "Failed to fetch" })
    }));
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "agent/connectionFailed" }));
  });
});
