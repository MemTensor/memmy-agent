import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import { externalBrowserBridge } from "../../../src/core/agent-runtime/tools/external-browser-bridge.js";
import { WebSocketChannel } from "../../../src/integrations/channels/websocket.js";

const originalManaged = process.env.MEMMY_DESKTOP_MANAGED_GATEWAY;
const originalDataDir = process.env.MEMMY_AGENT_DATA_DIR;
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  if (originalManaged == null) delete process.env.MEMMY_DESKTOP_MANAGED_GATEWAY;
  else process.env.MEMMY_DESKTOP_MANAGED_GATEWAY = originalManaged;
  if (originalDataDir == null) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = originalDataDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("serves connected browsers only through an authenticated desktop settings route", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-browser-status-"));
  roots.push(root);
  process.env.MEMMY_AGENT_DATA_DIR = root;
  process.env.MEMMY_DESKTOP_MANAGED_GATEWAY = "1";
  vi.spyOn(externalBrowserBridge, "start").mockResolvedValue({ port: 1234 });
  vi.spyOn(externalBrowserBridge, "listConnected").mockReturnValue(["chrome"]);
  vi.spyOn(externalBrowserBridge, "listClaims").mockReturnValue([{
    connectionId: "private-id", tabId: 7, browser: "chrome", title: "Test", url: "https://example.test/", claimedAt: 1,
  }]);
  const channel = new WebSocketChannel({ enabled: true, host: "127.0.0.1", port: 0 }, new MessageBus());
  const route = "/api/settings/computer-use/browsers";
  expect((await channel.dispatchHttp({ remoteAddress: ["127.0.0.1"] }, { path: route, method: "GET", headers: {} }))?.status).toBe(401);
  channel.apiTokens.set("test", Date.now() / 1000 + 60);
  const response = await channel.dispatchHttp({ remoteAddress: ["127.0.0.1"] }, {
    path: route, method: "GET", headers: { authorization: "Bearer test" },
  });
  expect(response?.status).toBe(200);
  expect(response?.headers["cache-control"]).toBe("no-store");
  const body = JSON.parse(String(response?.body));
  expect(body).toEqual({ connected: ["chrome"], claims: [{
    browser: "chrome", title: "Test", url: "https://example.test/",
  }] });
  expect(String(response?.body)).not.toContain("private-id");
});
