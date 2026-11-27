import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { createMockProjectGateway } from "../../scripts/mock-project-memory-gateway.mjs";
import { createHttpCloudClient } from "../../App/backend/src/adapters/outbound/cloud-client/http-cloud-client.js";
import { registerProjectMemoryRoutes } from "../../App/backend/src/adapters/inbound/local-api/routes/project-memory.js";
import { createAppStateStore } from "../../App/backend/src/infrastructure/app-state-store/index.js";
import { ProjectMemoryService } from "../../App/backend/src/services/project-memory/service.js";
import { openRuntimeSession } from "../../Memory/src/agent-source/integration/workspace-bridge/runtime.js";
import { listenMemoryHttpServer, closeMemoryHttpServer } from "../../Memory/src/server/http.js";
import { createMemoryServiceFixture, LEGACY_TEST_CONFIG } from "../../Memory/tests/fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(async () => { vi.unstubAllEnvs(); await fixture.cleanup(); });

it("captures a Memmy turn, recalls it from Codex, and routes a native completion to both projects", async () => {
  const { service, root } = fixture.createTestService({
    config: LEGACY_TEST_CONFIG,
    configLoader: () => ({ config: { ...LEGACY_TEST_CONFIG, algorithm: { ...LEGACY_TEST_CONFIG.algorithm, enableMemoryAdd: false } } })
  });
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
    const bound = join(root, "repo", "api"), sibling = join(root, "repo", "api-old");
    mkdirSync(join(bound, "src"), { recursive: true });
    const hookConfig = join(root, "hook-config.json");
    writeFileSync(hookConfig, JSON.stringify({ memmy_config_path: join(root, "missing.yaml"), endpoint: url, token: "memory-test", workspaceHostId: "a".repeat(64) }));
    mkdirSync(join(root, "webui"), { recursive: true });
    writeFileSync(join(root, "webui/projects.json"), JSON.stringify({ projects: [{ id: "workspace-1", root_path: bound, state: "active" }] }));
    for (const project_id of ["A","B"]) {
      const res = await fetch(desktopUrl + "/api/project-memory/bindings", { method: "PUT",
        headers: { "x-memmy-local-token": "local-test", "content-type": "application/json" },
        body: JSON.stringify({ project_id, workspace_ids: project_id === "A" ? ["workspace-1"] : [], folder_paths: project_id === "B" ? [bound] : [] }) });
      expect(res.status).toBe(200);
    }
    const source = "memmy-agent", query = "Which response means duplicate share?", answer = "HTTP 409";
    const memmy = await post("sessions/open", { source, sessionId: "memmy-1", workspaceId: "workspace-1" });
    const turn = { source, sessionId: memmy.sessionId, turnId: "turn-1", query };
    await post("turns/start", turn);
    const stored = await post("turns/turn-1/complete", { ...turn, answer, toolCalls: [{ id: "call-1", name: "rollback", input: { version: "v1" } }], toolResults: [{ toolCallId: "call-1", output: "restored-v1" }] });
    expect(stored.projectMemory.submissions.map(x => x.project_id)).toEqual(["A","B"]);

    const codex = await post("sessions/open", { source: "codex", sessionId: "codex-2", namespace: { source: "codex", profileId: "default", sessionKey: "codex-2" }, workspacePath: join(bound, "src") });
    const input = { source: "codex", sessionId: codex.sessionId, turnId: "hook-turn", query: "409" };
    const recall = await post("turns/start", input);
    expect(recall.injectedContext.markdown).toContain("HTTP 409");
    expect(recall.projectMemory.selectedIds.filter(id => id.startsWith("project:")).length).toBeGreaterThanOrEqual(2);
    expect((await post("memory/search", input)).injectedContext).toContain("HTTP 409");
    expect((await post("project-memory/item", { ...input, memory_id: recall.projectMemory.selectedIds.find(id => id.startsWith("project:A:")).split(":")[2], project_id: "A" })).content.topic_summary).toBe(answer);
    const toolSearch = await post("memory/search", { ...input, query: "restored-v1", verbose: true });
    expect(toolSearch.injectedContext).toContain("rollback");
    const ref = toolSearch.debug.projectMemory.selectedIds.find(id => id.startsWith("project:A:"));
    const detail = await post("project-memory/item", { ...input, project_id: "A", memory_id: ref.split(":")[2] });
    expect(detail.content).toMatchObject({ role: "tool", tool_call_id: "call-1", content: "restored-v1",
      tool_calls: [{ function: { name: "rollback", arguments: '{"version":"v1"}' } }] });
    const native = await post("source-turns/complete", { ...input, query: "HTTP 409 retry timing", answer: "Check status before retry.",
      recallTurnId: "hook-turn", channel: "hook", namespace: { source: "codex", profileId: "default", sessionKey: "codex-2" },
      sourceTurn: { source: "codex", profileId: "default", conversationId: "codex-2", turnId: "native-turn",
        startedAt: "2099-01-01T10:00:00.000Z", completedAt: "2099-01-01T10:01:00.000Z", sequence: 1, completionEvidence: "final_answer:native-turn" } });
    expect(native.projectMemory.submissions.map(x => x.project_id)).toEqual(["A","B"]);
    for (const [sessionId, meta, boundProjects] of [
      ["sibling", { launchFolder: sibling, workspaceRoots: [bound, sibling] }, []],
      ["editor", { launchFolder: null, workspaceRoots: [sibling, join(bound, "src"), bound] }, ["A", "B"]],
      ["unknown", { launchFolder: null }, []],
      ["first-prompt", { launchFolder: null }, ["A", "B"]],
    ] as const) {
      const namespace = { source: "cursor", profileId: "default", userId: "__memmy_device_memory__", sessionKey: sessionId };
      const opened = await openRuntimeSession({
        source: "cursor", configUrl: pathToFileURL(hookConfig), sessionKey: sessionId, workspaceRoot: bound,
        launchFolder: meta.launchFolder, workspaceRoots: "workspaceRoots" in meta ? [...meta.workspaceRoots] : undefined,
        transition: "allow_legacy_rollover"
      });
      expect(opened?.protocol).toBe("v2");
      const start = { source: "cursor", namespace: { ...namespace, projectId: opened!.projectId },
        sessionId: opened!.sessionId, turnId: "turn-" + sessionId, query: "409",
        contextHints: sessionId === "first-prompt" ? { workspaceDir: bound } : undefined };
      const recalled = await post("turns/start", start);
      const selected: string[] = recalled.projectMemory?.selectedIds ?? [];
      expect([...new Set(selected.filter(id => id.startsWith("project:")).map(id => id.split(":")[1]))].sort()).toEqual(boundProjects);
      const completed = await post("turns/" + start.turnId + "/complete", { ...start, answer: "Recorded " + sessionId });
      expect(completed.projectMemory.submissions.map(s => s.project_id)).toEqual(boundProjects);
    }
    const readOnly = { ...turn, turnId: "readonly" };
    await post("turns/start", readOnly);
    service.reloadConfig({ restartFailedProcessing: false });
    expect((await post("turns/readonly/complete", { ...readOnly, answer })).projectMemory).toBeUndefined();
  } finally {
    await closeMemoryHttpServer(server); await desktop.close(); await mock.close(); state.close();
  }
}, 30000);
