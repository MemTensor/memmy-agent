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
    expect(source).toContain("accountSession,\n          guidanceCompleted");
  });

  it("handles existing main-window route targets without reloading the renderer", () => {
    const source = readFileSync(resolve(__dirname, "../..", "app.tsx"), "utf8");

    expect(source).toContain("window.memmy.onRouteTargetRequest");
    expect(source).toContain("resolveMainWindowRouteTarget(rawTarget)");
    expect(source).toContain("focusMainWindowAgentChat(target.agentChatId, agentClient, dispatch);");
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
    expect(source).toContain("formatScanCompletedError(scanResults, nextSources, translationRef.current)");
    expect(source).toContain("formatAgentSourceScanRequestError(error, undefined, translationRef.current)");
  });

  it("keeps desktop update coordination above route-scoped content", () => {
    const appSource = readFileSync(resolve(__dirname, "../..", "app.tsx"), "utf8");
    const routerSource = readFileSync(resolve(__dirname, "..", "router.tsx"), "utf8");

    expect(appSource).toContain("<UpdateCoordinatorProvider>");
    expect(appSource).toContain("<AgentRuntimeBridge>");
    expect(appSource.indexOf("<UpdateCoordinatorProvider>")).toBeLessThan(appSource.indexOf("<AppRouter onRetry={retry} />"));
    expect(routerSource).toContain("<GlobalUpdateDialog");
    expect(routerSource).toContain("suspended={isPetWindowContext || Boolean(petGuideRequest) || tokenModalOpen}");
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
      listSessions: vi.fn(async () => [{ key: "websocket:chat-2", title: "Chat 2" }]),
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
      listSessions: vi.fn(async () => {
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
          sort: "updated_desc" as const
        },
        updated_at: null
      }))
    };

    applyMainWindowRouteTarget({ route: "/main", agentChatId: "chat-2" }, dispatch, client);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "agent/historyOpenMissing",
      chatId: "chat-2",
      sessionKey: "websocket:chat-2"
    }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "agent/sessionsLoadFailed" }));
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "agent/error" }));
  });
});
