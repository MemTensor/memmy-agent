import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import { ChannelManager } from "../../../src/integrations/channels/manager.js";
import { WebSocketChannel, normalizeConfigPath, stripTrailingSlash } from "../../../src/integrations/channels/websocket.js";
import { Session, SessionManager } from "../../../src/core/session/manager.js";
import { appendTranscriptObject, webuiTranscriptPath } from "../../../src/entrypoints/frontend-bridge/transcript.js";
import { loadConfig } from "../../../src/config/loader.js";

const routeMocks = vi.hoisted(() => ({
  mcpPresetsSettingsAction: vi.fn(),
}));
const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
  spawnSync: vi.fn(() => ({ status: 0, stderr: "" })),
}));

vi.mock("node:child_process", () => ({
  spawn: childProcessMocks.spawn,
  spawnSync: childProcessMocks.spawnSync,
}));

vi.mock("../../../src/entrypoints/frontend-bridge/mcp-presets-api.js", async (importOriginal: () => Promise<typeof import("../../../src/entrypoints/frontend-bridge/mcp-presets-api.js")>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    mcpPresetsSettingsAction: routeMocks.mcpPresetsSettingsAction,
  };
});

const running: WebSocketChannel[] = [];
const tmpDirs: string[] = [];
const originalMemmyAgentConfig = process.env.MEMMY_CONFIG;
const originalMemmyAgentDataDir = process.env.MEMMY_AGENT_DATA_DIR;
const desktopChannelSessionKeys = [
  ["WeChat", "weixin:wx-user"],
  ["Discord", "discord:channel-1"],
  ["Telegram", "telegram:chat-1"],
  ["iMessage", "imessage:user@example.com"],
  ["iMessage phone number", "imessage:+15551234567"],
  ["Feishu", "feishu:chat-1"],
  ["DingTalk", "dingtalk:user-1"],
] as const;

afterEach(async () => {
  await Promise.all(running.splice(0).map((channel) => channel.stop()));
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  childProcessMocks.spawn.mockClear();
  childProcessMocks.spawnSync.mockClear();
  routeMocks.mcpPresetsSettingsAction.mockReset();
  if (originalMemmyAgentConfig === undefined) delete process.env.MEMMY_CONFIG;
  else process.env.MEMMY_CONFIG = originalMemmyAgentConfig;
  if (originalMemmyAgentDataDir === undefined) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = originalMemmyAgentDataDir;
});

describe("WebSocket HTTP route helpers", () => {
  function tmpRoot(prefix = "memmy-ws-http-"): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(root);
    return root;
  }

  function expectedRevealInvocation(filePath: string): [string, string[]] {
    if (process.platform === "darwin") return ["open", ["-R", filePath]];
    if (process.platform === "win32") return ["explorer.exe", ["/select,", filePath]];
    return ["xdg-open", [path.dirname(filePath)]];
  }

  function seedSession(root: string, key = "websocket:test"): SessionManager {
    const manager = new SessionManager(root);
    const session = new Session({ key });
    session.addMessage("user", `hi from ${key}`);
    session.addMessage("assistant", "hello back");
    manager.save(session);
    return manager;
  }

  function seedMany(root: string, keys: string[]): SessionManager {
    const manager = new SessionManager(root);
    for (const key of keys) {
      const session = new Session({ key });
      session.addMessage("user", `hi from ${key}`);
      manager.save(session);
    }
    return manager;
  }

  function makeChannel({
    sessionManager = null,
    staticDistPath = null,
    runtimeModelName = null,
    workspacePath = null,
    config = {},
  }: {
    sessionManager?: SessionManager | null;
    staticDistPath?: string | null;
    runtimeModelName?: (() => string | null | undefined) | null;
    workspacePath?: string | null;
    config?: Record<string, any>;
  } = {}): WebSocketChannel {
    return new WebSocketChannel(
      {
        enabled: true,
        allowFrom: ["*"],
        host: "127.0.0.1",
        port: 0,
        path: "/",
        websocketRequiresToken: false,
        ...config,
      },
      new MessageBus(),
      { sessionManager, staticDistPath, runtimeModelName, workspacePath },
    );
  }

  async function startChannel(channel: WebSocketChannel): Promise<number> {
    running.push(channel);
    await channel.start();
    const address = (channel as any).server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a TCP port");
    return address.port;
  }

  async function authHeaders(port: number): Promise<Record<string, string>> {
    const boot = await fetch(`http://127.0.0.1:${port}/webui/bootstrap`);
    expect(boot.status).toBe(200);
    const body = (await boot.json()) as Record<string, any>;
    expect(body.token).toMatch(/^nbwt_/);
    return { Authorization: `Bearer ${body.token}` };
  }

  function responseJson(response: { body: Buffer | string }): Record<string, any> {
    return JSON.parse(Buffer.isBuffer(response.body) ? response.body.toString("utf8") : String(response.body));
  }

  function withApiToken(channel: WebSocketChannel, token = "admin-token"): Record<string, string> {
    channel.apiTokens.set(token, Date.now() / 1000 + 60);
    return { Authorization: `Bearer ${token}` };
  }

  function configModel(root: string, model: string): void {
    const configPath = path.join(root, "config.yaml");
    fs.writeFileSync(configPath, `model: ${model}\n`, "utf8");
    process.env.MEMMY_CONFIG = configPath;
  }

  const localConnection = { remoteAddress: "127.0.0.1" };
  const remoteConnection = { remoteAddress: "192.168.1.5" };
  const noHeaders = { headers: {} };

  it("normalizes configured HTTP route paths", () => {
    expect(stripTrailingSlash("/media///")).toBe("/media");
    expect(normalizeConfigPath("/api///")).toBe("/api");
    expect(normalizeConfigPath("///")).toBe("/");
  });

  it("injects WebUI runtime dependencies into WebSocket channels through ChannelManager", () => {
    const root = tmpRoot();
    const sessionManager = new SessionManager(root);
    const manager = new ChannelManager(
      {
        workspacePath: root,
        channels: {
          websocket: {
            enabled: true,
            allowFrom: ["*"],
            host: "127.0.0.1",
            port: 0,
            websocketRequiresToken: false,
          },
        },
      },
      new MessageBus(),
      { sessionManager, webuiRuntimeModelName: () => "openai/gpt-4.1" },
    );

    const channel = manager.getChannel("websocket");

    expect(channel).toBeInstanceOf(WebSocketChannel);
    expect((channel as WebSocketChannel).sessionManager).toBe(sessionManager);
    expect((channel as WebSocketChannel).workspacePath).toBe(path.resolve(root));
    expect((channel as WebSocketChannel).runtimeModelName?.()).toBe("openai/gpt-4.1");
  });

  it("routes channel admin HTTP requests to the injected admin API", async () => {
    const channel = makeChannel();
    const headers = withApiToken(channel);
    const admin = {
      definitions: vi.fn(() => ({ channels: [{ id: "wechat", runtimeChannel: "weixin" }] })),
      status: vi.fn(() => ({ connections: [{ provider: "wechat", status: "connected" }] })),
      configure: vi.fn(async (name: string) => ({ status: "connected", running: true, name })),
      stop: vi.fn(async (name: string) => ({ status: "disabled", running: false, name })),
      startWeixinLogin: vi.fn(async () => ({ status: "pendingQr", pollToken: "poll-1" })),
      pollWeixinLogin: vi.fn(async (token: string) => ({ status: "connected", token })),
    };

    channel.setChannelAdmin(admin as any);
    const dispatchJson = async (path: string) => {
      const response = await channel.dispatchHttp(localConnection, { path, headers });
      expect(response).not.toBeNull();
      return responseJson(response!);
    };

    expect(await dispatchJson("/api/channels/definitions")).toEqual({
      channels: [{ id: "wechat", runtimeChannel: "weixin" }],
    });
    expect(await dispatchJson("/api/channels/status")).toEqual({
      connections: [{ provider: "wechat", status: "connected" }],
    });
    expect(await dispatchJson("/api/channels/feishu/configure")).toMatchObject({
      status: "connected",
      name: "feishu",
    });
    expect(await dispatchJson("/api/channels/weixin/login/start")).toMatchObject({
      status: "pendingQr",
      pollToken: "poll-1",
    });
    expect(await dispatchJson("/api/channels/weixin/login/poll-1")).toMatchObject({
      status: "connected",
      token: "poll-1",
    });
    expect(await dispatchJson("/api/channels/feishu/stop")).toMatchObject({
      status: "disabled",
      name: "feishu",
    });
    expect(admin.configure).toHaveBeenCalledWith("feishu");
    expect(admin.stop).toHaveBeenCalledWith("feishu");
  });

  it("serves bootstrap, session listing, and session messages behind API tokens", async ({ task }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `memmy-ws-http-${task.id}-`));
    tmpDirs.push(root);
    const manager = new SessionManager(root);
    const session = new Session({ key: "websocket:abc" });
    session.addMessage("user", "hi");
    session.addMessage("assistant", "hello back");
    manager.save(session);
    const other = new Session({ key: "telegram:abc" });
    other.addMessage("user", "outside");
    manager.save(other);

    const channel = new WebSocketChannel(
      { enabled: true, allowFrom: ["*"], host: "127.0.0.1", port: 0, path: "/", websocketRequiresToken: false },
      new MessageBus(),
      { sessionManager: manager, runtimeModelName: () => "openai/gpt-4.1" },
    );
    running.push(channel);
    await channel.start();
    const port = (channel as any).server.address().port;

    const denied = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    expect(denied.status).toBe(401);

    const boot = await fetch(`http://127.0.0.1:${port}/webui/bootstrap`);
    expect(boot.status).toBe(200);
    const body = await boot.json() as Record<string, any>;
    expect(body.token).toMatch(/^nbwt_/);
    expect(body.ws_path).toBe("/");
    expect(body.model_name).toBe("openai/gpt-4.1");

    const headers = { Authorization: `Bearer ${body.token}` };
    const listing = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers });
    expect(listing.status).toBe(200);
    const sessions = (await listing.json() as any).sessions;
    expect(new Set(sessions.map((row: any) => row.key))).toEqual(
      new Set(["telegram:abc", "websocket:abc"]),
    );
    expect(sessions.every((row: any) => !Object.hasOwn(row, "path"))).toBe(true);

    const messages = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent("websocket:abc")}/messages`, { headers });
    expect(messages.status).toBe(200);
    const payload = await messages.json() as Record<string, any>;
    expect(payload.key).toBe("websocket:abc");
    expect(payload.messages.map((msg: any) => msg.role)).toEqual(["user", "assistant"]);
  });

  it("allows local renderer CORS preflight for WebUI bootstrap", async () => {
    const channel = makeChannel({ config: { tokenIssueSecret: "secret" } });
    const port = await startChannel(channel);
    const origin = "http://127.0.0.1:19000";

    const preflight = await fetch(`http://127.0.0.1:${port}/webui/bootstrap`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "x-memmy-agent-auth"
      }
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("x-memmy-agent-auth");

    const boot = await fetch(`http://127.0.0.1:${port}/webui/bootstrap`, {
      headers: {
        Origin: origin,
        "X-Memmy-Agent-Auth": "secret"
      }
    });
    expect(boot.status).toBe(200);
    expect(boot.headers.get("access-control-allow-origin")).toBe(origin);
    expect(await boot.json()).toEqual(expect.objectContaining({ ws_path: "/" }));
  });

  it("serves static SPA assets and rejects traversal", async ({ task }) => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), `memmy-ws-static-${task.id}-`));
    tmpDirs.push(dist);
    fs.writeFileSync(path.join(dist, "index.html"), "<main>memmy</main>");
    fs.writeFileSync(path.join(dist, "app.js"), "console.log('ok');");

    const channel = new WebSocketChannel(
      { enabled: true, allowFrom: ["*"], host: "127.0.0.1", port: 0, path: "/", websocketRequiresToken: false },
      new MessageBus(),
      { staticDistPath: dist },
    );
    running.push(channel);
    await channel.start();
    const port = (channel as any).server.address().port;

    const app = await fetch(`http://127.0.0.1:${port}/app.js`);
    expect(app.status).toBe(200);
    expect(await app.text()).toBe("console.log('ok');");
    expect(app.headers.get("cache-control")).toContain("immutable");

    const fallback = await fetch(`http://127.0.0.1:${port}/chat/abc`);
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toBe("<main>memmy</main>");

    expect((channel as any).serveStatic("/../secret.txt").status).toBe(403);
  });

  it("does not serve removed extension settings routes", async () => {
    const channel = makeChannel({ sessionManager: seedSession(tmpRoot()) });
    const port = await startChannel(channel);
    const headers = await authHeaders(port);
    const removedRoute = `/api/settings/${["cli", "apps"].join("-")}`;

    const catalog = await fetch(`http://127.0.0.1:${port}${removedRoute}`, { headers });
    expect(catalog.status).toBe(404);

    const installed = await fetch(`http://127.0.0.1:${port}${removedRoute}/install?name=gimp`, { headers });
    expect(installed.status).toBe(404);
  });

  it("serves MCP preset settings routes and validates JSON header payloads", async () => {
    const seen: Array<[string | null, Record<string, string[]>]> = [];
    routeMocks.mcpPresetsSettingsAction.mockImplementation(
      async (action: string | null, query: Record<string, string[]>) => {
        seen.push([action, query]);
        if (action == null) {
          return {
            presets: [
              {
                name: "browserbase",
                display_name: "Browserbase",
                category: "browser",
                description: "Cloud browser automation",
                status: "not_installed",
              },
            ],
            installed_count: 0,
          };
        }
        const subject = action === "import" ? "config" : query.name?.[0] ?? "config";
        return {
          presets: [],
          installed_count: 1,
          requires_restart: false,
          hot_reload: { ok: true, message: "MCP config reloaded.", requires_restart: false },
          last_action: { ok: true, message: `${action}:${subject} MCP config reloaded.` },
        };
      },
    );

    const channel = makeChannel({ sessionManager: seedSession(tmpRoot()) });
    const port = await startChannel(channel);

    const denied = await fetch(`http://127.0.0.1:${port}/api/settings/mcp-presets`);
    expect(denied.status).toBe(401);

    const headers = await authHeaders(port);
    const catalog = await fetch(`http://127.0.0.1:${port}/api/settings/mcp-presets`, { headers });
    expect(catalog.status).toBe(200);
    expect(((await catalog.json()) as any).presets[0].name).toBe("browserbase");

    const values = JSON.stringify({ browserbase_api_key: "bb_live_secret" });
    const enabled = await fetch(`http://127.0.0.1:${port}/api/settings/mcp-presets/enable?name=browserbase`, {
      headers: { ...headers, "X-Memmy-Agent-MCP-Values": values },
    });
    expect(enabled.status).toBe(200);
    expect(seen.at(-1)?.[1].browserbase_api_key).toEqual(["bb_live_secret"]);
    const bodyText = await enabled.text();
    expect(bodyText).not.toContain("bb_live_secret");
    const body = JSON.parse(bodyText);
    expect(body.last_action.message).toBe("enable:browserbase MCP config reloaded.");
    expect(body.hot_reload.ok).toBe(true);
    expect(body.restart_required_sections).toEqual([]);

    const badHeader = await fetch(`http://127.0.0.1:${port}/api/settings/mcp-presets/enable?name=browserbase`, {
      headers: { ...headers, "X-Memmy-Agent-MCP-Values": "[]" },
    });
    expect(badHeader.status).toBe(400);

    const custom = await fetch(`http://127.0.0.1:${port}/api/settings/mcp-presets/custom`, {
      headers: { ...headers, "X-Memmy-Agent-MCP-Values": JSON.stringify({ name: "docs", command: "npx" }) },
    });
    expect(custom.status).toBe(200);
    expect(seen.at(-1)?.[1].command).toEqual(["npx"]);
    expect(((await custom.json()) as any).last_action.message).toBe("custom:docs MCP config reloaded.");

    const imported = await fetch(`http://127.0.0.1:${port}/api/settings/mcp-presets/import`, {
      headers: { ...headers, "X-Memmy-Agent-MCP-Values": JSON.stringify({ config: "{}" }) },
    });
    expect(imported.status).toBe(200);
    expect(((await imported.json()) as any).last_action.message).toBe("import:config MCP config reloaded.");

    const tools = await fetch(`http://127.0.0.1:${port}/api/settings/mcp-presets/tools`, {
      headers: { ...headers, "X-Memmy-Agent-MCP-Values": JSON.stringify({ name: "docs", enabled_tools: [] }) },
    });
    expect(tools.status).toBe(200);
    expect(((await tools.json()) as any).last_action.message).toBe("tools:docs MCP config reloaded.");
  });

  it("serves image generation settings routes with independent tool config", async () => {
    const root = tmpRoot();
    process.env.MEMMY_CONFIG = path.join(root, "config.yaml");
    const channel = makeChannel({ sessionManager: seedSession(root) });
    const port = await startChannel(channel);
    const headers = await authHeaders(port);

    const params = new URLSearchParams({
      provider: "openai",
      enabled: "true",
      model: "gpt-image-2",
      apiKey: "sk-route-secret",
      apiBase: "https://api.openai.com/v1",
      maxImagesPerTurn: "24",
      extraBody: JSON.stringify({ quality: "low" }),
    });
    const updated = await fetch(`http://127.0.0.1:${port}/api/settings/image-generation/update?${params}`, { headers });

    expect(updated.status).toBe(200);
    const body = (await updated.json()) as Record<string, any>;
    expect(body.image_generation.provider_configured).toBe(true);
    expect(body.image_generation.api_key_hint).toBe("sk-r....cret");
    expect(body.image_generation.max_images_per_turn).toBe(24);
    expect(JSON.stringify(body)).not.toContain("sk-route-secret");
    expect(loadConfig(process.env.MEMMY_CONFIG).tools.imageGeneration).toMatchObject({
      provider: "openai",
      model: "gpt-image-2",
      apiKey: "sk-route-secret",
      apiBase: "https://api.openai.com/v1",
      maxImagesPerTurn: 24,
      extraBody: { quality: "low" },
    });

    const unlimited = await fetch(
      `http://127.0.0.1:${port}/api/settings/image-generation/update?max_images_per_turn=null`,
      { headers },
    );
    expect(unlimited.status).toBe(200);
    expect(((await unlimited.json()) as any).image_generation.max_images_per_turn).toBeNull();
    expect(loadConfig(process.env.MEMMY_CONFIG).tools.imageGeneration.maxImagesPerTurn).toBeNull();

    const settings = await fetch(`http://127.0.0.1:${port}/api/settings`, { headers });
    expect(settings.status).toBe(200);
    const settingsBody = (await settings.json()) as Record<string, any>;
    expect(settingsBody.image_generation.max_images_per_turn).toBeNull();
    expect(settingsBody.image_generation.providers.map((row: any) => row.name)).not.toEqual(
      expect.arrayContaining(["doubao", "baidu", "qwen"]),
    );

    const rejected = await fetch(
      `http://127.0.0.1:${port}/api/settings/image-generation/update?apiKey=sk-after&unexpected=value`,
      { headers },
    );
    expect(rejected.status).toBe(400);
    expect(loadConfig(process.env.MEMMY_CONFIG).tools.imageGeneration.apiKey).toBe("sk-route-secret");
  });

  it("lists desktop and supported channel sessions on the WebUI sessions route", () => {
    const supportedChannelKeys = desktopChannelSessionKeys.map(([, key]) => key);
    const manager = seedMany(tmpRoot(), [
      "cli:direct",
      "slack:C123",
      ...supportedChannelKeys,
      "websocket:alpha",
      "websocket:beta",
    ]);
    const channel = makeChannel({ sessionManager: manager });
    const listing = channel.handleSessionsList({ headers: withApiToken(channel) });
    expect(listing.status).toBe(200);
    const keys = new Set(responseJson(listing).sessions.map((session: any) => session.key));
    expect(keys).toEqual(new Set([...supportedChannelKeys, "websocket:alpha", "websocket:beta"]));
  });

  it.each(desktopChannelSessionKeys)("opens persisted %s messages without a WebUI transcript", (_channelName, sessionKey) => {
    const root = tmpRoot();
    const manager = new SessionManager(root);
    const session = new Session({ key: sessionKey });
    session.addMessage("user", "渠道里的问题", { timestamp: "2026-07-23T02:00:00.000Z" });
    session.addMessage("assistant", "渠道里的回答", { timestamp: "2026-07-23T02:00:01.000Z" });
    manager.save(session);

    const channel = makeChannel({ sessionManager: manager });
    const response = channel.handleWebuiThreadGet(
      { headers: withApiToken(channel) },
      encodeURIComponent(sessionKey),
    );

    expect(response.status).toBe(200);
    expect(responseJson(response)).toMatchObject({
      sessionKey,
      last_turn_closed: true,
      messages: [
        { role: "user", content: "渠道里的问题" },
        { role: "assistant", content: "渠道里的回答" },
      ],
    });
  });

  it("uses session message timestamps for WebUI thread messages when transcripts omit time", () => {
    const root = tmpRoot();
    process.env.MEMMY_AGENT_DATA_DIR = root;
    const manager = new SessionManager(root);
    const session = new Session({ key: "websocket:timed" });
    session.addMessage("user", "你好", { timestamp: "2026-06-19T08:07:00.000Z" });
    session.addMessage("assistant", "你好！", { timestamp: "2026-06-19T08:07:03.000Z" });
    manager.save(session);
    appendTranscriptObject("websocket:timed", { event: "user", chat_id: "timed", text: "你好" });
    appendTranscriptObject("websocket:timed", { event: "message", chat_id: "timed", text: "你好！" });
    const channel = makeChannel({ sessionManager: manager });

    const response = channel.handleWebuiThreadGet(
      { headers: withApiToken(channel) },
      encodeURIComponent("websocket:timed"),
    );
    expect(response.status).toBe(200);
    const body = responseJson(response);
    expect(body.messages[0]).toMatchObject({ role: "user", content: "你好", createdAt: Date.parse("2026-06-19T08:07:00.000Z") });
    expect(body.messages[1]).toMatchObject({ role: "assistant", content: "你好！", createdAt: Date.parse("2026-06-19T08:07:03.000Z") });
  });

  it("replays context compaction transcript rows as one WebUI divider message", () => {
    const root = tmpRoot();
    process.env.MEMMY_AGENT_DATA_DIR = root;
    const manager = new SessionManager(root);
    const session = new Session({ key: "websocket:compact" });
    session.addMessage("user", "继续");
    manager.save(session);
    appendTranscriptObject("websocket:compact", { event: "user", chat_id: "compact", text: "继续" });
    appendTranscriptObject("websocket:compact", {
      event: "context_compaction",
      chat_id: "compact",
      compaction_id: "context-compaction:turn-1",
      status: "running",
      text: "会话压缩中",
    });
    appendTranscriptObject("websocket:compact", {
      event: "context_compaction",
      chat_id: "compact",
      compaction_id: "context-compaction:turn-1",
      status: "done",
      text: "压缩已完成",
    });
    const channel = makeChannel({ sessionManager: manager });

    const response = channel.handleWebuiThreadGet(
      { headers: withApiToken(channel) },
      encodeURIComponent("websocket:compact"),
    );

    expect(response.status).toBe(200);
    const body = responseJson(response);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1]).toMatchObject({
      id: "context-compaction:context-compaction:turn-1",
      role: "tool",
      kind: "context_compaction",
      content: "压缩已完成",
      compactionId: "context-compaction:turn-1",
      compactionStatus: "done",
      isStreaming: false,
    });
    expect(body.messages[1]).not.toHaveProperty("traces");
  });

  it("serves the latest compaction summary for WebUI sessions only", async () => {
    const root = tmpRoot();
    const manager = new SessionManager(root);
    const legacy = new Session({ key: "websocket:legacy-summary" });
    legacy.metadata.lastSummary = "legacy text summary";
    manager.save(legacy);
    const dag = new Session({ key: "websocket:dag-summary" });
    dag.metadata.lastSummary = {
      text: "DAG snapshot summary",
      mode: "dag",
      dagSnapshotId: "snapshot-1",
      lastActive: "2026-07-08T08:00:00.000Z",
    };
    manager.save(dag);
    const empty = new Session({ key: "websocket:no-summary" });
    empty.metadata.lastSummary = { text: "" };
    manager.save(empty);
    const cli = new Session({ key: "cli:direct" });
    cli.metadata.lastSummary = "outside WebUI";
    manager.save(cli);
    const channel = makeChannel({ sessionManager: manager });
    const headers = withApiToken(channel);
    const route = (key: string) => `/api/sessions/${encodeURIComponent(key)}/last-compaction`;

    const denied = await channel.dispatchHttp(localConnection, { path: route("websocket:legacy-summary"), headers: {} });
    expect(denied?.status).toBe(401);

    const legacyResponse = await channel.dispatchHttp(localConnection, { path: route("websocket:legacy-summary"), headers });
    expect(legacyResponse?.status).toBe(200);
    expect(responseJson(legacyResponse!)).toEqual({
      available: true,
      sessionKey: "websocket:legacy-summary",
      mode: "text",
      text: "legacy text summary",
      lastActive: null,
    });

    const dagResponse = await channel.dispatchHttp(localConnection, { path: route("websocket:dag-summary"), headers });
    expect(dagResponse?.status).toBe(200);
    expect(responseJson(dagResponse!)).toEqual({
      available: true,
      sessionKey: "websocket:dag-summary",
      mode: "dag",
      text: "DAG snapshot summary",
      lastActive: "2026-07-08T08:00:00.000Z",
      dagSnapshotId: "snapshot-1",
    });

    const emptyResponse = await channel.dispatchHttp(localConnection, { path: route("websocket:no-summary"), headers });
    expect(emptyResponse?.status).toBe(200);
    expect(responseJson(emptyResponse!)).toEqual({
      available: false,
      sessionKey: "websocket:no-summary",
      mode: null,
      text: "",
      lastActive: null,
    });

    const cliResponse = await channel.dispatchHttp(localConnection, { path: route("cli:direct"), headers });
    expect(cliResponse?.status).toBe(404);
  });

  it("scopes WebUI sidebar state routes to the configured data directory", async () => {
    const root = tmpRoot();
    process.env.MEMMY_AGENT_DATA_DIR = root;
    const channel = makeChannel({ sessionManager: seedSession(root, "websocket:sidebar") });
    const port = await startChannel(channel);
    const headers = await authHeaders(port);

    const initial = await fetch(`http://127.0.0.1:${port}/api/webui/sidebar-state`, { headers });
    expect(initial.status).toBe(200);
    expect(((await initial.json()) as any).pinned_keys).toEqual([]);

    const payload = {
      pinned_keys: ["websocket:sidebar"],
      archived_keys: ["websocket:old"],
      title_overrides: { "websocket:sidebar": "Pinned work" },
      view: { density: "compact", show_archived: true },
    };
    const query = new URLSearchParams({ state: JSON.stringify(payload) });
    const updated = await fetch(`http://127.0.0.1:${port}/api/webui/sidebar-state/update?${query}`, { headers });
    expect(updated.status).toBe(200);
    const body = (await updated.json()) as Record<string, any>;
    expect(body.pinned_keys).toEqual(["websocket:sidebar"]);
    expect(body.title_overrides).toEqual({ "websocket:sidebar": "Pinned work" });
    expect(body.view.density).toBe("compact");
    expect(JSON.parse(fs.readFileSync(path.join(root, "webui", "sidebar-state.json"), "utf8")).pinned_keys).toEqual(["websocket:sidebar"]);
  });

  it("removes session and WebUI transcript files from the delete route", async () => {
    const root = tmpRoot();
    process.env.MEMMY_AGENT_DATA_DIR = root;
    const manager = seedSession(root, "websocket:doomed");
    appendTranscriptObject("websocket:doomed", { event: "user", chat_id: "doomed", text: "x" });
    const channel = makeChannel({ sessionManager: manager });
    const port = await startChannel(channel);
    const headers = await authHeaders(port);

    expect(fs.existsSync(manager.pathFor("websocket:doomed"))).toBe(true);
    expect(fs.existsSync(webuiTranscriptPath("websocket:doomed"))).toBe(true);
    const deleted = await fetch(`http://127.0.0.1:${port}/api/sessions/websocket:doomed/delete`, { headers });
    expect(deleted.status).toBe(200);
    expect(((await deleted.json()) as any).deleted).toBe(true);
    expect(fs.existsSync(manager.pathFor("websocket:doomed"))).toBe(false);
    expect(fs.existsSync(webuiTranscriptPath("websocket:doomed"))).toBe(false);
  });

  it("renames websocket session titles through the WebUI title route", async () => {
    const root = tmpRoot();
    const manager = seedSession(root, "websocket:rename");
    const channel = makeChannel({ sessionManager: manager });
    const port = await startChannel(channel);
    const headers = { ...(await authHeaders(port)), "content-type": "application/json" };

    const renamed = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent("websocket:rename")}/title`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "  我的会话  " }),
    });

    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as any).session).toMatchObject({
      key: "websocket:rename",
      title: "我的会话",
      preview: "hi from websocket:rename",
    });
    expect(manager.loadSession("websocket:rename")?.metadata).toMatchObject({
      title: "我的会话",
      titleUserEdited: true,
    });

    const listing = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers });
    expect(((await listing.json()) as any).sessions[0]).toMatchObject({ key: "websocket:rename", title: "我的会话" });
  });

  it("resolves, opens, and reveals WebUI artifacts through authenticated POST routes", async () => {
    const root = tmpRoot();
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const note = path.join(workspace, "result.md");
    const image = path.join(workspace, "diagram.png");
    const outside = path.join(root, "outside.md");
    const outsidePdf = path.join(root, "小短文.pdf");
    const outsideDir = path.join(root, "outside-dir");
    const missing = path.join(root, "missing.md");
    fs.writeFileSync(note, "# result", "utf8");
    fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(outside, "outside", "utf8");
    fs.writeFileSync(outsidePdf, "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n", "utf8");
    fs.mkdirSync(outsideDir);
    const resolvedNotePath = fs.realpathSync(note);
    const resolvedOutsideDir = fs.realpathSync(outsideDir);
    const spawn = childProcessMocks.spawn;
    const spawnSync = childProcessMocks.spawnSync;
    const channel = makeChannel({ sessionManager: seedSession(root), workspacePath: workspace });
    const port = await startChannel(channel);
    const headers = { ...(await authHeaders(port)), "content-type": "application/json" };

    const denied = await fetch(`http://127.0.0.1:${port}/api/webui/artifacts/resolve`, {
      method: "POST",
      body: JSON.stringify({ path: note }),
    });
    expect(denied.status).toBe(401);

    const wrongMethod = await fetch(`http://127.0.0.1:${port}/api/webui/artifacts/resolve`, { headers });
    expect(wrongMethod.status).toBe(405);

    const resolvedFile = await fetch(`http://127.0.0.1:${port}/api/webui/artifacts/resolve`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: note }),
    });
    expect(resolvedFile.status).toBe(200);
    expect(await resolvedFile.json()).toMatchObject({ ok: true, path: resolvedNotePath, name: "result.md", kind: "file" });

    const resolvedImage = await fetch(`http://127.0.0.1:${port}/api/webui/artifacts/resolve`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: "diagram.png" }),
    });
    expect(resolvedImage.status).toBe(200);
    expect(await resolvedImage.json()).toMatchObject({ ok: true, name: "diagram.png", kind: "image", media_url: expect.stringMatching(/^\/api\/media\//) });

    const stagedOutside = await fetch(`http://127.0.0.1:${port}/api/webui/artifacts/resolve`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: outside }),
    });
    expect(stagedOutside.status).toBe(200);
    expect(await stagedOutside.json()).toMatchObject({ ok: true, name: "outside.md", kind: "file", media_url: expect.stringMatching(/^\/api\/media\//) });

    const resolvedDirectory = await fetch(`http://127.0.0.1:${port}/api/webui/artifacts/resolve`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: outsideDir }),
    });
    expect(resolvedDirectory.status).toBe(200);
    expect(await resolvedDirectory.json()).toEqual({ ok: true, path: resolvedOutsideDir, name: "outside-dir", kind: "directory" });

    const rejected = await fetch(`http://127.0.0.1:${port}/api/webui/artifacts/resolve`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: missing }),
    });
    expect(rejected.status).toBe(404);

    if (process.platform !== "win32") {
      const rejectedSpecialFile = await fetch(`http://127.0.0.1:${port}/api/webui/artifacts/resolve`, {
        method: "POST",
        headers,
        body: JSON.stringify({ path: "/dev/null" }),
      });
      expect(rejectedSpecialFile.status).toBe(404);
    }

    const deniedOpen = await fetch(`http://127.0.0.1:${port}/api/webui/artifacts/open`, {
      method: "POST",
      body: JSON.stringify({ path: note }),
    });
    expect(deniedOpen.status).toBe(401);

    const wrongOpenMethod = await fetch(`http://127.0.0.1:${port}/api/webui/artifacts/open`, { headers });
    expect(wrongOpenMethod.status).toBe(405);

    const rejectedOpen = await fetch(`http://127.0.0.1:${port}/api/webui/artifacts/open`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: missing }),
    });
    expect(rejectedOpen.status).toBe(404);

    const opened = await fetch(`http://127.0.0.1:${port}/api/webui/artifacts/open`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: note }),
    });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toEqual({ ok: true, path: resolvedNotePath });
    expect(spawnSync).toHaveBeenCalled();
    const openArgs = (spawnSync.mock.calls.at(-1) as unknown as [unknown, string[]])[1];
    expect(openArgs).not.toContain("-R");

    const openedUnicodePdf = await fetch(`http://127.0.0.1:${port}/api/webui/artifacts/open`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: outsidePdf }),
    });
    expect(openedUnicodePdf.status).toBe(200);
    const openedUnicodePdfBody = await openedUnicodePdf.json() as Record<string, any>;
    expect(path.basename(openedUnicodePdfBody.path)).toMatch(/^[a-f0-9]{12}-小短文\.pdf$/u);
    const openUnicodePdfArgs = (spawnSync.mock.calls.at(-1) as unknown as [unknown, string[]])[1];
    expect(openUnicodePdfArgs).toContain(openedUnicodePdfBody.path);

    const openedDirectory = await fetch(`http://127.0.0.1:${port}/api/webui/artifacts/open`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: outsideDir }),
    });
    expect(openedDirectory.status).toBe(200);
    expect(await openedDirectory.json()).toEqual({ ok: true, path: resolvedOutsideDir });
    const openDirectoryArgs = (spawnSync.mock.calls.at(-1) as unknown as [unknown, string[]])[1];
    expect(openDirectoryArgs).toContain(resolvedOutsideDir);

    const revealed = await fetch(`http://127.0.0.1:${port}/api/webui/artifacts/reveal`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: note }),
    });
    expect(revealed.status).toBe(200);
    expect(await revealed.json()).toEqual({ ok: true, path: resolvedNotePath });
    const [revealCommand, revealArgs] = expectedRevealInvocation(resolvedNotePath);
    expect(spawn).toHaveBeenLastCalledWith(revealCommand, revealArgs, {
      detached: true,
      stdio: "ignore",
    });

    const revealedDirectory = await fetch(`http://127.0.0.1:${port}/api/webui/artifacts/reveal`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: outsideDir }),
    });
    expect(revealedDirectory.status).toBe(200);
    expect(await revealedDirectory.json()).toEqual({ ok: true, path: resolvedOutsideDir });
    const [revealDirectoryCommand, revealDirectoryArgs] = expectedRevealInvocation(resolvedOutsideDir);
    expect(spawn).toHaveBeenLastCalledWith(revealDirectoryCommand, revealDirectoryArgs, {
      detached: true,
      stdio: "ignore",
    });
  });

  it("accepts percent-encoded websocket session keys for messages and delete", async () => {
    const manager = seedSession(tmpRoot(), "websocket:encoded-key");
    const channel = makeChannel({ sessionManager: manager });
    const port = await startChannel(channel);
    const headers = await authHeaders(port);

    const encodedKey = encodeURIComponent("websocket:encoded-key");
    const messages = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodedKey}/messages`, { headers });
    expect(messages.status).toBe(200);
    expect(((await messages.json()) as any).key).toBe("websocket:encoded-key");

    expect(fs.existsSync(manager.pathFor("websocket:encoded-key"))).toBe(true);
    const deleted = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodedKey}/delete`, { headers });
    expect(deleted.status).toBe(200);
    expect(((await deleted.json()) as any).deleted).toBe(true);
    expect(fs.existsSync(manager.pathFor("websocket:encoded-key"))).toBe(false);
  });

  it("rejects session keys that are not visible in the desktop history", async () => {
    const manager = seedMany(tmpRoot(), ["websocket:kept", "cli:direct", "slack:C123"]);
    const channel = makeChannel({ sessionManager: manager });
    const port = await startChannel(channel);
    const headers = await authHeaders(port);

    const messages = await fetch(`http://127.0.0.1:${port}/api/sessions/cli:direct/messages`, { headers });
    expect(messages.status).toBe(404);
    expect(fs.existsSync(manager.pathFor("slack:C123"))).toBe(true);
    const deleted = await fetch(`http://127.0.0.1:${port}/api/sessions/slack:C123/delete`, { headers });
    expect(deleted.status).toBe(404);
    expect(fs.existsSync(manager.pathFor("slack:C123"))).toBe(true);
  });

  it("rejects invalid session keys on session routes", async () => {
    const channel = makeChannel({ sessionManager: seedSession(tmpRoot()) });
    const port = await startChannel(channel);
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/bad%20key/messages`, { headers: await authHeaders(port) });
    expect(response.status).toBe(400);
  });

  it("serves the SPA index from a static distribution directory", async () => {
    const dist = tmpRoot("memmy-ws-static-");
    fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>nbweb</title>", "utf8");
    fs.writeFileSync(path.join(dist, "favicon.svg"), "<svg/>", "utf8");
    const channel = makeChannel({ sessionManager: seedSession(tmpRoot()), staticDistPath: dist });
    const port = await startChannel(channel);

    const root = await fetch(`http://127.0.0.1:${port}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("nbweb");
    const asset = await fetch(`http://127.0.0.1:${port}/favicon.svg`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("<svg");
    const spa = await fetch(`http://127.0.0.1:${port}/sessions/abc`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain("nbweb");
  });

  it("returns 404 for unknown HTTP API routes", async () => {
    const channel = makeChannel();
    const port = await startChannel(channel);
    const response = await fetch(`http://127.0.0.1:${port}/api/unknown`);
    expect(response.status).toBe(404);
  });

  it("purges expired API tokens while keeping live tokens", () => {
    const channel = makeChannel({ sessionManager: seedSession(tmpRoot()) });
    const now = Date.now() / 1000;
    (channel as any).apiTokens.set("expired", now - 1);
    (channel as any).apiTokens.set("live", now + 60);
    expect((channel as any).checkApiToken({ path: "/api/sessions", headers: { Authorization: "Bearer expired" } })).toBe(false);
    expect((channel as any).apiTokens.has("expired")).toBe(false);
    expect((channel as any).checkApiToken({ path: "/api/sessions", headers: { Authorization: "Bearer live" } })).toBe(true);
  });

  it("rejects wildcard host configuration without bootstrap auth", () => {
    expect(() => makeChannel({ config: { host: "0.0.0.0" } })).toThrow(/token/);
  });

  it("allows wildcard host configuration with a static token", () => {
    const channel = makeChannel({ config: { host: "0.0.0.0", token: "my-token" } });
    expect(channel.config.host).toBe("0.0.0.0");
  });

  it("allows wildcard host configuration with an issue secret", () => {
    const channel = makeChannel({ config: { host: "0.0.0.0", tokenIssueSecret: "s3cret" } });
    expect(channel.config.host).toBe("0.0.0.0");
  });

  it("rejects wildcard IPv6 configuration without bootstrap auth", () => {
    expect(() => makeChannel({ config: { host: "::" } })).toThrow(/token/);
  });

  it("allows wildcard IPv6 bootstrap when a secret is provided", () => {
    const channel = makeChannel({ config: { host: "::", tokenIssueSecret: "s3cret" } });
    const response = (channel as any).handleBootstrap(remoteConnection, { headers: { "X-Memmy-Agent-Auth": "s3cret" } });
    expect(response.status).toBe(200);
  });

  it("accepts the static websocket token as a bootstrap secret", () => {
    const channel = makeChannel({ config: { host: "0.0.0.0", token: "static-tok" } });
    const response = (channel as any).handleBootstrap(remoteConnection, { headers: { Authorization: "Bearer static-tok" } });
    expect(response.status).toBe(200);
    expect(responseJson(response).token).toMatch(/^nbwt_/);
  });

  it("allows localhost bootstrap without auth when no secret is configured", () => {
    const channel = makeChannel();
    const response = (channel as any).handleBootstrap(localConnection, noHeaders);
    expect(response.status).toBe(200);
  });

  it("prefers the runtime model name in bootstrap payloads", () => {
    const channel = makeChannel({ runtimeModelName: () => "  live/model  " });
    const response = (channel as any).handleBootstrap(localConnection, noHeaders);
    expect(response.status).toBe(200);
    expect(responseJson(response).model_name).toBe("live/model");
  });

  it("falls back to config model name when runtime returns empty", () => {
    const root = tmpRoot();
    configModel(root, "from-disk");
    const channel = makeChannel({ runtimeModelName: () => "   " });
    const response = (channel as any).handleBootstrap(localConnection, noHeaders);
    expect(response.status).toBe(200);
    expect(responseJson(response).model_name).toBe("from-disk");
  });

  it("falls back to config model name when runtime resolver throws", () => {
    const root = tmpRoot();
    configModel(root, "from-disk");
    const channel = makeChannel({
      runtimeModelName: () => {
        throw new Error("resolver failed");
      },
    });
    const response = (channel as any).handleBootstrap(localConnection, noHeaders);
    expect(response.status).toBe(200);
    expect(responseJson(response).model_name).toBe("from-disk");
  });

  it("rejects bootstrap with the wrong issue secret", () => {
    const channel = makeChannel({ config: { host: "0.0.0.0", tokenIssueSecret: "correct" } });
    const response = (channel as any).handleBootstrap(remoteConnection, { headers: { Authorization: "Bearer wrong" } });
    expect(response.status).toBe(401);
  });

  it("accepts remote bootstrap with a valid bearer secret", () => {
    const channel = makeChannel({ config: { host: "0.0.0.0", tokenIssueSecret: "s3cret" } });
    const response = (channel as any).handleBootstrap(remoteConnection, { headers: { Authorization: "Bearer s3cret" } });
    expect(response.status).toBe(200);
    expect(responseJson(response).token).toMatch(/^nbwt_/);
  });

  it("accepts remote bootstrap with the X-Memmy-Agent-Auth header", () => {
    const channel = makeChannel({ config: { host: "0.0.0.0", tokenIssueSecret: "s3cret" } });
    const response = (channel as any).handleBootstrap(remoteConnection, { headers: { "X-Memmy-Agent-Auth": "s3cret" } });
    expect(response.status).toBe(200);
  });

  it("enforces bootstrap secrets even for localhost connections", () => {
    const channel = makeChannel({ config: { host: "0.0.0.0", tokenIssueSecret: "s3cret" } });
    const response = (channel as any).handleBootstrap(localConnection, noHeaders);
    expect(response.status).toBe(401);
  });
});
