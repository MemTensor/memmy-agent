/** Cross-adapter integration: an older Memory must not break Desktop startup. */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, expect, it } from "vitest";
import { registerAgentSourceRoutes } from "../adapters/inbound/local-api/routes/agent-sources.js";
import { createHttpMemoryClient } from "../adapters/outbound/memory-client/http-memory-client.js";
import { createProgressBus } from "../services/progress-bus.js";
import type { AgentSourceService } from "../services/agent-source-service.js";
import type { AgentSourceAutoInjectService } from "../services/agent-source-auto-inject-service.js";
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

  it("reports legacy scan support without breaking startup status and rejects writes with an actionable code", async () => {
    const requests: string[] = [];
    const client = createHttpMemoryClient({ baseUrl: "http://old-memory.test", token: "fixture", timeoutMs: 500, maxRetries: 0 }, {
      fetchImpl: (async (url) => {
        requests.push(String(url));
        return new Response(JSON.stringify({ error: { code: "not_found", message: "not registered", requestId: "fixture" } }), { status: 404 });
      }) as typeof fetch
    });
    const server = Fastify(); app = server;
    registerAgentSourceRoutes(server, {
      agentSources: {} as AgentSourceService,
      agentSourceAutoInject: {} as AgentSourceAutoInjectService,
      permissionManager: { canScanAgentSource: async () => true },
      authenticateRuntimeToken: async () => undefined,
      progressBus: createProgressBus(), scanClient: client.agentSources
    });
    const headers = { "x-memmy-local-token": "test-token" };
    const status = await server.inject({ method: "GET", url: "/api/agent-sources/scan/status", headers });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ active: false, progress: null, unavailable: { code: "memory_scan_upgrade_required" } });
    expect(status.json()).not.toHaveProperty("completion");
    const start = await server.inject({ method: "POST", url: "/api/agent-sources/scan", headers, payload: { sourceId: "all" } });
    expect(start.statusCode).toBe(503);
    expect(start.json()).toMatchObject({ error: { code: "memory_scan_upgrade_required" } });
    expect(requests.every((url) => url.endsWith("/scan/status"))).toBe(true);
  });
