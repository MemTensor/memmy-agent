/** Collab knowledge search: a linked agent session picks the project, and an ambiguous match is never guessed. */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollabService } from "../../../../services/collab-service.js";
import { registerCollabRoutes } from "../routes/collab.js";

const ONE = { id: "p-1", name: "MemOS" };
const TWO = { id: "p-2", name: "产品" };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function createApp(projects: unknown[], recall: ReturnType<typeof vi.fn>) {
  const projectsForAgentSession = vi.fn().mockResolvedValue(projects);
  app = Fastify();
  registerCollabRoutes(app, {
    collab: { projectsForAgentSession } as unknown as CollabService,
    authenticateRuntimeToken: async () => undefined,
    recallProjectKnowledge: recall as unknown as (query: string, projectId: string) => Promise<{ enabled: boolean; evidence: unknown[] }>
  });
  return projectsForAgentSession;
}

describe("collab knowledge search", () => {
  it("searches the project the session is linked to", async () => {
    const recall = vi.fn().mockResolvedValue({ enabled: true, evidence: [{ title: "需求", content: "模板" }] });
    const projectsForAgentSession = createApp([ONE], recall);

    const response = await app!.inject({
      method: "POST",
      url: "/api/collab/knowledge/search",
      payload: { query: "属性记忆模板", sourceId: "codex", conversationId: "thread-1" }
    });

    expect(response.statusCode).toBe(200);
    expect(projectsForAgentSession).toHaveBeenCalledWith("codex", "thread-1");
    expect(recall).toHaveBeenCalledWith("属性记忆模板", "p-1");
    expect(response.json()).toMatchObject({ project: ONE, enabled: true, evidence: [{ title: "需求" }] });
  });

  it("refuses to guess when the session is linked to several projects", async () => {
    const recall = vi.fn();
    createApp([ONE, TWO], recall);
    const payload = { query: "属性记忆模板", sourceId: "codex", conversationId: "thread-1" };

    const ambiguous = await app!.inject({ method: "POST", url: "/api/collab/knowledge/search", payload });

    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.json()).toMatchObject({ error: { code: "conflict" } });
    expect(ambiguous.json().error.message).toContain("MemOS、产品");
    expect(recall).not.toHaveBeenCalled();

    const selected = await app!.inject({ method: "POST", url: "/api/collab/knowledge/search", payload: { ...payload, project: "MemOS" } });
    expect(selected.statusCode).toBe(200);
    expect(recall).toHaveBeenCalledWith("属性记忆模板", "p-1");
  });

  it("turns away a project the session is not linked to and an incomplete identity", async () => {
    const recall = vi.fn();
    createApp([ONE], recall);

    const wrong = await app!.inject({
      method: "POST",
      url: "/api/collab/knowledge/search",
      payload: { query: "模板", sourceId: "codex", conversationId: "thread-1", project: "其他" }
    });
    const halfIdentity = await app!.inject({
      method: "POST",
      url: "/api/collab/knowledge/search",
      payload: { query: "模板", sourceId: "codex" }
    });
    const noTarget = await app!.inject({ method: "POST", url: "/api/collab/knowledge/search", payload: { query: "模板" } });

    expect(wrong.statusCode).toBe(404);
    expect(wrong.json()).toMatchObject({ error: { message: "当前会话未关联项目「其他」" } });
    expect(halfIdentity.statusCode).toBe(400);
    expect(noTarget.statusCode).toBe(400);
    expect(recall).not.toHaveBeenCalled();
  });

  it("tells a session with no project how to link one", async () => {
    const recall = vi.fn();
    createApp([], recall);

    const response = await app!.inject({
      method: "POST",
      url: "/api/collab/knowledge/search",
      payload: { query: "模板", sourceId: "codex", conversationId: "thread-1" }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("没有关联任何协作项目");
    expect(response.json().error.message).toContain("memmy-project session add");
    expect(recall).not.toHaveBeenCalled();
  });
});
