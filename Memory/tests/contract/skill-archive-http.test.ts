import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryHttpServer,
  type Embedder,
  MemoryDb,
  MemoryService
} from "../../src/index.js";

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe("skill archive over the service API", () => {
  it("archives and reactivates a skill for a token caller without the viewer header", async () => {
    const { baseUrl, service } = await startServer("skill-token");
    const skill = service.addMemory({ content: "skill", source: "contract", layer: "Skill" });

    const archived = await post(baseUrl, "/api/v1/skills/archive", { skillId: skill.id }, "skill-token");
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({ ok: true, id: skill.id, status: "archived", serverTime: expect.any(String) });
    expect(service.getMemory(skill.id).status).toBe("archived");

    const reactivated = await post(baseUrl, "/api/v1/skills/reactivate", { skillId: skill.id }, "skill-token");
    expect(reactivated.status).toBe(200);
    expect(await reactivated.json()).toMatchObject({ ok: true, id: skill.id, status: "activated", serverTime: expect.any(String) });
    expect(service.getMemory(skill.id).status).toBe("activated");
  });

  it("rejects callers without the service token and requests without a skill id", async () => {
    const { baseUrl, service } = await startServer("skill-token");
    const skill = service.addMemory({ content: "skill", source: "contract", layer: "Skill" });

    const anonymous = await post(baseUrl, "/api/v1/skills/archive", { skillId: skill.id });
    expect(anonymous.status).toBe(401);
    expect(service.getMemory(skill.id).status).toBe("activated");

    const missingId = await post(baseUrl, "/api/v1/skills/archive", {}, "skill-token");
    expect(missingId.status).toBe(400);
  });

  it("wakes the worker after reactivating through either route", async () => {
    const { baseUrl, service } = await startServer("skill-token");
    const skill = service.addMemory({ content: "skill", source: "contract", layer: "Skill" });
    const runWorkerOnce = vi.spyOn(service, "runWorkerOnce");

    const callers: Array<Record<string, string>> = [{ authorization: "Bearer skill-token" }, { "x-memmy-viewer": "1" }];
    for (const headers of callers) {
      expect((await post(baseUrl, "/api/v1/skills/archive", { skillId: skill.id }, undefined, headers)).status).toBe(200);
      runWorkerOnce.mockClear();
      expect((await post(baseUrl, "/api/v1/skills/reactivate", { skillId: skill.id }, undefined, headers)).status).toBe(200);
      await vi.waitFor(() => expect(runWorkerOnce).toHaveBeenCalled());
    }
  });
});

async function startServer(token: string): Promise<{ baseUrl: string; service: MemoryService }> {
  const root = mkdtempSync(join(tmpdir(), "memmy-skill-archive-http-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const service = new MemoryService({
    db,
    mode: "dev",
    embedder: createTestEmbedder(),
    fetchAppMemoryBudget: async () => null
  });
  // The worker only runs when a request wakes it.
  const server = createMemoryHttpServer({
    service,
    auth: { localServiceToken: token },
    workerStartupFallbackMs: 60_000
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  cleanup.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => db.close(),
    async () => service.stop(),
    () => new Promise<void>((resolve) => server.close(() => resolve()))
  );
  return { baseUrl: `http://127.0.0.1:${address.port}`, service };
}

function post(
  baseUrl: string,
  path: string,
  body: unknown,
  token?: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: JSON.stringify(body)
  });
}

function createTestEmbedder(): Embedder {
  return {
    config: {
      provider: "local",
      mode: "local",
      model: "skill-archive-test-embedding",
      batchSize: 32,
      timeoutMs: 60_000,
      maxRetries: 0,
      cache: false,
      normalize: false
    },
    isRemote() {
      return false;
    },
    async embed(texts: string[]) {
      return texts.map(() => [1, 0, 0]);
    },
    async embedOne() {
      return [1, 0, 0];
    },
    status() {
      return {
        provider: "local",
        model: "skill-archive-test-embedding",
        configured: true,
        remote: false
      };
    }
  };
}
