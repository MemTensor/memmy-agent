import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryHttpServer,
  DEFAULT_MEMMY_CONFIG,
  MemoryDb,
  MemoryService,
  type Embedder,
  type LlmClient
} from "../src/index.js";
import type { AgentSourceExecutor } from "../src/agent-source/runtime.js";
import type { ViewerCliOptions } from "../src/server/viewer-cli.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("local Viewer API", () => {
  it("serves versioned health and protects config writes and secrets", async () => {
    const fixture = await startFixture();
    const health = await fetch(`${fixture.baseUrl}/health`);
    expect(await health.json()).toMatchObject({
      ok: true,
      serviceVersion: "2.1.0",
      protocolVersion: 1,
      viewerUrl: expect.stringContaining("/viewer")
    });

    const config = await viewerFetch(fixture.baseUrl, "/api/v1/config");
    const configText = await config.text();
    expect(configText).not.toContain("hub-secret");
    expect(JSON.parse(configText)).toMatchObject({
      config: {
        agentAccess: {
          autoScanKnownAgents: true,
          watchFileChanges: true,
          autoInjectSkill: false
        }
      }
    });

    const crossSite = await fetch(`${fixture.baseUrl}/api/v1/config`, {
      headers: { "x-memmy-viewer": "1", origin: "http://evil.example" }
    });
    expect(crossSite.status).toBe(403);

    const missingViewerHeader = await fetch(`${fixture.baseUrl}/api/v1/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: { timeZone: "+08:00" } })
    });
    expect(missingViewerHeader.status).toBe(404);

    const missingJsonContentType = await fetch(`${fixture.baseUrl}/api/v1/config`, {
      method: "PATCH",
      headers: { "x-memmy-viewer": "1" },
      body: JSON.stringify({ config: { timeZone: "+08:00" } })
    });
    expect(missingJsonContentType.status).toBe(400);

    const readOnly = await viewerFetch(fixture.baseUrl, "/api/v1/config", {
      method: "PATCH",
      body: JSON.stringify({ config: { storage: { sqlitePath: "/tmp/other.sqlite" } } })
    });
    expect(readOnly.status).toBe(400);

    const updated = await viewerFetch(fixture.baseUrl, "/api/v1/config", {
      method: "PATCH",
      body: JSON.stringify({ config: { timeZone: "+08:00", hub: { teamToken: "********" } } })
    });
    expect(updated.status).toBe(200);
    expect(readFileSync(fixture.configPath, "utf8")).toContain("+08:00");
    expect(readFileSync(fixture.configPath, "utf8")).toContain("hub-secret");
    expect(readFileSync(fixture.configPath, "utf8")).not.toContain("********");

    const agentSources = await viewerFetch(fixture.baseUrl, "/api/v1/agent-sources");
    expect(await agentSources.json()).toMatchObject({
      executorAvailable: true,
      sources: expect.arrayContaining([
        expect.objectContaining({ sourceId: "codex" }),
        expect.objectContaining({ sourceId: "openclaw" }),
        expect.objectContaining({ sourceId: "hermes" })
      ])
    });
  });

  it("writes Viewer model settings to memmyMemory and keeps the Desktop catalog in sync", async () => {
    const fixture = await startFixture();
    const response = await viewerFetch(fixture.baseUrl, "/api/v1/config", {
      method: "PATCH",
      body: JSON.stringify({
        config: {
          roleRouting: { summary: "fixed", evolution: "fixed" },
          summary: {
            provider: "openai_compatible",
            endpoint: "https://summary.example/v1",
            model: "summary-model",
            apiKey: "summary-secret"
          },
          evolution: {
            provider: "anthropic",
            endpoint: "https://evolution.example/v1",
            model: "evolution-model",
            apiKey: "evolution-secret"
          },
          embedding: {
            mode: "custom",
            provider: "openai_compatible",
            endpoint: "https://embedding.example/v1",
            model: "embedding-model",
            apiKey: "embedding-secret"
          },
          telemetry: { enabled: true }
        }
      })
    });
    expect(response.status).toBe(200);

    const raw = YAML.parse(readFileSync(fixture.configPath, "utf8")) as any;
    expect(raw.memmyMemory).toMatchObject({
      roleRouting: { summary: "fixed", evolution: "fixed" },
      summary: {
        endpoint: "https://summary.example/v1",
        model: "summary-model",
        apiKey: "summary-secret"
      },
      evolution: {
        endpoint: "https://evolution.example/v1",
        model: "evolution-model",
        apiKey: "evolution-secret"
      },
      embedding: {
        mode: "custom",
        endpoint: "https://embedding.example/v1",
        model: "embedding-model",
        apiKey: "embedding-secret"
      },
      telemetry: { enabled: true }
    });
    expect(raw.modelAssignments.byok).toMatchObject({
      memorySummary: expect.any(String),
      memoryEvolution: expect.any(String),
      embedding: expect.any(String)
    });
    expect(raw.modelPresets[raw.modelAssignments.byok.memorySummary]).toMatchObject({
      source: "byok",
      model: "summary-model",
      capabilities: ["memory_summary"]
    });
    expect(raw.modelPresets[raw.modelAssignments.byok.memoryEvolution]).toMatchObject({
      source: "byok",
      model: "evolution-model",
      capabilities: ["memory_evolution"]
    });
    expect(raw.modelPresets[raw.modelAssignments.byok.embedding]).toMatchObject({
      source: "byok",
      model: "embedding-model",
      capabilities: ["embedding"]
    });
  });

  it("writes shared cross-Agent scan preferences to memmyMemory", async () => {
    const fixture = await startFixture();
    const response = await viewerFetch(fixture.baseUrl, "/api/v1/config", {
      method: "PATCH",
      body: JSON.stringify({
        config: {
          agentAccess: {
            autoScanKnownAgents: false,
            watchFileChanges: true,
            autoInjectSkill: true
          }
        }
      })
    });
    expect(response.status).toBe(200);
    const raw = YAML.parse(readFileSync(fixture.configPath, "utf8")) as any;
    expect(raw.memmyMemory.agentAccess).toEqual({
      autoScanKnownAgents: false,
      watchFileChanges: true,
      autoInjectSkill: true
    });
  });

  it("exposes standalone scan pause and cancel controls to the Viewer", async () => {
    const pauseScan = vi.fn(async () => ({ ok: true as const }));
    const cancelScan = vi.fn(async () => ({ ok: true as const }));
    const agentSourceExecutor: AgentSourceExecutor = {
      list: async () => ({ executorAvailable: true, sources: [] }),
      startScan: async () => ({ accepted: true, jobId: "scan-1" }),
      scanStatus: () => ({
        running: true,
        jobId: "scan-1",
        sourceId: "codex",
        mode: null,
        progress: { sourceId: "codex", phase: "scan", current: 3, total: 10 },
        startedAt: "2026-08-28T00:00:00.000Z",
        completedAt: null,
        error: null
      }),
      pauseScan,
      cancelScan,
      mutateConnection: async () => ({ ok: true }),
      startAutomation: () => undefined,
      dispose: () => undefined
    };
    const fixture = await startFixture({ agentSourceExecutor });

    const paused = await viewerFetch(fixture.baseUrl, "/api/v1/agent-sources/scan/stop", {
      method: "POST",
      body: "{}"
    });
    expect(paused.status).toBe(200);
    expect(await paused.json()).toEqual({ ok: true });
    expect(pauseScan).toHaveBeenCalledOnce();

    const canceled = await viewerFetch(fixture.baseUrl, "/api/v1/agent-sources/scan/cancel", {
      method: "POST",
      body: "{}"
    });
    expect(canceled.status).toBe(200);
    expect(await canceled.json()).toEqual({ ok: true });
    expect(cancelScan).toHaveBeenCalledOnce();
  });

  it("reports and installs the memmy-memory CLI through the local Viewer boundary", async () => {
    const home = mkdtempSync(join(tmpdir(), "memmy-viewer-cli-api-"));
    const cliEntrypoint = join(home, "runtime", "dist", "src", "cli", "index.js");
    mkdirSync(join(cliEntrypoint, ".."), { recursive: true });
    writeFileSync(cliEntrypoint, "// cli fixture\n");
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const viewerCli = {
      home,
      cliEntrypoint,
      executable: "/opt/memmy/node",
      platform: "darwin" as const,
    };
    const fixture = await startFixture({ viewerCli });

    const before = await viewerFetch(fixture.baseUrl, "/api/v1/system/cli");
    expect(await before.json()).toMatchObject({ installed: false });

    const installed = await viewerFetch(fixture.baseUrl, "/api/v1/system/cli/install", {
      method: "POST",
      body: "{}",
    });
    expect(installed.status).toBe(200);
    expect(await installed.json()).toMatchObject({
      installed: true,
      path: "~/.local/bin/memmy-memory",
    });
  });

  it("restarts the installed user service after returning the Viewer response", async () => {
    let restartRequested = false;
    const fixture = await startFixture({
      onRestartRequested: () => {
        restartRequested = true;
      },
    });

    const response = await viewerFetch(fixture.baseUrl, "/api/v1/system/restart", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true });
    await expect.poll(() => restartRequested).toBe(true);
  });

  it("resumes SSE changes from Last-Event-ID and exposes migrated Hub rows", async () => {
    const fixture = await startFixture();
    fixture.db.db.prepare(
      "INSERT INTO runtime_kv (key, value_json, updated_at) VALUES (?, ?, ?)"
    ).run("legacy_hub:openclaw:hub_users:user-1", JSON.stringify({ source: "openclaw" }), new Date().toISOString());
    const hub = await viewerFetch(fixture.baseUrl, "/api/v1/hub/items");
    expect(await hub.json()).toMatchObject({ total: 1 });

    const first = fixture.service.addMemory({
      content: "first SSE memory",
      source: "viewer-test",
      layer: "L1",
      title: "first"
    });
    const firstEvent = await readOneEvent(fixture.baseUrl, "0");
    expect(firstEvent).toContain(first.id);
    const firstEventId = eventId(firstEvent);

    const second = fixture.service.addMemory({
      content: "second SSE memory",
      source: "viewer-test",
      layer: "L1",
      title: "second"
    });
    const resumed = await readOneEvent(fixture.baseUrl, firstEventId);
    expect(resumed).toContain(second.id);
    expect(eventId(resumed)).not.toBe(firstEventId);
  });

  it("exports and clears data through the authenticated service boundary", async () => {
    const fixture = await startFixture();
    fixture.service.addMemory({ content: "clear through HTTP", source: "viewer-test", layer: "L1" });

    const exported = await fetch(`${fixture.baseUrl}/api/v1/admin/export`);
    expect(exported.status).toBe(200);
    expect(await exported.json()).toMatchObject({ manifest: { service: "memmy-memory-service" } });

    const cleared = await fetch(`${fixture.baseUrl}/api/v1/admin/data`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ ok: true, cleared: { memories: 1 } });
    expect(fixture.db.db.prepare("SELECT COUNT(*) FROM memories").pluck().get()).toBe(0);
    expect(fixture.db.db.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get()).toBeGreaterThan(0);
  });

  it("performs actual model and embedding probes", async () => {
    const calls: string[] = [];
    const fixture = await startFixture({
      llm: testLlm("summary-test", calls),
      skillLlm: testLlm("evolution-test", calls)
    });

    const response = await viewerFetch(fixture.baseUrl, "/api/v1/models/test", {
      method: "POST",
      body: "{}"
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      models: {
        summary: { ok: true, model: "summary-test" },
        evolution: { ok: true, model: "evolution-test" },
        embedding: { ok: true, dimensions: 3 }
      }
    });
    expect(calls).toEqual(expect.arrayContaining([
      "viewer.model-test.summary",
      "viewer.model-test.evolution"
    ]));
  });

  it("supports the copied Viewer auth, telemetry, bulk-delete and archive routes", async () => {
    const fixture = await startFixture();
    const trace = fixture.service.addMemory({ content: "trace", source: "viewer-test", layer: "L1" });
    const skill = fixture.service.addMemory({ content: "skill", source: "viewer-test", layer: "Skill" });
    const worldModel = fixture.service.addMemory({ content: "world", source: "viewer-test", layer: "L3" });

    const auth = await viewerFetch(fixture.baseUrl, "/api/v1/auth/status");
    expect(await auth.json()).toEqual({ enabled: false, needsSetup: false, authenticated: true });

    const telemetry = await viewerFetch(fixture.baseUrl, "/api/v1/telemetry/viewer-opened", {
      method: "POST",
      body: "{}"
    });
    expect(await telemetry.json()).toEqual({ ok: true });

    const deleted = await viewerFetch(fixture.baseUrl, "/api/v1/traces/delete", {
      method: "POST",
      body: JSON.stringify({ ids: [trace.id] })
    });
    expect(await deleted.json()).toEqual({ deleted: 1 });
    expect(fixture.db.db.prepare("SELECT status FROM memories WHERE id = ?").pluck().get(trace.id)).toBe("deleted");

    await viewerFetch(fixture.baseUrl, "/api/v1/skills/archive", {
      method: "POST",
      body: JSON.stringify({ skillId: skill.id })
    });
    expect(fixture.service.getMemory(skill.id).status).toBe("archived");

    await viewerFetch(fixture.baseUrl, `/api/v1/world-models/${worldModel.id}/archive`, {
      method: "POST",
      body: "{}"
    });
    expect(fixture.service.getMemory(worldModel.id).status).toBe("archived");
  });

  it("filters Viewer memories by agent source without a profile namespace", async () => {
    const fixture = await startFixture();
    const hermes = fixture.service.addMemory({ content: "Hermes memory", source: "hermes", layer: "L1" });
    fixture.service.addMemory({ content: "Codex memory", source: "codex", layer: "L1" });

    const response = await viewerFetch(fixture.baseUrl, "/api/v1/traces?sourceAgent=hermes&limit=20&page=1");
    expect(await response.json()).toMatchObject({
      total: 1,
      items: [expect.objectContaining({
        id: hermes.id,
        metadata: { source: "hermes" }
      })]
    });

    const overview = await viewerFetch(fixture.baseUrl, "/api/v1/overview");
    expect(await overview.json()).toMatchObject({
      summary: {
        sourceDistribution: expect.arrayContaining([
          expect.objectContaining({ source: "hermes", count: 1 }),
          expect.objectContaining({ source: "codex", count: 1 })
        ])
      }
    });
  });

  it("filters Viewer API logs by tool and Agent source", async () => {
    const fixture = await startFixture();
    const insert = fixture.db.db.prepare(`
      INSERT INTO api_logs (
        tool_name, source_agent, input_json, output_json, duration_ms, success, called_at
      ) VALUES (?, ?, '{}', '{}', 1, 1, ?)
    `);
    insert.run("memory_add", "hermes", "2026-08-31T10:00:00.000Z");
    insert.run("memory_search", "hermes", "2026-08-31T10:01:00.000Z");
    insert.run("memory_search", "codex", "2026-08-31T10:02:00.000Z");

    const response = await viewerFetch(
      fixture.baseUrl,
      "/api/v1/api-logs?tools=memory_search&sourceAgent=hermes&limit=20&offset=0",
    );
    expect(await response.json()).toMatchObject({
      total: 1,
      logs: [expect.objectContaining({ toolName: "memory_search", sourceAgent: "hermes" })],
    });
  });

  it("lists Memmy user memories for the configured local user", async () => {
    const fixture = await startFixture();
    const session = fixture.service.openSession({
      namespace: { source: "memmy", profileId: "default", userId: "local-user" }
    });
    const completed = fixture.service.completeTurn("turn-viewer-user-memory", {
      sessionId: session.sessionId,
      query: "我喜欢简洁代码，不要写不必要的兜底逻辑",
      answer: "好的，我会记住。"
    });
    expect(completed.userMemoryIds).toHaveLength(1);

    const response = await viewerFetch(fixture.baseUrl, "/api/v1/memories?q=简洁&limit=20&page=1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      total: 1,
      items: [expect.objectContaining({
        id: completed.userMemoryIds[0],
        kind: "user_memory",
        memoryLayer: "UserMemory",
        status: "activated"
      })]
    });

    const overview = await viewerFetch(fixture.baseUrl, "/api/v1/overview");
    expect(await overview.json()).toMatchObject({
      summary: { counts: { userMemories: 1 } }
    });

    const maintenance = await viewerFetch(fixture.baseUrl, "/api/v1/embeddings/maintenance");
    const stats = await maintenance.json() as {
      totalSlots: number;
      ready: number;
      missing: number;
      dimMismatch: number;
    };
    expect(stats.totalSlots).toBe(2);
    expect(stats.ready + stats.missing + stats.dimMismatch).toBe(stats.totalSlots);
  });

  it("filters Viewer user memories and tasks by Agent source", async () => {
    const fixture = await startFixture();
    const hermesSession = fixture.service.openSession({
      namespace: { source: "hermes", profileId: "default", userId: "local-user" }
    });
    const hermesTurn = fixture.service.completeTurn("turn-viewer-hermes-source", {
      sessionId: hermesSession.sessionId,
      query: "我喜欢简洁代码",
      answer: "好的。"
    });
    const codexSession = fixture.service.openSession({
      namespace: { source: "codex", profileId: "default", userId: "local-user" }
    });
    const codexTurn = fixture.service.completeTurn("turn-viewer-codex-source", {
      sessionId: codexSession.sessionId,
      query: "我叫张三",
      answer: "你好，张三。"
    });
    expect(hermesTurn.userMemoryIds).toHaveLength(1);
    expect(codexTurn.userMemoryIds).toHaveLength(1);

    const userMemories = await viewerFetch(
      fixture.baseUrl,
      "/api/v1/memories?sourceAgent=hermes&limit=20&page=1",
    );
    expect(await userMemories.json()).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ id: hermesTurn.userMemoryIds[0] })],
    });

    const tasks = await viewerFetch(
      fixture.baseUrl,
      "/api/v1/episodes?sourceAgent=codex&limit=20&page=1",
    );
    expect(await tasks.json()).toMatchObject({
      total: 1,
      tasks: [expect.objectContaining({ id: codexTurn.episodeId })],
    });
  });
});

async function startFixture(options: {
  llm?: LlmClient;
  skillLlm?: LlmClient;
  viewerCli?: ViewerCliOptions;
  onRestartRequested?: () => void | Promise<void>;
  agentSourceExecutor?: AgentSourceExecutor;
} = {}): Promise<{
  baseUrl: string;
  configPath: string;
  db: MemoryDb;
  service: MemoryService;
}> {
  const root = mkdtempSync(join(tmpdir(), "memmy-viewer-api-"));
  const configPath = join(root, "config.yaml");
  const config = {
    ...DEFAULT_MEMMY_CONFIG,
    hub: { enabled: false, teamToken: "hub-secret" }
  } as typeof DEFAULT_MEMMY_CONFIG;
  writeFileSync(configPath, YAML.stringify({ memmyMemory: config }));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const service = new MemoryService({
    db,
    mode: "dev",
    config,
    configPath,
    configLoader: () => ({ config, path: configPath }),
    llm: options.llm,
    skillLlm: options.skillLlm,
    embedder: testEmbedder()
  });
  const server = createMemoryHttpServer({
    service,
    configPath,
    viewerCli: options.viewerCli,
    onRestartRequested: options.onRestartRequested,
    agentSourceExecutor: options.agentSourceExecutor,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  cleanup.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => db.close(),
    async () => closeServer(server)
  );
  return { baseUrl: `http://127.0.0.1:${address.port}`, configPath, db, service };
}

function viewerFetch(baseUrl: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "x-memmy-viewer": "1",
      ...(init.method && init.method !== "GET" ? { "content-type": "application/json" } : {}),
      ...init.headers
    }
  });
}

async function readOneEvent(baseUrl: string, cursor: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/events`, { headers: { "last-event-id": cursor } });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 2_000;
  while (!text.includes("\n\n")) {
    if (Date.now() > deadline) throw new Error("timed out waiting for SSE event");
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  await reader.cancel();
  return text;
}

function eventId(event: string): string {
  const match = event.match(/^id: (.+)$/m);
  if (!match?.[1]) throw new Error(`event has no id: ${event}`);
  return match[1].trim();
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function testEmbedder(): Embedder {
  return {
    config: { ...DEFAULT_MEMMY_CONFIG.embedding, model: "viewer-test" },
    isRemote: () => false,
    embed: async (texts) => texts.map(() => [1, 0, 0]),
    embedOne: async () => [1, 0, 0],
    status: () => ({ provider: "local", model: "viewer-test", configured: true, remote: false })
  };
}

function testLlm(model: string, calls: string[]): LlmClient {
  return {
    config: { ...DEFAULT_MEMMY_CONFIG.summary, provider: "openai_compatible", model, endpoint: "http://127.0.0.1" },
    isConfigured: () => true,
    complete: async (_messages, options) => {
      calls.push(options.operation);
      return "OK";
    },
    completeJson: async <T extends Record<string, unknown>>() => ({} as T),
    status: () => ({ provider: "test", model, configured: true, remote: true })
  };
}
