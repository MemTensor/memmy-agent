import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpPluginsClient } from "../plugins-client.js";

const config = { baseUrl: "http://127.0.0.1:18100", localToken: "token", timeZone: "+00:00" };

afterEach(() => vi.unstubAllGlobals());

describe("plugins client", () => {
  it("loads UI slots independently and invokes declared capabilities", async () => {
    const fetchMock = vi.fn(async (request: URL, init?: RequestInit) => {
      if (request.pathname.endsWith("/invoke")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ conversationId: "chat-1", input: { topic: "memory" } });
        return Response.json({ callId: "call-1", event: { type: "result", output: { ok: true } } });
      }
      return Response.json({ html: request.pathname.endsWith("/surface") ? "surface" : "renderer" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createHttpPluginsClient(config);

    await expect(client.getUi("com.example.review", "renderer")).resolves.toBe("renderer");
    await expect(client.getUi("com.example.review", "surface")).resolves.toBe("surface");
    await expect(client.invoke("com.example.review", "run", { conversationId: "chat-1", input: { topic: "memory" } })).resolves.toMatchObject({ callId: "call-1" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("manages plugin installation, permission approval, and lifecycle", async () => {
    const plugin = installedPlugin();
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (request: URL, init?: RequestInit) => {
      calls.push({
        path: request.pathname,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      });
      if (init?.method === "DELETE") return Response.json({ ok: true });
      return Response.json(plugin);
    }));
    const client = createHttpPluginsClient(config);

    await client.install(plugin.id);
    await client.approvePermissions(plugin.id, plugin.manifest.permissions);
    await client.enable(plugin.id);
    await client.disable(plugin.id);
    await client.uninstall(plugin.id);

    expect(calls).toEqual([
      { path: "/api/v1/plugins/install", method: "POST", body: { pluginId: plugin.id } },
      { path: `/api/v1/plugins/${plugin.id}/permissions`, method: "PUT", body: { permissions: plugin.manifest.permissions } },
      { path: `/api/v1/plugins/${plugin.id}/enable`, method: "POST", body: {} },
      { path: `/api/v1/plugins/${plugin.id}/disable`, method: "POST", body: {} },
      { path: `/api/v1/plugins/${plugin.id}`, method: "DELETE", body: undefined }
    ]);
  });
});

function installedPlugin() {
  return {
    id: "literature-review",
    version: "0.2.0",
    manifest: {
      apiVersion: "memmy/v1",
      id: "literature-review",
      name: "Literature Review",
      version: "0.2.0",
      runtime: { adapter: "command", config: { command: "runtime/command.js" } },
      capabilities: [{ id: "run", name: "Run", description: "Run", inputSchema: { type: "object" }, outputSchema: { type: "object" }, execution: "job" }],
      permissions: [{ type: "network", hosts: ["export.arxiv.org", "arxiv.org"] }]
    },
    state: "pending_approval",
    approvedPermissions: [],
    config: {},
    lastError: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z"
  };
}
