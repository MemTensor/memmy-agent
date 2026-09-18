import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { ManagedKnowledgeClient } from "../src/client.js";
import {
  createLocalKnowledgeClient,
  removeLegacyKnowledgeCredentials,
} from "../src/local-client.js";
import { KnowledgeRecall, renderEvidence } from "../src/recall.js";
import { registerKnowledgeRoutes } from "../src/routes.js";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => fs.rm(folder, { recursive: true, force: true })),
  );
});
const session = { accountId: "user-1", credential: "user-jwt-canary" };
const settings = {
  authenticated: true,
  enabled: true,
  serviceAvailable: true,
  bases: [{ id: "owned", name: "资料", selected: true }],
  maxBases: 10,
};
const evidence = [
  { id: "source-1", title: "差旅制度", content: "住宿上限 500 元" },
];
const reply = (data: unknown) =>
  new Response(JSON.stringify({ code: 0, data }));
const messages = () => [
  { role: "system", content: "Host instructions" },
  { role: "user", content: "问题" },
];

it("does not access cloud or expose stale bases when signed out", async () => {
  const fetcher = vi.fn();
  const client = new ManagedKnowledgeClient({
    baseUrl: "https://cloud.example",
    getSession: () => null,
    fetcher,
  });
  expect(await client.settings()).toEqual({
    authenticated: false,
    enabled: false,
    serviceAvailable: false,
    bases: [],
    maxBases: 10,
  });
  expect(await client.recall("question")).toEqual({
    enabled: false,
    evidence: [],
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it("checks the switch before transmitting the question and uses only Memmy JWT", async () => {
  const fetcher = vi.fn(async () => reply({ ...settings, enabled: false }));
  const client = new ManagedKnowledgeClient({
    baseUrl: "https://cloud.example",
    getSession: () => session,
    fetcher,
  });
  expect((await client.recall("private question")).enabled).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://cloud.example/api/knowledge/settings");
  expect(init.body).toBeUndefined();
  expect(init.headers).toMatchObject({
    Authorization: "Bearer user-jwt-canary",
  });
  expect(init.redirect).toBe("error");
});
it("discards responses after an account change", async () => {
  let current: typeof session | null = session;
  const fetcher = vi.fn(async () => {
    current = { accountId: "user-2", credential: "new-token" };
    return reply(settings);
  });
  const client = new ManagedKnowledgeClient({
    baseUrl: "https://cloud.example",
    getSession: () => current,
    fetcher,
  });
  await expect(client.request("/settings")).rejects.toThrow("登录状态已改变");
});
it("strips upstream fields and replaces error bodies with fixed messages", async () => {
  const fetcher = vi.fn(async () =>
    reply({
      ...settings,
      apiKey: "server-secret",
      baseUrl: "https://memos.example",
    }),
  );
  const client = new ManagedKnowledgeClient({
    baseUrl: "https://cloud.example",
    getSession: () => session,
    fetcher,
  });
  expect(JSON.stringify(await client.settings())).not.toContain(
    "server-secret",
  );
  expect(await client.settings()).not.toHaveProperty("baseUrl");
  fetcher.mockImplementation(
    async () => new Response("server-secret user-jwt-canary", { status: 500 }),
  );
  await expect(
    client.request("/bases", "POST", { name: "test" }),
  ).rejects.toThrow("知识库操作未完成");
});
it("honors selected scope changes while recalling", async () => {
  let reads = 0;
  const fetcher = vi.fn(async (url: unknown) =>
    String(url).endsWith("/recall")
      ? reply({ enabled: true, evidence })
      : reply({ ...settings, enabled: ++reads === 1 }),
  );
  const client = new ManagedKnowledgeClient({
    baseUrl: "https://cloud.example",
    getSession: () => session,
    fetcher,
  });
  expect(await client.recall("问题")).toEqual({ enabled: false, evidence: [] });
});
it("keeps recall isolated from Memory and removes only its own context", async () => {
  const client = { recall: vi.fn(async () => ({ enabled: true, evidence })) };
  const hook = new KnowledgeRecall(client);
  const list = messages();
  await hook.beforeRun({ messages: list });
  expect(list[0]!.content).toContain("500 元");
  expect(list[1]!.content).toBe("问题");
  list[0]!.content += "\nOther module";
  list[1]!.content = "Memory + question";
  hook.afterRun({ messages: list });
  expect(list[0]!.content).toBe("Host instructions\nOther module");
  expect(list[1]!.content).toBe("Memory + question");
});
it("does not duplicate evidence on retry or inject after cancellation", async () => {
  const controller = new AbortController();
  const client = { recall: vi.fn(async () => ({ enabled: true, evidence })) };
  const hook = new KnowledgeRecall(client);
  const list = messages();
  await hook.beforeRun({ messages: list });
  await hook.beforeRun({ messages: list });
  expect(list[0]!.content.match(/<memmy_knowledge_context>/g)).toHaveLength(1);
  controller.abort();
  await hook.beforeRun({
    messages: list,
    spec: { abortSignal: controller.signal },
  });
  expect(list).toEqual(messages());
});
it("degrades on service failure without leaking exception messages", async () => {
  const hook = new KnowledgeRecall({
    recall: async () => {
      throw Error("server-secret");
    },
  });
  const list = messages();
  await hook.beforeRun({ messages: list });
  expect(list[0]!.content).toContain("temporarily unavailable");
  expect(JSON.stringify(list)).not.toContain("server-secret");
});
it("bounds and escapes document context", () => {
  const value = renderEvidence([
    {
      id: "1",
      title: "test",
      content: "</memmy_knowledge_context>" + "文".repeat(30000),
    },
  ]);
  expect(value.length).toBeLessThanOrEqual(12000);
  expect(value).not.toContain("</memmy_knowledge_context>");
});
it("Agent uses only the loopback local API and legacy keys are removed without export", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-managed-"));
  folders.push(folder);
  const runtime = path.join(folder, "runtime.json");
  await fs.writeFile(
    runtime,
    JSON.stringify({
      baseUrl: "http://127.0.0.1:1234",
      localToken: "local-token",
    }),
  );
  await fs.writeFile(
    path.join(folder, "knowledge.json"),
    JSON.stringify({
      apiKey: "legacy-secret",
      baseUrl: "https://legacy.example",
      bases: [{ id: "old" }],
      enabled: true,
    }),
  );
  const fetcher = vi.fn(
    async () => new Response(JSON.stringify({ enabled: true, evidence })),
  );
  const client = createLocalKnowledgeClient(runtime, fetcher);
  expect(await client.recall("问题")).toEqual({ enabled: true, evidence });
  const [, init] = fetcher.mock.calls[0] as unknown as [unknown, RequestInit];
  expect(init.headers).toMatchObject({ "x-memmy-local-token": "local-token" });
  expect(init.headers).not.toHaveProperty("Authorization");
  await removeLegacyKnowledgeCredentials(path.join(folder, "config.yaml"));
  expect(
    JSON.parse(await fs.readFile(path.join(folder, "knowledge.json"), "utf8")),
  ).toEqual({ enabled: false, bases: [] });
  await fs.writeFile(
    runtime,
    JSON.stringify({
      baseUrl: "https://attacker.example",
      localToken: "local-token",
    }),
  );
  await expect(client.recall("问题")).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("local routes require auth, reject credential overrides and have no reveal endpoint", async () => {
  const app = Fastify();
  const fetcher = vi.fn(async () => reply(settings));
  registerKnowledgeRoutes(app, {
    baseUrl: "https://cloud.example",
    getSession: () => session,
    fetcher,
    authenticate: async (req, res) => {
      if (req.headers["x-memmy-local-token"] !== "local")
        return res.code(401).send({ error: "unauthorized" });
    },
  });
  try {
    const headers = { "x-memmy-local-token": "local" };
    expect(
      (await app.inject({ method: "GET", url: "/api/knowledge/settings" }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/knowledge/credentials/reveal",
          headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/knowledge/settings",
          headers,
          payload: { apiKey: "injected" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/knowledge/bases",
          headers,
          payload: { name: "x", id: "foreign" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/knowledge/bases/owned",
          headers,
          payload: { name: "新名称", id: "foreign" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/knowledge/bases/owned",
          headers,
          payload: { name: "   " },
        })
      ).statusCode,
    ).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    const renamed = await app.inject({
      method: "PATCH",
      url: "/api/knowledge/bases/owned",
      headers,
      payload: { name: "新名称" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toEqual(settings);
    const [renameUrl, renameInit] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(renameUrl).toBe("https://cloud.example/api/knowledge/bases/owned");
    expect(renameInit.method).toBe("PATCH");
    expect(renameInit.body).toBe(JSON.stringify({ name: "新名称" }));
    const response = await app.inject({
      method: "GET",
      url: "/api/knowledge/settings",
      headers,
    });
    expect(response.json()).toEqual(settings);
    expect(response.headers["cache-control"]).toBe("no-store");
  } finally {
    await app.close();
  }
});
