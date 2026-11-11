import { InstalledPluginSchema, type InstalledPlugin } from "@memmy/local-api-contracts";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginService } from "../../../../services/plugin-service.js";
import { createProgressBus } from "../../../../services/progress-bus.js";
import { registerPluginRoutes } from "../routes/plugins.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const plugin = InstalledPluginSchema.parse({
  id: "com.example.review",
  version: "1.0.0",
  manifest: {
    apiVersion: "memmy/v1",
    id: "com.example.review",
    name: "Review",
    version: "1.0.0",
    runtime: { adapter: "http", config: { baseUrl: "https://plugin.example" } },
    capabilities: [{
      id: "run",
      name: "Run",
      description: "Run a review",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      execution: "job"
    }],
    permissions: []
  },
  state: "active",
  approvedPermissions: [],
  config: {},
  lastError: null,
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z"
});

function createService(): PluginService {
  return {
    catalog: vi.fn(async () => []), isBusy: () => false, suspend: vi.fn(async () => undefined),
    list: vi.fn(() => [plugin]),
    get: vi.fn(() => plugin),
    readUi: vi.fn(async (_id, slot) => `<main>${slot}</main>`),
    openArtifact: vi.fn(async () => ({ path: fileURLToPath(import.meta.url), name: "report.txt", mediaType: "text/plain" })),
    install: vi.fn(async () => plugin),
    update: vi.fn(async () => plugin),
    configure: vi.fn(() => plugin),
    approvePermissions: vi.fn(async () => plugin),
    enable: vi.fn(async () => plugin),
    disable: vi.fn(async () => plugin),
    uninstall: vi.fn(async () => undefined),
    async *invoke() {
      yield { type: "progress", current: 1, total: 1 };
      yield { type: "result", output: { ok: true } };
    },
    cancel: vi.fn(async () => undefined),
    respond: vi.fn(async () => undefined),
    restoreActive: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined)
  };
}

function createApp(
  plugins: PluginService,
  onEvent?: (event: unknown) => void,
  refreshAgentTools?: () => Promise<void>
): FastifyInstance {
  const progressBus = createProgressBus();
  if (onEvent) progressBus.on("plugin.capability_event", onEvent);
  const server = Fastify({ logger: false });
  registerPluginRoutes(server, {
    plugins,
    progressBus,
    authenticateRuntimeToken: async () => undefined,
    refreshAgentTools
  });
  return server;
}

describe("plugin routes", () => {
  it("keeps declared status polling out of chat events and rejects hidden state changes", async () => {
    const service = createService(), onEvent = vi.fn();
    const capture = structuredClone(plugin);
    capture.manifest.skills = [{ id: "capture-start", name: "Capture", description: "Capture authorized events", entry: "skills/capture/SKILL.md" }];
    capture.manifest.conversation = { recordingCapabilityId: "run", recordingSkillId: "capture-start" };
    vi.mocked(service.get).mockReturnValue(capture);
    app = createApp(service, onEvent);
    const url = `/api/v1/plugins/${plugin.id}/capabilities/run/invoke`;
    const response = await app.inject({ method: "POST", url, payload: { conversationId: "chat-a", origin: "user", background: true, input: { action: "status" } } });
    expect(response.statusCode).toBe(200); expect(onEvent).not.toHaveBeenCalled();
    const hiddenStart = await app.inject({ method: "POST", url, payload: { conversationId: "chat-a", origin: "user", background: true, input: { action: "start" } } });
    expect(hiddenStart.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, payload: { conversationId: "chat-a", origin: "user", input: { action: "stop" } } })).statusCode).toBe(200);
    expect(onEvent).toHaveBeenCalled();
  });

  it("installs and manages plugins by id", async () => {
    const plugins = createService();
    const refreshAgentTools = vi.fn(async () => undefined);
    app = createApp(plugins, undefined, refreshAgentTools);

    expect((await app.inject({ method: "POST", url: "/api/v1/plugins/install", payload: {
      pluginId: plugin.id,
      version: plugin.version
    } })).statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/api/v1/plugins" })).json()).toEqual([plugin]);
    expect((await app.inject({ method: "POST", url: `/api/v1/plugins/${plugin.id}/enable` })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/plugins/${plugin.id}` })).json()).toEqual({ ok: true });
    expect(plugins.install).toHaveBeenCalledWith(plugin.id, plugin.version);
    expect(plugins.uninstall).toHaveBeenCalledWith(plugin.id);
    expect(refreshAgentTools).toHaveBeenCalledTimes(3);
  });

  it("returns the installed plugin renderer", async () => {
    const plugins = createService();
    app = createApp(plugins);

    const response = await app.inject({ method: "GET", url: `/api/v1/plugins/${plugin.id}/ui/renderer` });

    expect(response.json()).toEqual({ html: "<main>renderer</main>" });
    expect(plugins.readUi).toHaveBeenCalledWith(plugin.id, "renderer");
    expect((await app.inject({ method: "GET", url: `/api/v1/plugins/${plugin.id}/ui/surface` })).json()).toEqual({ html: "<main>surface</main>" });
  });

  it("serves Host-validated plugin artifacts for preview and download", async () => {
    const plugins = createService();
    app = createApp(plugins);

    const preview = await app.inject({ method: "GET", url: `/api/v1/plugins/${plugin.id}/artifacts/00000000-0000-4000-8000-000000000000/preview` });
    const download = await app.inject({ method: "GET", url: `/api/v1/plugins/${plugin.id}/artifacts/00000000-0000-4000-8000-000000000000/download` });

    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-disposition"]).toContain("inline");
    expect(preview.headers["content-security-policy"]).toContain("sandbox");
    expect(download.headers["content-disposition"]).toContain("attachment");
    expect(plugins.openArtifact).toHaveBeenCalledTimes(2);
  });

  it("streams capability events and returns only the terminal event", async () => {
    const events: unknown[] = [];
    app = createApp(createService(), (event) => events.push(event));

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/plugins/${plugin.id}/capabilities/run/invoke`,
      payload: { conversationId: "conversation-1", input: { topic: "memory" } }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ event: { type: "result", output: { ok: true } } });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ pluginId: plugin.id, capabilityId: "run", event: { type: "progress" } });
  });

  it("rejects invalid install input before calling the service", async () => {
    const plugins = createService();
    app = createApp(plugins);

    const response = await app.inject({ method: "POST", url: "/api/v1/plugins/install", payload: {
      pluginId: "Not Valid"
    } });

    expect(response.statusCode).toBe(400);
    expect(plugins.install).not.toHaveBeenCalled();
  });
});
