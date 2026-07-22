import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatIdToSessionKey,
  createMemmyAgentClient,
  DEFAULT_MEMMY_AGENT_WEBUI_BASE_URL,
  defaultMemmyAgentBaseUrl,
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
    sort: "updated_desc"
  },
  updated_at: null
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("memmy-agent client", () => {
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
          sessions: [
            {
              key: "websocket:chat-1",
              title: "创建 AI 电商助手",
              preview: "继续拆解需求",
              updatedAt: "2026-06-06T08:00:00.000Z",
              run_started_at: 1780732800
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

    await expect(client.listSessions()).resolves.toHaveLength(1);
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
        return json({ sessions: [] });
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

    await expect(client.openArtifact("/Users/yuan/result.png")).resolves.toBeUndefined();
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

    await expect(client.resolveArtifact("/Users/yuan/missing.png")).rejects.toMatchObject({ status: 404 });
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
        : json({ sessions: [] });
    });
    const client = createMemmyAgentClient({
      baseUrl: "http://127.0.0.1:18980",
      clientId: "frontend-test",
      fetchFn: fetchMock as typeof fetch
    });

    await expect(client.listSessions()).rejects.toMatchObject({ status: 401 });
    expect(paths).toEqual(["/webui/bootstrap"]);
  });

  it("lists slash commands with bearer token, camelCase mapping, and control-command filtering", async () => {
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
        expect(JSON.parse(url.searchParams.get("state") ?? "{}")).toMatchObject({
          schema_version: 1,
          view: { show_previews: true }
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
            updatedAt: "2026-06-06T08:30:00.000Z"
          }
        });
      }
      if (url.pathname === "/api/sessions/websocket%3Achat-1/delete") {
        return json({ deleted: true });
      }
      return json({ error: "not found" }, 404);
    });
    const client = createMemmyAgentClient({ baseUrl: "http://127.0.0.1:18980", clientId: "frontend-test", fetchFn: fetchMock as typeof fetch });

    await expect(client.writeSidebarState(sidebarState)).resolves.toEqual(sidebarState);
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
        expect(body).toEqual({ path: "/Users/yuan/result.png" });
        return json({ ok: true, path: "/Users/yuan/result.png", name: "result.png", kind: "image", media_url: "/api/media/signed" });
      }
      if (url.pathname === "/api/webui/artifacts/reveal") {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer agent-token" });
        expect(JSON.parse(String(init?.body))).toEqual({ path: "/Users/yuan/result.png" });
        return json({ ok: true, path: "/Users/yuan/result.png" });
      }
      if (url.pathname === "/api/webui/artifacts/open") {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer agent-token" });
        expect(JSON.parse(String(init?.body))).toEqual({ path: "/Users/yuan/result.png" });
        return json({ ok: true, path: "/Users/yuan/result.png" });
      }
      return json({ error: "not found" }, 404);
    });
    const client = createMemmyAgentClient({ baseUrl: "http://127.0.0.1:18980", clientId: "frontend-test", fetchFn: fetchMock as typeof fetch });

    await expect(client.resolveArtifact("/Users/yuan/result.png")).resolves.toEqual({
      ok: true,
      path: "/Users/yuan/result.png",
      name: "result.png",
      kind: "image",
      media_url: "http://127.0.0.1:18980/api/media/signed"
    });
    await expect(client.resolveArtifact("/Users/yuan/.memmy/workspace")).resolves.toEqual({
      ok: true,
      path: "/Users/yuan/.memmy/workspace",
      name: "workspace",
      kind: "directory"
    });
    await expect(client.revealArtifact("/Users/yuan/result.png")).resolves.toBeUndefined();
    await expect(client.openArtifact("/Users/yuan/result.png")).resolves.toBeUndefined();
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
    expect(sockets[0]?.url).toBe("wss://agent.local:18980/ws?token=agent-token&client_id=frontend-test");

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
    sockets[0]?.emit({ event: "attached", chat_id: "chat-new" });

    await expect(newChat).resolves.toBe("chat-new");
    expect(events).toEqual([
      { event: "ready", chat_id: "chat-1", client_id: "frontend-test", connection_generation: 1 },
      { event: "attached", chat_id: "chat-new", connection_generation: 1 }
    ]);
    expect(sockets[0]?.sent.map((item) => JSON.parse(item))).toEqual([
      { type: "new_chat" },
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
      { type: "history_dag", chat_id: "chat-2" }
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
    const pending = connection.newChat(1);
    expect(sockets[0]?.sent.map((item) => JSON.parse(item))).toContainEqual({ type: "new_chat" });

    sockets[0]?.emit({ event: "attached", chat_id: "server-chat" });

    await expect(pending).resolves.toBe("server-chat");
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
    sockets[0]?.emit({ event: "attached", chat_id: "server-chat" });
    await expect(pending).resolves.toBe("server-chat");
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
    sockets[0]?.emit({ event: "attached", chat_id: "server-chat" });
    await expect(second).resolves.toBe("server-chat");
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
    sockets[1]?.emit({ event: "attached", chat_id: "server-chat" });
    await expect(second).resolves.toBe("server-chat");
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
      turn_id: "turn-1"
    });
    await expect(pending).resolves.toEqual({
      status: "running",
      startedAt: 1_234,
      turnId: "turn-1",
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

    expect(sockets[0]?.url).toBe("ws://127.0.0.1:5174/ws?token=agent-token&client_id=frontend-test");
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
    sockets[0]?.emit({ event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 });
    sockets[0]?.emit({ event: "goal_state", chat_id: "chat-1", goal_state: { active: true } });
    sockets[0]?.emit({ event: "stop_result", chat_id: "chat-1", stopped: 1 });
    sockets[0]?.emit({ event: "turn_end", chat_id: "chat-1" });
    sockets[0]?.emit({ event: "goal_status", chat_id: "chat-1", status: "idle" });

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
      { chatId: "chat-1", event: expect.objectContaining({ event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }) },
      { chatId: "chat-1", event: expect.objectContaining({ event: "stop_result", chat_id: "chat-1", stopped: 1 }) },
      { chatId: "chat-1", event: expect.objectContaining({ event: "turn_end", chat_id: "chat-1" }) },
      { chatId: "chat-1", event: expect.objectContaining({ event: "goal_status", chat_id: "chat-1", status: "idle" }) }
    ]);
    expect(connection.getRunStartedAt("chat-1")).toBeNull();
    expect(connection.getGoalState("chat-1")).toEqual({ active: true });
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
    sockets[0]?.emit({ event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 });
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
