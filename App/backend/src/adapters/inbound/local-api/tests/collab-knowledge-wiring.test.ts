/** Collab knowledge search wiring: the local route asks the cloud for project-only recall and returns its evidence. */
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionManager } from "../../../../permission/index.js";
import type { CollabService } from "../../../../services/collab-service.js";
import { createProgressBus } from "../../../../services/progress-bus.js";
import type { BackendServices } from "../../../../services/index.js";
import { createLocalApiServer } from "../server.js";

const EVIDENCE = { enabled: true, evidence: [{ id: "source-1", title: "属性记忆模板管理 API 需求", content: "模板接口说明" }] };

let app: FastifyInstance | undefined;
let stub: Server | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  await new Promise<void>((resolve) => (stub ? stub.close(() => resolve()) : resolve()));
  stub = undefined;
});

/** A cloud stub that records every recall request and answers with `reply`. */
async function startCloud(reply: (body: Record<string, unknown>) => { status: number; payload: unknown }) {
  const received: Array<{ path: string; body: Record<string, unknown> }> = [];
  stub = createHttpServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += String(chunk); });
    request.on("end", () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      received.push({ path: request.url ?? "", body });
      const { status, payload } = reply(body);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => stub!.listen(0, "127.0.0.1", resolve));
  const { port } = stub.address() as AddressInfo;
  app = createLocalApiServer({
    knowledge: { baseUrl: `http://127.0.0.1:${port}`, getSession: () => ({ accountId: "u-1", credential: "credential" }) },
    collab: { projectsForAgentSession: async () => [{ id: "p-1", name: "MemOS" }] } as unknown as CollabService,
    permissionManager: { verifyRuntimeToken: async () => true } as PermissionManager,
    composioMcpToken: "mcp-token",
    services: {
      bootstrap: { async getBootstrap() { throw new Error("bootstrap not used"); } },
      progressBus: createProgressBus()
    } as BackendServices
  });
  return received;
}

function searchKnowledge() {
  return app!.inject({
    method: "POST",
    url: "/api/collab/knowledge/search",
    headers: { "x-memmy-local-token": "runtime-token" },
    payload: { query: "属性记忆模板管理 API", sourceId: "codex", conversationId: "thread-1" }
  });
}

describe("collab knowledge search wiring", () => {
  it("asks the cloud for project-only recall and returns its evidence", async () => {
    const received = await startCloud(() => ({ status: 200, payload: { code: 0, data: EVIDENCE } }));

    const response = await searchKnowledge();

    expect(response.statusCode).toBe(200);
    expect(received.map((call) => call.path)).toEqual(["/api/knowledge/recall"]);
    // The project's own bases are the only scope: personal bases must not leak into a project answer.
    expect(received[0]!.body).toEqual({ query: "属性记忆模板管理 API", projectId: "p-1", projectOnly: true });
    expect(response.json()).toMatchObject({
      project: { id: "p-1", name: "MemOS" },
      enabled: true,
      projectOnly: true,
      evidence: [{ title: "属性记忆模板管理 API 需求", content: "模板接口说明" }]
    });
  });

  it("falls back to the project's older scope when the cloud rejects the parameter", async () => {
    const received = await startCloud((body) => body.projectOnly === true
      ? { status: 400, payload: { code: 400, data: null, message: "知识库请求参数无效" } }
      : { status: 200, payload: { code: 0, data: EVIDENCE } });

    const response = await searchKnowledge();

    expect(response.statusCode).toBe(200);
    expect(received.map((call) => call.body)).toEqual([
      { query: "属性记忆模板管理 API", projectId: "p-1", projectOnly: true },
      { query: "属性记忆模板管理 API", projectId: "p-1" }
    ]);
    // The caller has to know the answer may include personal bases, not only the project's.
    expect(response.json()).toMatchObject({ projectOnly: false, evidence: [{ title: "属性记忆模板管理 API 需求" }] });
  });

  it("keeps real failures instead of retrying them as a wider scope", async () => {
    const received = await startCloud(() => ({ status: 503, payload: { code: 503, data: null, message: "服务不可用" } }));

    const response = await searchKnowledge();

    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(received).toHaveLength(1);
  });
});
