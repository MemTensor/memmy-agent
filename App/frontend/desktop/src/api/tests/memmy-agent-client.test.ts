import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatIdToSessionKey,
  createMemmyAgentClient,
  DEFAULT_MEMMY_AGENT_WEBUI_BASE_URL,
  defaultMemmyAgentBaseUrl,
  MemmyAgentMessageRejectedError,
  sessionKeyToChatId,
  type MemmyAgentClient,
  type MemmyAgentSidebarState,
  type MemmyAgentWsEvent,
  type WebSocketLike
} from "../memmy-agent-client.js";

const bootstrap = {
  token: "agent-token",
  ws_path: "/ws",
  expires_in: 3600,
  model_name: "gpt-4.1"
};

const modelSelectionWire = {
  preset_id: "desktop-openai-gpt-5",
  provider: "openai",
  endpoint_id: "chat",
  protocol: "openai-chat-completions",
  model: "gpt-5",
  source: "byok",
  owner_account_id: null,
  capabilities: ["agent"]
};

const modelSelection = {
  presetId: "desktop-openai-gpt-5",
  provider: "openai",
  endpointId: "chat",
  protocol: "openai-chat-completions",
  model: "gpt-5",
  source: "byok",
  ownerAccountId: null,
  capabilities: ["agent"]
};

const sidebarState: MemmyAgentSidebarState = {
  schema_version: 1,
  pinned_keys: [],
  archived_keys: [],
  title_overrides: {},
  tags_by_key: {},
  collapsed_groups: {},
  view: {
    density: "comfortable",
    show_previews: true,
    show_timestamps: false,
    show_archived: false,
    show_project_archived: false,
    sort: "updated_desc"
  },
  updated_at: null
};

const goalId = "8f59f58a-7295-4c34-8e03-55e7035a5a8d";

function goalState(status: "active" | "paused" | "completed" = "active") {
  return {
    goal_id: goalId,
    status,
    objective: "整理 PRD",
    token_budget: 12_000,
    tokens_used: 500,
    time_used_seconds: 30,
    created_at: "2026-08-04T08:00:00.000Z",
    updated_at: "2026-08-04T08:00:30.000Z"
  } as const;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("memmy-agent client", () => {
  it("reads the workspace snapshot, changed files, and a selected diff", async () => {
    const calls: string[] = [];
    const workspaceState = (project: boolean, branch = "zy_git_v1.0.7") => ({
      snapshot: {
        scope_kind: project ? "project" : "session",
        scope_key: project ? "project-1" : "websocket:chat-1",
        cwd: "/workspace",
        status: "ready",
        revision: `rev-${branch}`,
        captured_at: "2026-08-11T08:00:00.000Z",
        repository: {
          display_name: "memmy-agent",
          root: "/workspace",
          head_sha: "84d10f8",
          branch,
          detached: false,
          upstream: null,
          ahead: 0,
          behind: 0,
          worktree: "dirty"
        },
        changes: { file_count: 1, additions: 8, deletions: 1, conflicts: 0, staged: 0, unstaged: 1, untracked: 0 },
        goal: null
      },
      files: [{
        path: "src/panel.tsx",
        status: ".M",
        staged: false,
        unstaged: true,
        untracked: false,
        conflict: false,
        additions: 8,
        deletions: 1,
        attribution: "goal"
      }],
      branches: ["zy_git_v1.0.7", "main"]
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/webui/bootstrap") return json(bootstrap);
      if (url.pathname.endsWith("/environment/branch")) {
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body));
        if (body.create === true) {
          expect(body).toEqual({ branch: "feature/new", expected_revision: "rev-main", create: true });
          return json(workspaceState(url.pathname.includes("/projects/"), "feature/new"));
        }
        expect(body).toEqual({ branch: "main", expected_revision: "rev-zy_git_v1.0.7" });
        return json(workspaceState(url.pathname.includes("/projects/"), "main"));
      }
      if (url.pathname.endsWith("/environment/diff")) {
        expect(url.searchParams.get("path")).toBe("src/panel.tsx");
        return json({ path: "src/panel.tsx", diff: "+panel", truncated: false, unavailable_reason: null });
      }
      if (url.pathname.endsWith("/environment")) {
        return json(workspaceState(url.pathname.includes("/projects/")));
      }
      return json({ error: "not found" }, 404);
    });
    const client = createMemmyAgentClient({
      baseUrl: "http://127.0.0.1:18980",
      fetchFn: fetchMock as typeof fetch
    });

    await expect(client.readWorkspaceEnvironment({ kind: "session", key: "websocket:chat-1" })).resolves.toMatchObject({
      snapshot: {
        repository: { branch: "zy_git_v1.0.7" },
        changes: { file_count: 1 }
      },
      files: [{ path: "src/panel.tsx", attribution: "goal" }]
    });
    await expect(client.readWorkspaceEnvironmentDiff({ kind: "session", key: "websocket:chat-1" }, "src/panel.tsx")).resolves.toMatchObject({
      diff: "+panel"
    });
    await expect(client.readWorkspaceEnvironment({ kind: "project", key: "project-1" })).resolves.toMatchObject({
      snapshot: { repository: { branch: "zy_git_v1.0.7" } },
      files: [{ path: "src/panel.tsx" }],
      branches: ["zy_git_v1.0.7", "main"]
    });
    await expect(client.readWorkspaceEnvironmentDiff({ kind: "project", key: "project-1" }, "src/panel.tsx")).resolves.toMatchObject({
      diff: "+panel"
    });
    await expect(client.switchWorkspaceEnvironmentBranch(
      { kind: "project", key: "project-1" },
      "main",
      "rev-zy_git_v1.0.7"
    )).resolves.toMatchObject({ snapshot: { repository: { branch: "main" } } });
    await expect(client.createOrCheckoutWorkspaceEnvironmentBranch(
      { kind: "project", key: "project-1" },
      "feature/new",
      "rev-main"
    )).resolves.toMatchObject({ snapshot: { repository: { branch: "feature/new" } } });
    expect(calls).toContain("/api/sessions/websocket%3Achat-1/environment/diff?path=src%2Fpanel.tsx");
    expect(calls).toContain("/api/projects/project-1/environment");
    expect(calls).toContain("/api/projects/project-1/environment/diff?path=src%2Fpanel.tsx");
    expect(calls).toContain("/api/projects/project-1/environment/branch");
  });

  it("loads session workspace files lazily", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/webui/bootstrap") return json(bootstrap);
      if (url.pathname.endsWith("/workspace/files")) {
        return json({
          root: { kind: "project", label: "Memmy" },
          path: url.searchParams.get("path") ?? "",
          entries: [{
            name: "index.ts",
            path: "src/index.ts",
            kind: "file",
            size: 12,
            modifiedAt: "2026-08-25T08:00:00.000Z"
          }],
          truncated: false
        });
      }
      return json({ error: "not found" }, 404);
    });
    const client = createMemmyAgentClient({
      baseUrl: "http://127.0.0.1:18980",
      fetchFn: fetchMock as typeof fetch
    });

    await expect(client.listWorkspaceFiles("websocket:chat-1", "src")).resolves.toMatchObject({
      root: { kind: "project", label: "Memmy" },
      path: "src",
      entries: [{
        name: "index.ts",
        path: "src/index.ts",
        kind: "file"
      }]
    });
    expect(calls).toContain("/api/sessions/websocket%3Achat-1/workspace/files?path=src");
  });

  it("prefers env override, then current origin, then local gateway default for base URL", () => {
    vi.stubEnv("VITE_MEMMY_AGENT_WEBUI_URL", "http://127.0.0.1:19000");
    expect(defaultMemmyAgentBaseUrl()).toBe("http://127.0.0.1:19000");

    vi.stubEnv("VITE_MEMMY_AGENT_WEBUI_URL", "");
    vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:5174" } });
    expect(defaultMemmyAgentBaseUrl()).toBe("http://127.0.0.1:5174");

    vi.stubGlobal("window", undefined);
    expect(defaultMemmyAgentBaseUrl()).toBe(DEFAULT_MEMMY_AGENT_WEBUI_BASE_URL);
  });

  it("bootstraps with optional secret and uses bearer token for REST snapshots", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/webui/bootstrap") {
        expect(init?.headers).toEqual({ "X-Memmy-Agent-Auth": "bootstrap-secret" });
        return json(bootstrap);
      }
      if (url.pathname === "/api/sessions") {
        expect(init?.headers).toEqual({ Authorization: "Bearer agent-token" });
        return json({
          projectRegistryState: "ready",
          projects: [],
          sessions: [
            {
              key: "websocket:chat-1",
              title: "创建 AI 电商助手",
              preview: "继续拆解需求",
              updatedAt: "2026-06-06T08:00:00.000Z",
              run_started_at: 1780732800,
              projectId: null,
              cwd: "/Users/yuan/.memmy/workspace",
              model_selection: modelSelectionWire
            }
          ]
        });
      }
      return json({ error: "not found" }, 404);
    });

    const client = createMemmyAgentClient({
      baseUrl: "http://127.0.0.1:18980",
      bootstrapSecret: "bootstrap-secret",
      clientId: "frontend-test",
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: () => new FakeSocket("ws://unused")
    });

    await expect(client.listSessions()).resolves.toEqual([
      expect.objectContaining({ model_selection: modelSelection })
    ]);
    await expect(client.bootstrap()).resolves.toEqual(bootstrap);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes bootstrap token before expiry for HTTP requests", async () => {
    vi.useFakeTimers();
    const baseTime = new Date("2026-06-17T00:00:00.000Z");
    vi.setSystemTime(baseTime);
    const bootstrapTokens = ["token-a", "token-b"];
    let bootstrapIndex = 0;
    const sessionAuthHeaders: Array<string | undefined> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/webui/bootstrap") {
        const token = bootstrapTokens[bootstrapIndex] ?? "token-extra";
        bootstrapIndex += 1;
        return json({ ...bootstrap, token, expires_in: 60 });
      }
      if (url.pathname === "/api/sessions") {
        sessionAuthHeaders.push(authHeader(init));
        return json({ projectRegistryState: "ready", projects: [], sessions: [] });
      }
      return json({ error: "not found" }, 404);
    });
    const client = createMemmyAgentClient({
      baseUrl: "http://127.0.0.1:18980",
      clientId: "frontend-test",
      fetchFn: fetchMock as typeof fetch
    });

    await expect(client.listSessions()).resolves.toEqual([]);
    vi.setSystemTime(new Date(baseTime.getTime() + 29_000));
    await expect(client.listSessions()).resolves.toEqual([]);
    vi.setSystemTime(new Date(baseTime.getTime() + 31_000));
    await expect(client.listSessions()).resolves.toEqual([]);

    expect(sessionAuthHeaders).toEqual([
      "Bearer token-a",
      "Bearer token-a",
      "Bearer token-b"
    ]);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/webui/bootstrap",
      "/api/sessions",
      "/api/sessions",
      "/webui/bootstrap",
      "/api/sessions"
    ]);
  });

  it("retries authenticated request once after 401 with forced bootstrap", async () => {
    let bootstrapIndex = 0;
    const calls: Array<{ path: string; auth: string | undefined }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ path: url.pathname, auth: authHeader(init) });
      if (url.pathname === "/webui/bootstrap") {
        const token = bootstrapIndex === 0 ? "token-old" : "token-new";
        bootstrapIndex += 1;
        return json({ ...bootstrap, token });
      }
      if (url.pathname === "/api/webui/artifacts/open") {
        return authHeader(init) === "Bearer token-old"
          ? json({ error: "expired" }, 401)
          : json({ ok: true, path: "/Users/yuan/result.png" });
      }
      return json({ error: "not found" }, 404);
    });
    const client = createMemmyAgentClient({
      baseUrl: "http://127.0.0.1:18980",
      clientId: "frontend-test",
      fetchFn: fetchMock as typeof fetch
    });

    await expect(client.openArtifact("/Users/yuan/result.png", "websocket:chat-1")).resolves.toBeUndefined();
    expect(calls).toEqual([
      { path: "/webui/bootstrap", auth: undefined },
      { path: "/api/webui/artifacts/open", auth: "Bearer token-old" },
      { path: "/webui/bootstrap", auth: undefined },
      { path: "/api/webui/artifacts/open", auth: "Bearer token-new" }
    ]);
  });

  it("does not retry non-401 responses", async () => {
    const paths: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === "/webui/bootstrap") {
        return json(bootstrap);
      }
      if (url.pathname === "/api/webui/artifacts/resolve") {
        return json({ error: "missing" }, 404);
      }
      return json({ error: "not found" }, 404);
    });
    const client = createMemmyAgentClient({
      baseUrl: "http://127.0.0.1:18980",
      clientId: "frontend-test",
      fetchFn: fetchMock as typeof fetch
    });

    await expect(client.resolveArtifact("/Users/yuan/missing.png", "websocket:chat-1")).rejects.toMatchObject({ status: 404 });
    expect(paths).toEqual([
      "/webui/bootstrap",
      "/api/webui/artifacts/resolve"
    ]);
  });

  it("does not recurse when bootstrap itself is unauthorized", async () => {
    const paths: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      return url.pathname === "/webui/bootstrap"
        ? json({ error: "unauthorized" }, 401)
        : json({ projectRegistryState: "ready", projects: [], sessions: [] });
    });
    const client = createMemmyAgentClient({
      baseUrl: "http://127.0.0.1:18980",
      clientId: "frontend-test",
      fetchFn: fetchMock as typeof fetch
    });

    await expect(client.listSessions()).rejects.toMatchObject({ status: 401 });
    expect(paths).toEqual(["/webui/bootstrap"]);
  });

  it("lists slash commands with bearer token, camelCase mapping, goal exposure, and control-command filtering", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/webui/bootstrap") {
        return json(bootstrap);
      }
      if (url.pathname === "/api/commands") {
        expect(init?.headers).toEqual({ Authorization: "Bearer agent-token" });
        return json({
          commands: [
            { command: "/stop", title: "Stop", description: "Stop turn", icon: "square", arg_hint: "" },
            { command: "/restart", title: "Restart", description: "Restart agent", icon: "rotate-cw", arg_hint: "" },
            { command: "/dream", title: "Dream", description: "Run Dream", icon: "sparkles", arg_hint: "" },
            { command: "/dream-log", title: "Dream log", description: "Show Dream log", icon: "book-open", arg_hint: "" },
            { command: "/dream-restore", title: "Dream restore", description: "Restore Dream", icon: "undo-2", arg_hint: "" },
            { command: "/history", title: "History", description: "Show history", icon: "history", arg_hint: "[n]" },
            { command: "/goal", title: "Goal", description: "Start goal", icon: "activity", arg_hint: "<goal>" },
            { command: "/pairing", title: "Pairing", description: "Manage pairing", icon: "shield", arg_hint: "" },
            { command: "/help", title: "Help", description: "Show help", icon: "circle-help", arg_hint: "" },
            { command: "/status", title: "Status", description: "Show status", icon: "activity", arg_hint: "" },
            { command: "/new", title: "New", description: "New chat", icon: "square-pen", arg_hint: "" },
            { command: "/model", title: "Model", description: "Switch model", icon: "brain", arg_hint: "[preset]" }
          ]
        });
      }
      return json({ error: "not found" }, 404);
    });
    const client = createMemmyAgentClient({ baseUrl: "http://127.0.0.1:18980", clientId: "frontend-test", fetchFn: fetchMock as typeof fetch });

    await expect(client.listSlashCommands()).resolves.toEqual([
      { command: "/goal", title: "Goal", description: "Start goal", icon: "activity", argHint: "<goal>" },
      { command: "/status", title: "Status", description: "Show status", icon: "activity", argHint: "" },
      { command: "/new", title: "New", description: "New chat", icon: "square-pen", argHint: "" }
    ]);
  });

  it("writes complete sidebar-state and encodes session keys in REST paths", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/webui/bootstrap") {
        return json(bootstrap);
      }
      if (url.pathname === "/api/webui/sidebar-state/update") {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          base_updated_at: sidebarState.updated_at,
          state: {
            schema_version: 1,
            view: { show_previews: true }
          }
        });
        return json(sidebarState);
      }
      if (url.pathname === "/api/sessions/websocket%3Achat-1/webui-thread") {
        return json({
          schemaVersion: 1,
          sessionKey: "websocket:chat-1",
          messages: [
            {
              role: "assistant",
              content: "deck ready",
              media: [{ kind: "file", name: "deck.pptx", path: "/Users/yuan/deck.pptx", url: "/api/media/signed" }]
            }
          ]
        });
      }
      if (url.pathname === "/api/sessions/websocket%3Achat-1/last-compaction") {
        return json({
          available: true,
          sessionKey: "websocket:chat-1",
          mode: "dag",
          text: "DAG snapshot summary",
          lastActive: "2026-07-08T08:00:00.000Z",
          dagSnapshotId: "snapshot-1"
        });
      }
      if (url.pathname === "/api/sessions/websocket%3Achat-1/title") {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer agent-token" });
        expect(JSON.parse(String(init?.body))).toEqual({ title: "重命名任务" });
        return json({
          session: {
            key: "websocket:chat-1",
            title: "重命名任务",
            preview: "继续拆解需求",
            updatedAt: "2026-06-06T08:30:00.000Z",
            projectId: null,
            cwd: "/Users/yuan/.memmy/workspace"
          }
        });
      }
      if (url.pathname === "/api/sessions/websocket%3Achat-1/delete") {
        return json({ deleted: true });
      }
      return json({ error: "not found" }, 404);
    });
    const client = createMemmyAgentClient({ baseUrl: "http://127.0.0.1:18980", clientId: "frontend-test", fetchFn: fetchMock as typeof fetch });

    await expect(client.writeSidebarState(sidebarState.updated_at, sidebarState)).resolves.toEqual(sidebarState);
    await expect(client.readWebuiThread("websocket:chat-1")).resolves.toMatchObject({
      sessionKey: "websocket:chat-1",
      messages: [
        {
          media: [{ kind: "file", name: "deck.pptx", path: "/Users/yuan/deck.pptx", url: "http://127.0.0.1:18980/api/media/signed" }]
        }
      ]
    });
    await expect(client.readLastCompaction("websocket:chat-1")).resolves.toEqual({
      available: true,
      sessionKey: "websocket:chat-1",
      mode: "dag",
      text: "DAG snapshot summary",
      lastActive: "2026-07-08T08:00:00.000Z",
      dagSnapshotId: "snapshot-1"
    });
    await expect(client.renameSession("websocket:chat-1", "重命名任务")).resolves.toMatchObject({
      key: "websocket:chat-1",
      title: "重命名任务",
      preview: "继续拆解需求"
    });
    await expect(client.deleteSession("websocket:chat-1")).resolves.toBe(true);
  });

  it("normalizes gateway media URLs in webui-thread snapshots without rewriting unrelated fields", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/webui/bootstrap") {
        return json(bootstrap);
      }
      if (url.pathname === "/api/sessions/websocket%3Achat-media/webui-thread") {
        return json({
          schemaVersion: 3,
          sessionKey: "websocket:chat-media",
          messages: [
            {
              role: "user",
              content: "look at this",
              images: [
                { url: "/api/media/sig-1/payload-1", name: "snap.png" },
                { url: "https://cdn.example.com/diag.jpg", name: "diag.jpg" }
              ],
              media: [
                { kind: "image", url: "/api/media/sig-1/payload-1", name: "snap.png" },
                { kind: "file", path: "/Users/yuan/report.xlsx", url: "/api/media/sig-2/payload-2", name: "report.xlsx" }
              ],
              path: "/Users/yuan/report.xlsx",
              ws_path: "/ws",
              data_url: "data:image/png;base64,AAAA"
            },
            {
              role: "assistant",
              content: "![Diagram](/api/media/sig-3/payload-3) [Deck](</api/media/sig-4/payload-4>) [Local](/Users/yuan/local.png) [Api](/api/sessions)"
            }
          ]
        });
      }
      return json({ error: "not found" }, 404);
    });
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: fetchMock as typeof fetch
    });

    await expect(client.readWebuiThread("websocket:chat-media")).resolves.toMatchObject({
      sessionKey: "websocket:chat-media",
      messages: [
        {
          images: [
            { url: "https://agent.local:18980/api/media/sig-1/payload-1", name: "snap.png" },
            { url: "https://cdn.example.com/diag.jpg", name: "diag.jpg" }
          ],
          media: [
            { kind: "image", url: "https://agent.local:18980/api/media/sig-1/payload-1", name: "snap.png" },
            { kind: "file", path: "/Users/yuan/report.xlsx", url: "https://agent.local:18980/api/media/sig-2/payload-2", name: "report.xlsx" }
          ],
          path: "/Users/yuan/report.xlsx",
          ws_path: "/ws",
          data_url: "data:image/png;base64,AAAA"
        },
        {
          content: "![Diagram](https://agent.local:18980/api/media/sig-3/payload-3) [Deck](<https://agent.local:18980/api/media/sig-4/payload-4>) [Local](/Users/yuan/local.png) [Api](/api/sessions)"
        }
      ]
    });
  });

  it("requires WebUI thread Goal identity and outcome to be a valid pair", async () => {
    let payload: Record<string, unknown> = {
      schemaVersion: 3,
      sessionKey: "websocket:chat-goal",
      last_turn_id: "turn-goal",
      last_turn_closed: true,
      last_turn_goal_id: goalId,
      last_turn_goal_outcome: "active",
      messages: []
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/webui/bootstrap") return json(bootstrap);
      if (url.pathname.endsWith("/webui-thread")) return json(payload);
      return json({ error: "not found" }, 404);
    });
    const client = createMemmyAgentClient({
      baseUrl: "http://127.0.0.1:18980",
      clientId: "frontend-test",
      fetchFn: fetchMock as typeof fetch
    });

    await expect(client.readWebuiThread("websocket:chat-goal")).resolves.toMatchObject({
      last_turn_id: "turn-goal",
      last_turn_goal_id: goalId,
      last_turn_goal_outcome: "active"
    });
    payload = { ...payload, last_turn_goal_id: undefined };
    await expect(client.readWebuiThread("websocket:chat-goal")).rejects.toThrow();
    payload = { ...payload, last_turn_goal_id: "not-a-uuid", last_turn_goal_outcome: "unknown" };
    await expect(client.readWebuiThread("websocket:chat-goal")).rejects.toThrow();
  });

  it("resolves, opens, and reveals artifacts through authenticated JSON POST routes", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ path: url.pathname, init });
      if (url.pathname === "/webui/bootstrap") {
        return json(bootstrap);
      }
      if (url.pathname === "/api/webui/artifacts/resolve") {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer agent-token" });
        const body = JSON.parse(String(init?.body));
        if (body.path === "/Users/yuan/.memmy/workspace") {
          return json({ ok: true, path: "/Users/yuan/.memmy/workspace", name: "workspace", kind: "directory" });
        }
        expect(body).toEqual({ path: "/Users/yuan/result.png", sessionKey: "websocket:chat-1" });
        return json({ ok: true, path: "/Users/yuan/result.png", name: "result.png", kind: "image", media_url: "/api/media/signed" });
      }
      if (url.pathname === "/api/webui/artifacts/reveal") {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer agent-token" });
        expect(JSON.parse(String(init?.body))).toEqual({ path: "/Users/yuan/result.png", sessionKey: "websocket:chat-1" });
        return json({ ok: true, path: "/Users/yuan/result.png" });
      }
      if (url.pathname === "/api/webui/artifacts/open") {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer agent-token" });
        expect(JSON.parse(String(init?.body))).toEqual({ path: "/Users/yuan/result.png", sessionKey: "websocket:chat-1" });
        return json({ ok: true, path: "/Users/yuan/result.png" });
      }
      return json({ error: "not found" }, 404);
    });
    const client = createMemmyAgentClient({ baseUrl: "http://127.0.0.1:18980", clientId: "frontend-test", fetchFn: fetchMock as typeof fetch });

    await expect(client.resolveArtifact("/Users/yuan/result.png", "websocket:chat-1")).resolves.toEqual({
      ok: true,
      path: "/Users/yuan/result.png",
      name: "result.png",
      kind: "image",
      media_url: "http://127.0.0.1:18980/api/media/signed"
    });
    await expect(client.resolveArtifact("/Users/yuan/.memmy/workspace", "websocket:chat-1")).resolves.toEqual({
      ok: true,
      path: "/Users/yuan/.memmy/workspace",
      name: "workspace",
      kind: "directory"
    });
    await expect(client.revealArtifact("/Users/yuan/result.png", "websocket:chat-1")).resolves.toBeUndefined();
    await expect(client.openArtifact("/Users/yuan/result.png", "websocket:chat-1")).resolves.toBeUndefined();
    expect(calls.map((call) => call.path)).toEqual([
      "/webui/bootstrap",
      "/api/webui/artifacts/resolve",
      "/api/webui/artifacts/resolve",
      "/api/webui/artifacts/reveal",
      "/api/webui/artifacts/open"
    ]);
  });

  it("uploads agent attachments as multipart and normalizes returned signed URLs", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ path: url.pathname, init });
      if (url.pathname === "/webui/bootstrap") {
        return json(bootstrap);
      }
      if (url.pathname === "/api/webui/media/upload") {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toEqual({ Authorization: "Bearer agent-token" });
        expect(init?.headers).not.toHaveProperty("Content-Type");
        expect(init?.body).toBeInstanceOf(FormData);
        const files = (init?.body as FormData).getAll("files");
        expect(files).toHaveLength(2);
        expect((files[0] as File).type).toBe("image/png");
        expect((files[0] as File).name).toBe("shot.png");
        expect((files[1] as File).type).toBe("application/pdf");
        expect((files[1] as File).name).toBe("小短文.pdf");
        return json({
          attachments: [
            {
              path: "/tmp/memmy/media/websocket/webui/shot.png",
              url: "/api/media/sig/shot",
              name: "shot.png",
              kind: "image",
              mime: "image/png",
              bytes: 3
            },
            {
              path: "/tmp/memmy/media/websocket/webui/小短文.pdf",
              url: "/api/media/sig/report",
              name: "小短文.pdf",
              kind: "file",
              mime: "application/pdf",
              bytes: 12
            }
          ]
        });
      }
      return json({ error: "not found" }, 404);
    });
    const client = createMemmyAgentClient({
      baseUrl: "http://127.0.0.1:18980",
      clientId: "frontend-test",
      fetchFn: fetchMock as typeof fetch
    });

    await expect(client.uploadAgentMedia([
      { blob: new Blob(["png"], { type: "image/jpeg" }), name: "shot.jpeg", kind: "image", mime: "image/png" },
      { blob: new Blob(["%PDF-report"], { type: "application/pdf" }), name: "小短文.pdf", kind: "file", mime: "application/pdf" }
    ])).resolves.toEqual([
      {
        path: "/tmp/memmy/media/websocket/webui/shot.png",
        url: "http://127.0.0.1:18980/api/media/sig/shot",
        name: "shot.png",
        kind: "image",
        mime: "image/png",
        bytes: 3
      },
      {
        path: "/tmp/memmy/media/websocket/webui/小短文.pdf",
        url: "http://127.0.0.1:18980/api/media/sig/report",
        name: "小短文.pdf",
        kind: "file",
        mime: "application/pdf",
        bytes: 12
      }
    ]);
    expect(calls.map((call) => call.path)).toEqual(["/webui/bootstrap", "/api/webui/media/upload"]);
  });

  it("connects websocket with bootstrap token and sends first-phase chat frames", async () => {
    const sockets: FakeSocket[] = [];
    const fetchMock = vi.fn(async () => json(bootstrap));
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: fetchMock as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    const events: unknown[] = [];

    const connection = await connectReady(client, sockets, (event) => events.push(event), { event: "ready", chat_id: "chat-1", client_id: "frontend-test" });
    expect(sockets[0]?.url).toBe("wss://agent.local:18980/ws?token=agent-token&client_id=frontend-test&client_surface=gui");

    const newChat = connection.newChat(1);
    connection.attach("chat-2");
    connection.sendMessage({
      chatId: "chat-2",
      content: "整理最近任务",
      language: "zh-CN",
      media: [{
        path: "/tmp/memmy/media/websocket/webui/shot.png",
        url: "https://agent.local:18980/api/media/sig/shot",
        name: "shot.png",
        kind: "image",
        mime: "image/png",
        bytes: 3
      }]
    }, 1);
    connection.stop("chat-2");
    connection.restart("chat-2");
    connection.restart("");
    connection.status("chat-2");
    connection.status("");
    connection.historyDag("chat-2");
    connection.historyDag("");
    connection.requestQueueSnapshot("chat-2", 1);
    const newChatRequestId = JSON.parse(sockets[0]!.sent[0]!).client_request_id as string;
    sockets[0]?.emit({
      event: "attached",
      chat_id: "chat-new",
      client_request_id: newChatRequestId,
      model_preset: "desktop-openai-gpt-5",
      model_selection: modelSelectionWire
    });

    await expect(newChat).resolves.toEqual({
      chatId: "chat-new",
      modelPreset: "desktop-openai-gpt-5",
      modelSelection
    });
    expect(events).toEqual([
      { event: "ready", chat_id: "chat-1", client_id: "frontend-test", connection_generation: 1 },
      {
        event: "attached",
        chat_id: "chat-new",
        client_request_id: newChatRequestId,
        model_preset: "desktop-openai-gpt-5",
        model_selection: modelSelectionWire,
        connection_generation: 1
      }
    ]);
    expect(sockets[0]?.sent.map((item) => JSON.parse(item))).toEqual([
      { type: "new_chat", client_request_id: newChatRequestId },
      { type: "attach", chat_id: "chat-2" },
      {
        type: "message",
        chat_id: "chat-2",
        content: "整理最近任务",
        webui: true,
        language: "zh-CN",
        media_paths: ["/tmp/memmy/media/websocket/webui/shot.png"]
      },
      { type: "stop", chat_id: "chat-2" },
      { type: "message", chat_id: "chat-2", content: "/restart", webui: true },
      { type: "status", chat_id: "chat-2" },
      { type: "history_dag", chat_id: "chat-2" },
      { type: "queue_snapshot_request", chat_id: "chat-2" }
    ]);
  });

  it("does not resolve websocket connection until the current socket receives ready", async () => {
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    let settled = false;

    const pending = client.connectWebSocket().then((connection) => {
      settled = true;
      return connection;
    });
    while (!sockets[0]) {
      await Promise.resolve();
    }
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(sockets[0]?.sent).toEqual([]);

    sockets[0]?.emit({ event: "ready", chat_id: "chat-1" });
    await expect(pending).resolves.toBeDefined();
    expect(settled).toBe(true);
  });

  it("closes and rejects a connection whose application ready handshake times out", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const events: MemmyAgentWsEvent[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });

    const pending = client.connectWebSocket((event) => events.push(event));
    const rejection = expect(pending).rejects.toThrow("closed before ready");
    while (!sockets[0]) {
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sockets[0]?.closeCalls[0]).toEqual({ code: 1011, reason: "ready timeout" });
    sockets[0]?.emitClose(1011);
    await rejection;
    expect(sockets).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it("newChat resolves server assigned chat id", async () => {
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });

    const connection = await connectReady(client, sockets);
    const clientRequestId = "11111111-1111-4111-8111-111111111111";
    const pending = connection.newChat(1, 5000, "desktop-openai-gpt-5", clientRequestId);
    const request = JSON.parse(sockets[0]!.sent[0]!);
    expect(request).toEqual({
      type: "new_chat",
      client_request_id: clientRequestId,
      model_preset: "desktop-openai-gpt-5"
    });

    sockets[0]?.emit({
      event: "attached",
      chat_id: "server-chat",
      client_request_id: request.client_request_id,
      model_preset: "desktop-openai-gpt-5",
      model_selection: modelSelectionWire
    });

    await expect(pending).resolves.toEqual({
      chatId: "server-chat",
      modelPreset: "desktop-openai-gpt-5",
      modelSelection
    });
  });

  it("newChat preserves a structured unavailable-model rejection and clears pending state", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });

    const connection = await connectReady(client, sockets);
    const clientRequestId = "22222222-2222-4222-8222-222222222222";
    const pending = connection.newChat(1, 100, "deleted-account-model", clientRequestId);
    const rejection = pending.catch((error: unknown) => error);

    sockets[0]?.emit({
      event: "error",
      client_request_id: clientRequestId,
      detail: "new_chat_rejected",
      reason: "model_selection_unavailable"
    });
    await vi.advanceTimersByTimeAsync(100);

    const error = await rejection;
    expect(error).toEqual(expect.objectContaining({
      name: "MemmyAgentMessageRejectedError",
      detail: "new_chat_rejected",
      reason: "model_selection_unavailable"
    }));
    expect(error).toBeInstanceOf(MemmyAgentMessageRejectedError);

    const second = connection.newChat(1);
    const secondRequest = JSON.parse(sockets[0]!.sent.at(-1)!);
    sockets[0]?.emit({
      event: "attached",
      chat_id: "server-chat-after-rejection",
      client_request_id: secondRequest.client_request_id,
      model_preset: "desktop-openai-gpt-5",
      model_selection: modelSelectionWire
    });
    await expect(second).resolves.toMatchObject({
      chatId: "server-chat-after-rejection",
      modelPreset: "desktop-openai-gpt-5"
    });
  });

  it("newChat rejects when another new chat is in flight", async () => {
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });

    const connection = await connectReady(client, sockets);
    const pending = connection.newChat(1);

    await expect(connection.newChat(1)).rejects.toThrow("newChat already in flight");
    const request = JSON.parse(sockets[0]!.sent[0]!);
    sockets[0]?.emit({
      event: "attached",
      chat_id: "server-chat",
      client_request_id: request.client_request_id,
      model_preset: "desktop-openai-gpt-5",
      model_selection: modelSelectionWire
    });
    await expect(pending).resolves.toEqual({
      chatId: "server-chat",
      modelPreset: "desktop-openai-gpt-5",
      modelSelection
    });
  });

  it("newChat rejects on timeout and clears pending state", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });

    const connection = await connectReady(client, sockets);
    const pending = connection.newChat(1, 100);
    const rejection = expect(pending).rejects.toThrow("newChat timed out");
    await vi.advanceTimersByTimeAsync(100);

    await rejection;
    const second = connection.newChat(1);
    const request = JSON.parse(sockets[0]!.sent.at(-1)!);
    sockets[0]?.emit({
      event: "attached",
      chat_id: "server-chat",
      client_request_id: request.client_request_id,
      model_preset: "desktop-openai-gpt-5",
      model_selection: modelSelectionWire
    });
    await expect(second).resolves.toEqual({
      chatId: "server-chat",
      modelPreset: "desktop-openai-gpt-5",
      modelSelection
    });
  });

  it("newChat rejects on socket close and clears pending state", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });

    const connection = await connectReady(client, sockets);
    const pending = connection.newChat(1);
    const rejection = expect(pending).rejects.toThrow("websocket closed");
    sockets[0]?.emitClose();

    await rejection;
    await vi.advanceTimersByTimeAsync(500);
    sockets[1]?.emit({ event: "ready", chat_id: "ready-2" });
    const second = connection.newChat(2);
    const request = JSON.parse(sockets[1]!.sent.at(-1)!);
    sockets[1]?.emit({
      event: "attached",
      chat_id: "server-chat",
      client_request_id: request.client_request_id,
      model_preset: "desktop-openai-gpt-5",
      model_selection: modelSelectionWire
    });
    await expect(second).resolves.toEqual({
      chatId: "server-chat",
      modelPreset: "desktop-openai-gpt-5",
      modelSelection
    });
    connection.close();
  });

  it("resolves a run status snapshot only for the requested chat and ready generation", async () => {
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });

    const connection = await connectReady(client, sockets);
    let settled = false;
    const pending = connection.requestRunStatusSnapshot("chat-1", 1).finally(() => {
      settled = true;
    });
    expect(sockets[0]?.sent.map((item) => JSON.parse(item))).toContainEqual({ type: "attach", chat_id: "chat-1" });

    sockets[0]?.emit({ event: "run_status_snapshot", chat_id: "chat-2", status: "idle" });
    await Promise.resolve();
    expect(settled).toBe(false);

    sockets[0]?.emit({
      event: "run_status_snapshot",
      chat_id: "chat-1",
      status: "running",
      started_at: 1_234,
      turn_id: "turn-1",
      source: { kind: "gui", channel: "websocket" }
    });
    await expect(pending).resolves.toEqual({
      status: "running",
      startedAt: 1_234,
      turnId: "turn-1",
      source: { kind: "gui", channel: "websocket" },
      connectionGeneration: 1
    });
  });

  it("rejects a pending run status snapshot when its socket closes", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });

    const connection = await connectReady(client, sockets);
    const pending = connection.requestRunStatusSnapshot("chat-1", 1);
    const rejection = expect(pending).rejects.toThrow("websocket closed");
    sockets[0]?.emitClose();

    await rejection;
    await expect(connection.requestRunStatusSnapshot("chat-1", 1)).rejects.toThrow("Agent gateway is not ready");
    connection.close();
  });

  it("derives websocket URL from same-origin default base URL", async () => {
    vi.stubEnv("VITE_MEMMY_AGENT_WEBUI_URL", "");
    vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:5174" } });
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });

    await connectReady(client, sockets, () => undefined);

    expect(sockets[0]?.url).toBe("ws://127.0.0.1:5174/ws?token=agent-token&client_id=frontend-test&client_surface=gui");
  });

  it("routes websocket events per chat and flushes queued events on subscribe", async () => {
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    const globalEvents: unknown[] = [];
    const chatEvents: unknown[] = [];

    const connection = await connectReady(client, sockets, (event) => globalEvents.push(event));
    globalEvents.length = 0;
    sockets[0]?.emit({
      event: "message",
      chat_id: "chat-2",
      connection_generation: 1,
      kind: "progress",
      text: "queued trace ![Diagram](/api/media/sig-live/payload-live)",
      media_urls: [{ kind: "image", url: "/api/media/sig-live/payload-live", name: "live.png" }]
    });
    const unsubscribe = connection.onChat("chat-2", (event) => chatEvents.push(event));

    const expectedEvent = {
      event: "message",
      chat_id: "chat-2",
      connection_generation: 1,
      kind: "progress",
      text: "queued trace ![Diagram](https://agent.local:18980/api/media/sig-live/payload-live)",
      media_urls: [{ kind: "image", url: "https://agent.local:18980/api/media/sig-live/payload-live", name: "live.png" }]
    };
    expect(chatEvents).toEqual([expectedEvent]);
    expect(globalEvents).toEqual([expectedEvent]);
    expect(sockets[0]?.sent.map((item) => JSON.parse(item))).toContainEqual({ type: "attach", chat_id: "chat-2" });

    unsubscribe();
  });

  it("routes status_result events only through the status result handler", async () => {
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    const statusResults: unknown[] = [];
    const chatEvents: unknown[] = [];

    const connection = await connectReady(client, sockets);
    connection.onStatusResult((chatId, content) => statusResults.push({ chatId, content }));
    connection.onChat("chat-2", (event) => chatEvents.push(event));

    sockets[0]?.emit({ event: "status_result", chat_id: "chat-2", content: "runtime ok" });

    expect(statusResults).toEqual([{ chatId: "chat-2", content: "runtime ok" }]);
    expect(chatEvents).toEqual([]);
  });

  it("routes history DAG results to the panel handler instead of the chat stream", async () => {
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    const historyDagResults: unknown[] = [];
    const chatEvents: unknown[] = [];

    const connection = await connectReady(client, sockets);
    connection.onHistoryDagResult((chatId, content, payload) => historyDagResults.push({ chatId, content, payload }));
    connection.onChat("chat-2", (event) => chatEvents.push(event));
    connection.historyDag("chat-2");

    sockets[0]?.emit({
      event: "history_dag_result",
      chat_id: "chat-2",
      content: "当前 DAG",
      agent_ui: {
        historyDag: {
          sessionKey: "websocket:chat-2",
          nodes: [{
            id: "n-1",
            kind: "task",
            status: "active",
            title: "修复登录",
            summary: "定位登录失败",
            importance: 90,
            createdBy: "llm_patch",
            updatedBy: "llm_patch",
            sourceRefs: []
          }, {
            id: "n-2",
            kind: "subtask",
            status: "done",
            title: "定位错误",
            summary: "完成登录失败定位",
            importance: 70,
            createdBy: "llm_patch",
            updatedBy: "llm_patch",
            sourceRefs: []
          }],
          edges: [{
            id: "e-1",
            source_id: "n-1",
            target_id: "n-2",
            type: "decomposes",
            createdBy: "llm_patch"
          }],
          activePathNodeIds: ["n-1", "n-2"],
          activePathEdgeIds: ["e-1"],
          snapshotText: "[Working Memory DAG Snapshot]"
        }
      }
    });

    expect(sockets[0]?.sent.map((item) => JSON.parse(item))).toContainEqual({
      type: "history_dag",
      chat_id: "chat-2"
    });
    expect(historyDagResults).toEqual([{
      chatId: "chat-2",
      content: "当前 DAG",
      payload: expect.objectContaining({
        sessionKey: "websocket:chat-2",
        activePathNodeIds: ["n-1", "n-2"],
        activePathEdgeIds: ["e-1"],
        nodes: [
          expect.objectContaining({ id: "n-1", kind: "task" }),
          expect.objectContaining({ id: "n-2", kind: "subtask" })
        ],
        edges: [expect.objectContaining({ id: "e-1", source_id: "n-1", target_id: "n-2" })]
      })
    }]);
    expect(chatEvents).toEqual([]);
  });

  it("keeps legacy agent_ui history DAG messages routed to the panel handler", async () => {
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    const historyDagResults: unknown[] = [];
    const chatEvents: unknown[] = [];

    const connection = await connectReady(client, sockets);
    connection.onHistoryDagResult((chatId, content, payload) => historyDagResults.push({ chatId, content, payload }));
    connection.onChat("chat-2", (event) => chatEvents.push(event));

    sockets[0]?.emit({
      event: "message",
      chat_id: "chat-2",
      content: "兼容 DAG",
      agent_ui: {
        historyDag: {
          sessionKey: "websocket:chat-2",
          nodes: [{
            id: "n-1",
            kind: "task",
            status: "active",
            title: "修复登录",
            summary: "定位登录失败",
            importance: 90,
            createdBy: "llm_patch",
            updatedBy: "llm_patch",
            sourceRefs: []
          }],
          edges: [],
          activePathNodeIds: ["n-1"],
          snapshotText: "[Working Memory DAG Snapshot]"
        }
      }
    });

    expect(historyDagResults).toEqual([{
      chatId: "chat-2",
      content: "兼容 DAG",
      payload: expect.objectContaining({
        sessionKey: "websocket:chat-2",
        activePathNodeIds: ["n-1"]
      })
    }]);
    expect((historyDagResults[0] as any).payload).not.toHaveProperty("activePathEdgeIds");
    expect(chatEvents).toEqual([]);
  });

  it("fails closed when a new history DAG payload has malformed active edge ids", async () => {
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    const historyDagResults: any[] = [];
    const connection = await connectReady(client, sockets);
    connection.onHistoryDagResult((chatId, content, payload) => historyDagResults.push({ chatId, content, payload }));

    sockets[0]?.emit({
      event: "history_dag_result",
      chat_id: "chat-2",
      content: "损坏的边字段",
      agent_ui: {
        historyDag: {
          sessionKey: "websocket:chat-2",
          nodes: [],
          edges: [],
          activePathNodeIds: [],
          activePathEdgeIds: "not-an-array",
          snapshotText: ""
        }
      }
    });

    expect(historyDagResults[0]?.payload?.activePathEdgeIds).toEqual([]);
  });

  it("surfaces session, model, and run status updates through connection handlers", async () => {
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    const sessionUpdates: unknown[] = [];
    const modelUpdates: unknown[] = [];
    const runUpdates: unknown[] = [];
    const runLifecycleUpdates: unknown[] = [];

    const connection = await connectReady(client, sockets);
    connection.onSessionUpdate((chatId, scope) => sessionUpdates.push({ chatId, scope }));
    connection.onRuntimeModelUpdate((modelName, modelPreset) => modelUpdates.push({ modelName, modelPreset }));
    connection.onRunStatus((chatId, startedAt) => runUpdates.push({ chatId, startedAt }));
    connection.onRunLifecycle((chatId, event) => runLifecycleUpdates.push({ chatId, event }));

    sockets[0]?.emit({ event: "session_updated", chat_id: "chat-1", scope: "thread" });
    sockets[0]?.emit({ event: "session_updated", chat_id: "chat-1", scope: "metadata" });
    sockets[0]?.emit({ event: "runtime_model_updated", model_name: "gpt-4.1-mini", model_preset: "openai" });
    sockets[0]?.emit({ event: "run_status", chat_id: "chat-1", status: "running", started_at: 1780732800 });
    const activeGoal = goalState();
    sockets[0]?.emit({ event: "goal_state", chat_id: "chat-1", goal_state: activeGoal });
    sockets[0]?.emit({ event: "stop_result", chat_id: "chat-1", stopped: 1 });
    sockets[0]?.emit({ event: "turn_end", chat_id: "chat-1" });
    sockets[0]?.emit({ event: "run_status", chat_id: "chat-1", status: "idle" });

    expect(sessionUpdates).toEqual([
      { chatId: "chat-1", scope: "thread" },
      { chatId: "chat-1", scope: "metadata" }
    ]);
    expect(modelUpdates).toEqual([{ modelName: "gpt-4.1-mini", modelPreset: "openai" }]);
    expect(runUpdates).toEqual([
      { chatId: "chat-1", startedAt: 1780732800 },
      { chatId: "chat-1", startedAt: null },
      { chatId: "chat-1", startedAt: null },
      { chatId: "chat-1", startedAt: null }
    ]);
    expect(runLifecycleUpdates).toEqual([
      { chatId: "chat-1", event: expect.objectContaining({ event: "run_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }) },
      { chatId: "chat-1", event: expect.objectContaining({ event: "stop_result", chat_id: "chat-1", stopped: 1 }) },
      { chatId: "chat-1", event: expect.objectContaining({ event: "turn_end", chat_id: "chat-1" }) },
      { chatId: "chat-1", event: expect.objectContaining({ event: "run_status", chat_id: "chat-1", status: "idle" }) }
    ]);
    expect(connection.getRunStartedAt("chat-1")).toBeNull();
    expect(connection.getGoalState("chat-1")).toEqual(activeGoal);
  });

  it("resolves Goal controls from matching results and rejects protocol errors", async () => {
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    const connection = await connectReady(client, sockets);
    const requestId = "11111111-1111-4111-8111-111111111111";

    const pausing = connection.controlGoal({
      chatId: "chat-1",
      goalId,
      action: "pause",
      requestId
    }, 1);
    expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toEqual({
      type: "goal_control",
      chat_id: "chat-1",
      request_id: requestId,
      goal_id: goalId,
      action: "pause"
    });
    sockets[0]?.emit({
      event: "goal_control_result",
      chat_id: "chat-1",
      request_id: requestId,
      ok: true,
      warning: "turn_cancel_failed"
    });
    await expect(pausing).resolves.toEqual({ ok: true, requestId, warning: "turn_cancel_failed" });

    const resuming = connection.controlGoal({
      chatId: "chat-1",
      goalId,
      action: "resume",
      requestId: "22222222-2222-4222-8222-222222222222"
    }, 1);
    sockets[0]?.emit({
      event: "goal_control_result",
      chat_id: "chat-1",
      request_id: "22222222-2222-4222-8222-222222222222",
      ok: false,
      error: "invalid_transition"
    });
    await expect(resuming).rejects.toMatchObject({ code: "invalid_transition", unknownResult: false });
  });

  it("reuses equal in-flight Goal controls and rejects a conflicting request_id", async () => {
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    const connection = await connectReady(client, sockets);
    const input = {
      chatId: "chat-1",
      goalId,
      action: "pause" as const,
      requestId: "33333333-3333-4333-8333-333333333333"
    };

    const first = connection.controlGoal(input, 1);
    const duplicate = connection.controlGoal(input, 1);
    await expect(connection.controlGoal({ ...input, action: "resume" }, 1))
      .rejects.toMatchObject({ code: "request_id_conflict" });
    expect(first).toBe(duplicate);
    expect(sockets[0]?.sent.filter((raw) => JSON.parse(raw).type === "goal_control")).toHaveLength(1);

    sockets[0]?.emit({
      event: "goal_control_result",
      chat_id: "chat-1",
      request_id: input.requestId,
      ok: true
    });
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it("hydrates an unknown Goal control result after timeout without replaying the mutation", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    const connection = await connectReady(client, sockets);
    const requestId = "44444444-4444-4444-8444-444444444444";
    const pending = connection.controlGoal({ chatId: "chat-1", goalId, action: "pause", requestId }, 1, 10);

    await vi.advanceTimersByTimeAsync(10);
    expect(sockets[0]?.sent.map((raw) => JSON.parse(raw))).toContainEqual({ type: "attach", chat_id: "chat-1" });
    expect(sockets[0]?.sent.filter((raw) => JSON.parse(raw).type === "goal_control")).toHaveLength(1);
    sockets[0]?.emit({ event: "goal_state", chat_id: "chat-1", goal_state: goalState("paused") });

    await expect(pending).resolves.toEqual({ ok: true, requestId });
  });

  it("switches a disconnected Goal control to hydrate-only calibration", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    const connection = await connectReady(client, sockets);
    const requestId = "55555555-5555-4555-8555-555555555555";
    const pending = connection.controlGoal({ chatId: "chat-1", goalId, action: "pause", requestId }, 1, 60_000);

    sockets[0]?.emitClose();
    await vi.advanceTimersByTimeAsync(500);
    while (!sockets[1]) await Promise.resolve();
    sockets[1]!.emit({ event: "ready", chat_id: "ready-2" });
    expect(sockets[1]!.sent.map((raw) => JSON.parse(raw))).toContainEqual({ type: "attach", chat_id: "chat-1" });
    expect(sockets[1]!.sent.some((raw) => JSON.parse(raw).type === "goal_control")).toBe(false);
    sockets[1]!.emit({ event: "goal_state", chat_id: "chat-1", goal_state: goalState("paused") });

    await expect(pending).resolves.toEqual({ ok: true, requestId });
  });

  it("routes run status snapshots through cache, lifecycle, and chat handlers in order", async () => {
    const sockets: FakeSocket[] = [];
    const callbackOrder: string[] = [];
    const lifecycleEvents: unknown[] = [];
    const chatEvents: unknown[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });

    const connection = await connectReady(client, sockets, (event) => {
      if (event.event === "run_status_snapshot") callbackOrder.push("event");
    });
    connection.onRunStatus(() => callbackOrder.push("run-status"));
    connection.onRunLifecycle((chatId, event) => {
      callbackOrder.push("lifecycle");
      lifecycleEvents.push({ chatId, event });
    });
    connection.onChat("chat-1", (event) => {
      callbackOrder.push("chat");
      chatEvents.push(event);
    });

    sockets[0]?.emit({
      event: "run_status_snapshot",
      chat_id: "chat-1",
      status: "running",
      started_at: 1780732800,
      turn_id: "turn-1"
    });

    expect(callbackOrder).toEqual(["event", "run-status", "lifecycle", "chat"]);
    expect(connection.getRunStartedAt("chat-1")).toBe(1780732800);
    expect(lifecycleEvents).toEqual([{
      chatId: "chat-1",
      event: expect.objectContaining({
        event: "run_status_snapshot",
        status: "running",
        started_at: 1780732800,
        turn_id: "turn-1"
      })
    }]);
    expect(chatEvents).toEqual([expect.objectContaining({ event: "run_status_snapshot", status: "running" })]);

    callbackOrder.length = 0;
    sockets[0]?.emit({ event: "run_status", chat_id: "chat-1", status: "running", started_at: 1780732800 });
    sockets[0]?.emit({ event: "run_status_snapshot", chat_id: "chat-1", status: "idle", turn_id: "turn-1" });
    sockets[0]?.emit({ event: "run_status_snapshot", chat_id: "chat-1", status: "idle", turn_id: "turn-1" });

    expect(connection.getRunStartedAt("chat-1")).toBeNull();
    expect(callbackOrder).toEqual([
      "run-status", "lifecycle", "chat",
      "event", "run-status", "lifecycle", "chat",
      "event", "run-status", "lifecycle", "chat"
    ]);
  });

  it("keeps invalid run snapshots out of run lifecycle state without changing chat dispatch", async () => {
    const sockets: FakeSocket[] = [];
    const globalEvents: unknown[] = [];
    const runUpdates: unknown[] = [];
    const lifecycleEvents: unknown[] = [];
    const chatEvents: unknown[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });

    const connection = await connectReady(client, sockets, (event) => globalEvents.push(event));
    globalEvents.length = 0;
    connection.onRunStatus((chatId, startedAt) => runUpdates.push({ chatId, startedAt }));
    connection.onRunLifecycle((chatId, event) => lifecycleEvents.push({ chatId, event }));
    connection.onChat("chat-1", (event) => chatEvents.push(event));

    sockets[0]?.emit({ event: "run_status_snapshot", status: "idle" });
    sockets[0]?.emit({ event: "run_status_snapshot", chat_id: "chat-1", status: "unknown" });
    sockets[0]?.emit({ event: "run_status_snapshot", chat_id: "chat-1", status: "running" });

    expect(globalEvents).toEqual([
      { event: "run_status_snapshot", status: "idle", connection_generation: 1 },
      { event: "run_status_snapshot", chat_id: "chat-1", status: "unknown", connection_generation: 1 },
      { event: "run_status_snapshot", chat_id: "chat-1", status: "running", connection_generation: 1 }
    ]);
    expect(runUpdates).toEqual([]);
    expect(lifecycleEvents).toEqual([]);
    expect(chatEvents).toEqual([
      { event: "run_status_snapshot", chat_id: "chat-1", status: "unknown", connection_generation: 1 },
      { event: "run_status_snapshot", chat_id: "chat-1", status: "running", connection_generation: 1 }
    ]);
    expect(connection.getRunStartedAt("chat-1")).toBeNull();
  });

  it("ignores turn_end run status updates without chat_id", async () => {
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    const runUpdates: unknown[] = [];

    await connectReady(client, sockets).then((connection) => {
      connection.onRunStatus((chatId, startedAt) => runUpdates.push({ chatId, startedAt }));
    });
    sockets[0]?.emit({ event: "turn_end" });

    expect(runUpdates).toEqual([]);
  });

  it("reconnects and re-attaches known chats after websocket close", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });

    const connection = await connectReady(client, sockets);
    connection.onChat("chat-1", () => undefined);
    sockets[0]?.emit({ event: "run_status_snapshot", chat_id: "chat-1", status: "running", started_at: 1780732800 });
    expect(connection.getRunStartedAt("chat-1")).toBe(1780732800);
    sockets[0]?.emitClose();
    await vi.advanceTimersByTimeAsync(500);

    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.sent).toEqual([]);
    sockets[1]?.emit({ event: "ready", chat_id: "ready-2" });
    expect(sockets[1]?.sent.map((item) => JSON.parse(item))).toContainEqual({ type: "attach", chat_id: "chat-1" });
    sockets[1]?.emit({ event: "run_status_snapshot", chat_id: "chat-1", status: "idle" });
    expect(connection.getRunStartedAt("chat-1")).toBeNull();
  });

  it("keeps a queued message pending past the old result timeout until accepted", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const events: MemmyAgentWsEvent[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    const connection = await connectReady(client, sockets, (event) => events.push(event));
    const clientRequestId = "11111111-1111-4111-8111-111111111111";
    let settled = false;
    const pending = connection.sendMessage({
      chatId: "chat-queued",
      content: "wait in queue",
      clientRequestId
    }, 1).then(() => {
      settled = true;
    });

    sockets[0]?.emit({
      event: "message_queued",
      chat_id: "chat-queued",
      client_request_id: clientRequestId
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      event: "message_queued",
      chat_id: "chat-queued",
      client_request_id: clientRequestId
    }));
    expect(events.some((event) => event.event === "message_confirmation_exhausted")).toBe(false);

    sockets[0]?.emit({
      event: "message_accepted",
      chat_id: "chat-queued",
      client_request_id: clientRequestId
    });
    await pending;
    expect(settled).toBe(true);
  });

  it("returns the first composer queue confirmation and preserves its surface across reconnect", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    const connection = await connectReady(client, sockets);
    const clientRequestId = "33333333-3333-4333-8333-333333333333";
    const submission = connection.submitMessage({
      chatId: "chat-composer-queue",
      content: "queue me",
      clientRequestId
    }, 1);

    expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toMatchObject({
      type: "message",
      chat_id: "chat-composer-queue",
      client_request_id: clientRequestId,
      queue_surface: "chat_composer"
    });
    sockets[0]!.emit({
      event: "message_queued",
      chat_id: "chat-composer-queue",
      client_request_id: clientRequestId,
      item: {
        client_request_id: clientRequestId,
        text: "queue me",
        media_urls: [],
        queued_at: "2026-08-09T12:00:00.000Z"
      }
    });
    await expect(submission).resolves.toEqual({ status: "queued" });

    sockets[0]!.emitClose();
    await vi.advanceTimersByTimeAsync(500);
    sockets[1]!.emit({ event: "ready", chat_id: "ready-reconnect" });
    expect(sockets[1]!.sent.map((frame) => JSON.parse(frame))).toContainEqual(expect.objectContaining({
      type: "message",
      chat_id: "chat-composer-queue",
      client_request_id: clientRequestId,
      queue_surface: "chat_composer"
    }));
    sockets[1]!.emit({
      event: "message_accepted",
      chat_id: "chat-composer-queue",
      client_request_id: clientRequestId
    });
  });

  it("returns accepted when a composer message starts immediately", async () => {
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    const connection = await connectReady(client, sockets);
    const clientRequestId = "44444444-4444-4444-8444-444444444444";
    const submission = connection.submitMessage({
      chatId: "chat-immediate",
      content: "start now",
      clientRequestId
    }, 1);

    sockets[0]!.emit({
      event: "message_accepted",
      chat_id: "chat-immediate",
      client_request_id: clientRequestId
    });
    await expect(submission).resolves.toEqual({ status: "accepted" });
  });

  it("finishes a queued transport attempt when the item is removed", async () => {
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    const connection = await connectReady(client, sockets);
    const clientRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const submission = connection.submitMessage({
      chatId: "chat-remove-after-queue",
      content: "remove after queue",
      clientRequestId
    }, 1);
    sockets[0]!.emit({
      event: "message_queued",
      chat_id: "chat-remove-after-queue",
      client_request_id: clientRequestId,
      item: {
        client_request_id: clientRequestId,
        text: "remove after queue",
        media_urls: [],
        queued_at: "2026-08-09T12:00:00.000Z"
      }
    });
    await expect(submission).resolves.toEqual({ status: "queued" });
    expect((connection as unknown as { pendingMessageAttempts: Map<string, unknown> })
      .pendingMessageAttempts.size).toBe(1);

    sockets[0]!.emit({
      event: "message_queue_removed",
      chat_id: "chat-remove-after-queue",
      client_request_id: clientRequestId
    });
    expect((connection as unknown as { pendingMessageAttempts: Map<string, unknown> })
      .pendingMessageAttempts.size).toBe(0);
  });

  it("correlates a single queued-message removal result", async () => {
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    const connection = await connectReady(client, sockets);
    const clientRequestId = "55555555-5555-4555-8555-555555555555";
    const removal = connection.removeQueuedMessage("chat-remove", clientRequestId, 1);
    const frame = JSON.parse(sockets[0]!.sent.at(-1)!);
    expect(frame).toMatchObject({
      type: "queue_remove",
      chat_id: "chat-remove",
      client_request_id: clientRequestId
    });

    sockets[0]!.emit({
      event: "queue_remove_result",
      chat_id: "chat-remove",
      request_id: frame.request_id,
      client_request_id: clientRequestId,
      ok: true,
      outcome: "already_dequeued",
      revision: 8
    });
    await expect(removal).resolves.toEqual({ outcome: "already_dequeued", revision: 8 });
  });

  it("sends one queue-steer control and terminates the original queued attempt", async () => {
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    const connection = await connectReady(client, sockets);
    const clientRequestId = "56565656-5656-4656-8656-565656565656";
    const turnId = "78787878-7878-4878-8878-787878787878";
    const submission = connection.submitMessage({
      chatId: "chat-steer",
      content: "adjust active turn",
      clientRequestId
    }, 1);
    sockets[0]!.emit({
      event: "message_queued",
      chat_id: "chat-steer",
      client_request_id: clientRequestId,
      item: {
        client_request_id: clientRequestId,
        text: "adjust active turn",
        media_urls: [],
        queued_at: "2026-08-10T12:00:00.000Z",
        queue_surface: "chat_composer"
      }
    });
    await expect(submission).resolves.toEqual({ status: "queued" });

    const steer = connection.steerQueuedMessage(
      "chat-steer",
      clientRequestId,
      turnId,
      1
    );
    const frame = JSON.parse(sockets[0]!.sent.at(-1)!);
    expect(frame).toMatchObject({
      type: "queue_steer",
      chat_id: "chat-steer",
      client_request_id: clientRequestId,
      expected_turn_id: turnId
    });
    sockets[0]!.emit({
      event: "message_dequeued",
      chat_id: "chat-steer",
      client_request_id: clientRequestId,
      turn_admission: "steer",
      turn_id: turnId
    });
    expect((connection as unknown as { pendingMessageAttempts: Map<string, unknown> })
      .pendingMessageAttempts.size).toBe(0);
    sockets[0]!.emit({
      event: "queue_steer_result",
      chat_id: "chat-steer",
      request_id: frame.request_id,
      client_request_id: clientRequestId,
      ok: true,
      outcome: "steered",
      revision: 2,
      turn_id: turnId
    });
    await expect(steer).resolves.toEqual({
      outcome: "steered",
      revision: 2,
      turnId
    });
  });

  it("reconfirms queued messages across reconnects without exhausting retries", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    const connection = await connectReady(client, sockets);
    const clientRequestId = "22222222-2222-4222-8222-222222222222";
    const pending = connection.sendMessage({
      chatId: "chat-queued",
      content: "survive reconnects",
      clientRequestId
    }, 1);
    sockets[0]?.emit({ event: "message_queued", chat_id: "chat-queued", client_request_id: clientRequestId });

    for (let index = 0; index < 4; index += 1) {
      sockets.at(-1)?.emitClose();
      await vi.advanceTimersByTimeAsync(500);
      expect(sockets).toHaveLength(index + 2);
      const socket = sockets.at(-1)!;
      socket.emit({ event: "ready", chat_id: `ready-${index}` });
      const resent = socket.sent.map((item) => JSON.parse(item)).find((item) => item.type === "message");
      expect(resent).toMatchObject({
        chat_id: "chat-queued",
        client_request_id: clientRequestId,
      });
      socket.emit({ event: "message_queued", chat_id: "chat-queued", client_request_id: clientRequestId });
    }

    sockets.at(-1)?.emit({
      event: "message_accepted",
      chat_id: "chat-queued",
      client_request_id: clientRequestId
    });
    await expect(pending).resolves.toBeUndefined();
  });

  it("queues only control frames while reconnecting and flushes them after ready", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });

    const connection = await connectReady(client, sockets);
    sockets[0]?.emitClose();
    connection.stop("chat-control");
    connection.status("chat-control");
    expect(() => connection.sendMessage({ chatId: "chat-message", content: "do not queue" }, 1))
      .toThrow("Agent gateway is not ready");

    await vi.advanceTimersByTimeAsync(500);
    expect(sockets[1]?.sent).toEqual([]);
    sockets[1]?.emit({ event: "ready", chat_id: "ready-2" });

    expect(sockets[1]?.sent.map((item) => JSON.parse(item))).toEqual([
      { type: "attach", chat_id: "ready-chat" },
      { type: "attach", chat_id: "chat-control" },
      { type: "stop", chat_id: "chat-control" },
      { type: "status", chat_id: "chat-control" }
    ]);
  });

  it("ignores all callbacks from an old socket after a newer generation starts", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const events: MemmyAgentWsEvent[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });

    await connectReady(client, sockets, (event) => events.push(event));
    sockets[0]?.emitClose();
    await vi.advanceTimersByTimeAsync(500);
    const eventCountAfterClose = events.length;

    sockets[0]?.emit({ event: "ready", chat_id: "stale-ready" });
    sockets[0]?.emit({ event: "message", chat_id: "chat-1", content: "stale" });
    sockets[0]?.emitError();
    sockets[0]?.emitClose();
    expect(events).toHaveLength(eventCountAfterClose);

    sockets[1]?.emit({ event: "ready", chat_id: "fresh-ready" });
    expect(events.at(-1)).toEqual({
      event: "ready",
      chat_id: "fresh-ready",
      connection_generation: 2
    });
  });

  it("attributes a 1009 transport error only to the most recently sent ordinary chat", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const events: MemmyAgentWsEvent[] = [];
    const client = createMemmyAgentClient({
      baseUrl: "https://agent.local:18980",
      clientId: "frontend-test",
      fetchFn: vi.fn(async () => json(bootstrap)) as typeof fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });

    const connection = await connectReady(client, sockets, (event) => events.push(event));
    connection.sendMessage({ chatId: "chat-2", content: "large payload" }, 1);
    sockets[0]?.emitClose(1009);

    expect(events.slice(-2)).toEqual([
      { event: "transport_error", detail: "message_too_big", connection_generation: 1, chat_id: "chat-2" },
      { event: "connection_closed", connection_generation: 1 }
    ]);
  });

  it("converts between WebUI chat id and session key", () => {
    expect(chatIdToSessionKey("chat-1")).toBe("websocket:chat-1");
    expect(sessionKeyToChatId("websocket:chat-1")).toBe("chat-1");
    expect(sessionKeyToChatId("legacy-session")).toBe("legacy-session");
  });
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function authHeader(init?: RequestInit): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}

async function connectReady(
  client: MemmyAgentClient,
  sockets: FakeSocket[],
  onEvent?: (event: MemmyAgentWsEvent) => void,
  readyEvent: Record<string, unknown> = { event: "ready", chat_id: "ready-chat" }
) {
  const pending = client.connectWebSocket(onEvent);
  while (!sockets[0]) {
    await Promise.resolve();
  }
  sockets[0].emit(readyEvent);
  return pending;
}

class FakeSocket implements WebSocketLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readyState = 1;
  sent: string[] = [];
  closeCalls: Array<{ code: number | undefined; reason: string | undefined }> = [];

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
  }

  emit(event: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
  }

  emitError(): void {
    this.onerror?.({} as Event);
  }

  emitClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}
