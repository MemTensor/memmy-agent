import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../src/core/agent-runtime/loop.js";
import { Config } from "../../src/config/schema.js";
import { InboundMessage } from "../../src/core/runtime-messages/events.js";
import { LLMResponse } from "../../src/providers/base.js";
import { ProjectStore } from "../../src/entrypoints/frontend-bridge/projects.js";

const roots: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-memory-loop-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AgentLoop memmy memory integration", () => {
  it("installs memmy memory hook and tools when enabled", async () => {
    const loop = new AgentLoop({
      config: new Config({
        fileMemory: { enabled: false },
        memmyMemory: { enabled: true },
      }),
      provider: { generation: {}, getDefaultModel: () => "test-model" },
      workspace: tempRoot(),
      model: "test-model",
    });

    expect(loop.tools.get("memmy_memory_search")).toBeDefined();
    expect(loop.tools.get("memmy_memory_get")).toBeDefined();
    expect(loop.dream).toBeNull();
    expect(loop.context.buildSystemPrompt()).not.toContain("# File Memory");
  });

  it("installs memmy memory hook and tools by default", () => {
    const loop = new AgentLoop({
      provider: { generation: {}, getDefaultModel: () => "test-model" },
      workspace: tempRoot(),
      model: "test-model",
    });

    expect(loop.tools.get("memmy_memory_search")).toBeDefined();
    expect(loop.tools.get("memmy_memory_get")).toBeDefined();
  });

  it("keeps memmy memory disabled when explicitly disabled", () => {
    const loop = new AgentLoop({
      config: new Config({
        fileMemory: { enabled: true },
        memmyMemory: { enabled: false },
      }),
      provider: { generation: {}, getDefaultModel: () => "test-model" },
      workspace: tempRoot(),
      model: "test-model",
    });

    expect(loop.tools.get("memmy_memory_search")).toBeUndefined();
    expect(loop.dream).not.toBeNull();
    expect(loop.context.buildSystemPrompt()).toContain("# File Memory");
  });

  it("keeps both memory systems independently disabled", () => {
    const loop = new AgentLoop({
      config: new Config({
        fileMemory: { enabled: false },
        memmyMemory: { enabled: false },
      }),
      provider: { generation: {}, getDefaultModel: () => "test-model" },
      workspace: tempRoot(),
      model: "test-model",
    });

    expect(loop.tools.get("memmy_memory_search")).toBeUndefined();
    expect(loop.dream).toBeNull();
    expect(loop.context.buildSystemPrompt()).not.toContain("# File Memory");
  });

  it("keeps both memory systems active when both are enabled", () => {
    const loop = new AgentLoop({
      config: new Config({
        fileMemory: { enabled: true },
        memmyMemory: { enabled: true },
      }),
      provider: { generation: {}, getDefaultModel: () => "test-model" },
      workspace: tempRoot(),
      model: "test-model",
    });

    expect(loop.tools.get("memmy_memory_search")).toBeDefined();
    expect(loop.dream).not.toBeNull();
    expect(loop.context.buildSystemPrompt()).toContain("# File Memory");
  });

  it("refreshes project L3 before every Turn while keeping one Memory Session and project scope", async () => {
    const profileRoot = tempRoot();
    const projectRoot = tempRoot();
    const memmyHome = tempRoot();
    const projectStore = new ProjectStore({ filePath: path.join(profileRoot, "projects.json") });
    const project = projectStore.add(projectRoot, "existing");
    const requests: Array<{ path: string; body: Record<string, any> }> = [];
    const modelMessages: Record<string, any>[][] = [];
    let contextVersion = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("MEMMY_MEMORY_URL", "http://memory.test");
    vi.stubEnv("MEMMY_HOME", memmyHome);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      requests.push({ path: url.pathname, body });
      if (url.pathname === "/api/v1/health") return response(validHealth());
      if (url.pathname === "/api/v1/sessions/open") {
        return response({ sessionId: "memory-session-1", projectId: "memory-project-1", resumed: false });
      }
      if (url.pathname.endsWith("/context")) {
        contextVersion += 1;
        if (contextVersion === 3) {
          return response({ error: { message: "context unavailable" } }, 503);
        }
        return response({
          schemaVersion: 2,
          projectId: "memory-project-1",
          memoryId: "world-model-1",
          memoryVersion: contextVersion,
          renderedContext: `L3_V${contextVersion}`,
          sourceMemoryIds: ["l1-old"],
          generalRulesAndSafetyConstraints: null,
          projectEnvironmentProfile: "语言：TypeScript",
          projectContract: `L3_V${contextVersion}`,
          domainKnowledge: null,
          serverTime: "2026-08-19T00:00:00.000Z",
        });
      }
      if (url.pathname === "/api/v1/turns/start") {
        return response({ turnId: body.turnId, episodeId: "episode-1", sourceMemoryIds: [] });
      }
      if (url.pathname.includes("/complete")) {
        return response({ rawTurnId: "raw-1", l1MemoryId: "l1-1" });
      }
      if (url.pathname.endsWith("/close")) {
        return response({ sessionId: "memory-session-1", status: "closed" });
      }
      return response({}, 404);
    }));
    const loop = new AgentLoop({
      config: new Config({
        fileMemory: { enabled: false },
        app: { userId: "loop-user" },
        memmyMemory: { enabled: true },
      }),
      provider: {
        generation: { maxTokens: 256 },
        getDefaultModel: () => "test-model",
        chatWithRetry: vi.fn(async ({ messages }: { messages: Record<string, any>[] }) => {
          modelMessages.push(messages);
          return new LLMResponse({ content: "done" });
        }),
      },
      workspace: profileRoot,
      projectStore,
      model: "test-model",
    });
    const binding = { projectId: project.id, cwd: fs.realpathSync(projectRoot) };
    loop.sessions.reserveWebuiSessionBinding("websocket:memory-project", binding);

    await loop.processMessage(new InboundMessage({
      channel: "websocket",
      chatId: "memory-project",
      senderId: "user",
      content: "continue the project",
      metadata: { webui: true },
    }));
    await loop.processMessage(new InboundMessage({
      channel: "websocket",
      chatId: "memory-project",
      senderId: "user",
      content: "continue with the latest project context",
      metadata: { webui: true },
    }));
    await loop.processMessage(new InboundMessage({
      channel: "websocket",
      chatId: "memory-project",
      senderId: "user",
      content: "continue while Memory context is temporarily unavailable",
      metadata: { webui: true },
    }));
    await loop.closeRuntimeTools();

    const opened = requests.find((request) => request.path === "/api/v1/sessions/open")!;
    expect(opened.body).toMatchObject({
      l3WorldModelProtocolVersion: 2,
      workspaceUri: expect.stringMatching(/^file:\/\//u),
      workspaceHostId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      namespace: { sessionKey: "websocket:memory-project", userId: "loop-user" },
    });
    expect(JSON.stringify(opened.body)).not.toContain(project.id);
    expect(requests.filter((request) => request.path === "/api/v1/sessions/open")).toHaveLength(1);
    expect(requests.filter((request) => request.path.endsWith("/context"))).toHaveLength(3);

    const agentPrompts = modelMessages
      .map((messages) => messages.find((message) => message.role === "system")?.content)
      .filter((content): content is string => typeof content === "string" && content.includes("L3_V"));
    expect(agentPrompts).toHaveLength(3);
    expect(agentPrompts[0]).toContain("L3_V1");
    expect(agentPrompts[0]).not.toContain("L3_V2");
    expect(agentPrompts[1]).toContain("L3_V2");
    expect(agentPrompts[1]).not.toContain("L3_V1");
    expect(agentPrompts[2]).toContain("L3_V2");
    expect(agentPrompts[2]).not.toContain("L3_V1");
    for (const prompt of agentPrompts) {
      expect(prompt.match(/<memmy_l3_world_model version="2">/gu)).toHaveLength(1);
    }

    const scopedRequests = requests.filter((request) =>
      request.path === "/api/v1/turns/start" || request.path.includes("/complete") || request.path.endsWith("/close")
    );
    expect(scopedRequests).toHaveLength(7);
    for (const request of scopedRequests) {
      expect(request.body.namespace).toMatchObject({
        projectId: "memory-project-1",
        sessionKey: "websocket:memory-project",
      });
      expect(JSON.stringify(request.body)).not.toContain(project.id);
    }
    expect(requests.filter((request) => request.path.endsWith("/close"))).toHaveLength(1);
    warn.mockRestore();
  });
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function validHealth(): Record<string, unknown> {
  return {
    ok: true,
    version: "1.0.9",
    uptimeMs: 10,
    mode: "local",
    storage: { backend: "sqlite", schemaVersion: "v6", ready: true },
    capabilities: { routes: [], tools: [], memoryLayers: ["L1", "L2", "L3", "Skill"], supportsCli: true },
    features: { l3WorldModelProtocolVersions: [2] },
    models: {
      summary: { configured: true, provider: "host", model: "test", remote: false, routing: "fixed" },
      evolution: { configured: true, provider: "host", model: "test", remote: false, routing: "fixed" },
      embedding: { configured: true, provider: "local", model: "test", remote: false, mode: "local" },
    },
    serverTime: "2026-08-19T00:00:00.000Z",
  };
}
