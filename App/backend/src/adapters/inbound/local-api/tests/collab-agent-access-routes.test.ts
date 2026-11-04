/** Collab agent access routes: the authorization the board and settings read and change. */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollabAgentAccessService } from "../../../../services/collab-agent-access-service.js";
import type { CollabService } from "../../../../services/collab-service.js";
import { registerCollabRoutes } from "../routes/collab.js";

const VIEW = {
  granted: false,
  askedInProject: false,
  agents: [{ sourceId: "cursor", name: "Cursor", available: true, enabled: true, installed: false, added: false }]
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function createApp() {
  const access = {
    view: vi.fn(async () => VIEW),
    setGranted: vi.fn(async (granted: boolean) => ({
      view: { ...VIEW, granted },
      results: granted ? [{ sourceId: "cursor", name: "Cursor", ok: true }] : []
    })),
    install: vi.fn(async () => ({ view: VIEW, results: [] })),
    markAsked: vi.fn(async () => ({ ...VIEW, askedInProject: true })),
    setAgentEnabled: vi.fn(async (sourceId: string, enabled: boolean) => ({
      view: {
        ...VIEW,
        agents: [{ ...VIEW.agents[0], enabled }]
      },
      results: []
    })),
    read: vi.fn(),
    readableSourceIds: vi.fn()
  };
  app = Fastify();
  registerCollabRoutes(app, {
    collab: {} as unknown as CollabService,
    agentAccess: access as unknown as CollabAgentAccessService,
    authenticateRuntimeToken: async () => undefined
  });
  return access;
}

describe("collab agent access routes", () => {
  it("reads the current authorization", async () => {
    createApp();
    const response = await app!.inject({ method: "GET", url: "/api/collab/agent-access" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(VIEW);
  });

  it("grants and returns the per-agent install results", async () => {
    const access = createApp();
    const response = await app!.inject({ method: "PUT", url: "/api/collab/agent-access", payload: { granted: true } });
    expect(access.setGranted).toHaveBeenCalledWith(true);
    expect(response.json()).toMatchObject({ granted: true, results: [{ sourceId: "cursor", ok: true }] });
  });

  it("records the in-project question and toggles one agent", async () => {
    const access = createApp();
    await app!.inject({ method: "POST", url: "/api/collab/agent-access/asked" });
    expect(access.markAsked).toHaveBeenCalledOnce();

    const toggled = await app!.inject({
      method: "PUT",
      url: "/api/collab/agent-access/agents/cursor",
      payload: { enabled: false }
    });
    expect(access.setAgentEnabled).toHaveBeenCalledWith("cursor", false);
    expect(toggled.json().agents[0].enabled).toBe(false);
  });

  it("rejects an agent id that is not a source id", async () => {
    const access = createApp();
    const response = await app!.inject({
      method: "PUT",
      url: `/api/collab/agent-access/agents/${encodeURIComponent("../etc/passwd")}`,
      payload: { enabled: false }
    });
    expect(response.statusCode).toBe(400);
    expect(access.setAgentEnabled).not.toHaveBeenCalled();
  });

  it("installs again only for the agents that failed", async () => {
    const access = createApp();
    await app!.inject({ method: "POST", url: "/api/collab/agent-access/install", payload: { sourceIds: ["codex"] } });
    expect(access.install).toHaveBeenCalledWith(["codex"]);
  });
});
