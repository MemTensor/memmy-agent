import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledgeHook } from "../../src/knowledge/register.js";
import { AgentHookContext, CompositeHook } from "../../src/core/agent-runtime/hook.js";
import { MemmyMemoryHook } from "../../src/memmy-memory/hook.js";

const folders: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

it("composes with the unchanged Memory hook and keeps its query and writeback intact", async () => {
  const folder = await mkdtemp(join(tmpdir(), "memmy-knowledge-agent-"));
  folders.push(folder);
  vi.stubEnv("MEMMY_HOME", folder);
  const configPath = join(folder, "runtime.json");
  await writeFile(
    configPath,
    JSON.stringify({ baseUrl: "http://127.0.0.1:1234", localToken: "local-test" }),
  );
  let enabled = true;
  const cloud = vi.fn(
    async (_url: string | URL | Request) =>
      new Response(
        JSON.stringify({
          enabled,
          evidence: enabled
            ? [{ id: "source-1", title: "差旅制度", content: "住宿上限 500 元。" }]
            : [],
        }),
      ),
  );
  vi.stubGlobal("fetch", cloud);
  const memoryClient = {
    openSession: vi.fn(async () => ({
      sessionId: "memory-session",
      userId: "local-user",
      resumed: false,
    })),
    startTurn: vi.fn(async (_id: string, _body: unknown) => ({
      sourceMemoryIds: ["memory-1"],
      injectedContext: { markdown: "用户偏好安静的酒店。" },
    })),
    completeTurn: vi.fn(async (_id: string, _body: unknown) => ({
      rawTurnId: "raw",
      l1MemoryId: "l1",
    })),
    closeSession: vi.fn(async () => ({ ok: true })),
  };
  const memory = new MemmyMemoryHook(memoryClient as never, {
    workspace: folder,
    userId: "local-user",
  });
  const hooks = new CompositeHook([createKnowledgeHook(configPath), memory]);
  const messages = [
    { role: "system", content: "Host instructions" },
    { role: "user", content: "帮我按差旅标准选酒店" },
  ];
  const ctx = new AgentHookContext({
    messages,
    spec: { sessionKey: "test:knowledge", turnId: "turn-1" },
  });
  await hooks.beforeRun(ctx);
  expect(messages[0]!.content).toContain("住宿上限 500 元");
  expect(JSON.stringify(messages[1]!.content)).toContain("用户偏好安静的酒店");
  expect(memoryClient.startTurn.mock.calls[0]![1]).toMatchObject({ query: "帮我按差旅标准选酒店" });
  const result = {
    messages,
    finalContent: "优先选择安静且每晚不超过 500 元的酒店。",
    status: "completed",
    toolCalls: [],
    toolResults: [],
  };
  await hooks.afterRun(ctx, result);
  expect(messages[0]!.content).toBe("Host instructions");
  expect(memoryClient.completeTurn.mock.calls[0]![1]).toMatchObject({
    query: "帮我按差旅标准选酒店",
    answer: result.finalContent,
    sourceMemoryIds: ["memory-1"],
  });
  enabled = false;
  const next = new AgentHookContext({
    messages: [
      { role: "system", content: "Host instructions" },
      { role: "user", content: "继续" },
    ],
    spec: { sessionKey: "test:knowledge", turnId: "turn-2" },
  });
  await hooks.beforeRun(next);
  expect(
    cloud.mock.calls.filter(([url]) => String(url).endsWith("/api/knowledge/recall")),
  ).toHaveLength(2);
  expect(memoryClient.startTurn).toHaveBeenCalledTimes(2);
});
