import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { createMockProjectGateway } from "../../scripts/mock-project-memory-gateway.mjs";
import { createHttpCloudClient } from "../../App/backend/src/adapters/outbound/cloud-client/http-cloud-client.js";
import { registerProjectMemoryRoutes } from "../../App/backend/src/adapters/inbound/local-api/routes/project-memory.js";
import { createAppStateStore } from "../../App/backend/src/infrastructure/app-state-store/index.js";
import { ProjectMemoryService } from "../../App/backend/src/services/project-memory/service.js";
import { listenMemoryHttpServer, closeMemoryHttpServer } from "../../Memory/src/server/http.js";
import { createMemoryServiceFixture, LEGACY_TEST_CONFIG } from "../../Memory/tests/fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(async () => { vi.unstubAllEnvs(); await fixture.cleanup(); });

it("captures a Memmy turn, recalls it from Codex, and routes a native completion to both projects", async () => {
  const { service, root } = fixture.createTestService({ config: LEGACY_TEST_CONFIG });
  const state = createAppStateStore({ databasePath: join(root, "desktop.db") });
  const mock = createMockProjectGateway();
  const gateway = await mock.listen({ host: "127.0.0.1", port: 0 });
  vi.stubEnv("MEMMY_PROJECT_MEMORY_GATEWAY_URL", gateway);
  const desktop = Fastify();
  const projectMemory = new ProjectMemoryService(state.db, () => ({ id: "test", credential: "test-only" }), createHttpCloudClient({ baseUrl: gateway }));
  registerProjectMemoryRoutes(desktop, { services: { projectMemory } as never, authenticateRuntimeToken: async (req, res) => {
    if (req.headers["x-memmy-local-token"] !== "local-test") await res.code(401).send({});
  } });
  const desktopUrl = await desktop.listen({ host: "127.0.0.1", port: 0 });
  const config = join(root, "desktop-runtime.json");
  writeFileSync(config, JSON.stringify({ baseUrl: desktopUrl, localToken: "local-test" }));
  vi.stubEnv("MEMMY_RUNTIME_CONFIG_PATH", config);
  const { url, server } = await listenMemoryHttpServer({ service, apiKey: "memory-test", port: 0, startAgentSourceAutomation: false });
  const post = async (endpoint: string, body: object) => {
    const res = await fetch(url + "/api/v1/" + endpoint, { method: "POST",
      headers: { authorization: "Bearer memory-test", "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    expect(res.status, JSON.stringify(data)).toBe(200);
    return data;
  };
  try {
    vi.stubEnv("MEMMY_AGENT_DATA_DIR", root);
    mkdirSync(join(root, "webui"), { recursive: true });
    writeFileSync(join(root, "webui/projects.json"), JSON.stringify({ projects: [{ id: "workspace-1", root_path: root, state: "active" }] }));
    for (const project_id of ["A","B"]) {
      const res = await fetch(desktopUrl + "/api/project-memory/bindings", { method: "PUT",
        headers: { "x-memmy-local-token": "local-test", "content-type": "application/json" },
        body: JSON.stringify({ project_id, workspace_ids: project_id === "A" ? ["workspace-1"] : [], folder_paths: project_id === "B" ? [root] : [] }) });
      expect(res.status).toBe(200);
    }
    const source = "memmy-agent", query = "Which response means duplicate share?", answer = "HTTP 409";
    const memmy = await post("sessions/open", { source, sessionId: "memmy-1", workspacePath: root });
    const turn = { source, sessionId: memmy.sessionId, turnId: "turn-1", query };
    await post("turns/start", turn);
    const stored = await post("turns/turn-1/complete", { ...turn, answer });
    expect(stored.projectMemory.submissions.map(x => x.project_id)).toEqual(["A","B"]);

    const codex = await post("sessions/open", { source: "codex", sessionId: "codex-2", namespace: { source: "codex", profileId: "default", sessionKey: "codex-2" }, workspacePath: root });
    const input = { source: "codex", sessionId: codex.sessionId, turnId: "hook-turn", query: "409" };
    const recall = await post("turns/start", input);
    expect(recall.injectedContext.markdown).toContain("HTTP 409");
    expect(recall.projectMemory.selectedIds.filter(id => id.startsWith("project:"))).toHaveLength(2);
    expect((await post("memory/search", input)).injectedContext).toContain("HTTP 409");
    expect((await post("project-memory/item", { ...input, memory_id: recall.projectMemory.selectedIds.find(id => id.startsWith("project:A:")).split(":")[2], project_id: "A" })).content.topic_summary).toBe(answer);
    const native = await post("source-turns/complete", { ...input, query: "HTTP 409 retry timing", answer: "Check status before retry.",
      recallTurnId: "hook-turn", channel: "hook", namespace: { source: "codex", profileId: "default", sessionKey: "codex-2" },
      sourceTurn: { source: "codex", profileId: "default", conversationId: "codex-2", turnId: "native-turn",
        startedAt: "2099-01-01T10:00:00.000Z", completedAt: "2099-01-01T10:01:00.000Z", sequence: 1, completionEvidence: "final_answer:native-turn" } });
    expect(native.projectMemory.submissions.map(x => x.project_id)).toEqual(["A","B"]);
    const other = await post("sessions/open", { source: "codex", sessionId: "codex-3", workspacePath: root + "-other" });
    expect((await post("turns/start", { ...input, sessionId: other.sessionId })).projectMemory).toBeUndefined();
  } finally {
    await closeMemoryHttpServer(server); await desktop.close(); await mock.close(); state.close();
  }
}, 30000);
