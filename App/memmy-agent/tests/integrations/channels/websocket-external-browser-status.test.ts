import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import { externalBrowserBridge } from "../../../src/core/agent-runtime/tools/external-browser-bridge.js";
import { WebSocketChannel } from "../../../src/integrations/channels/websocket.js";
import { nativeExcelControl } from "../../../src/tools/computer-use/excel-native-control.js";

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
  vi.spyOn(externalBrowserBridge, "listTabStatuses").mockReturnValue([{
    connectionId: "private-id", tabId: 8, browser: "chrome", title: "Other", url: "https://other.test/",
    status: "attach_failed", reason: "网页连接暂时失败，请重试。", updatedAt: 2,
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
  expect(body).toEqual({ connected: ["chrome"], connectionDiagnostics: { port: 0, events: [] }, controllableTabCount: 1, claims: [{
    browser: "chrome", title: "Test", url: "https://example.test/",
  }], tabStatuses: [{
    browser: "chrome", title: "Other", url: "https://other.test/",
    status: "attach_failed", reason: "网页连接暂时失败，请重试。", updatedAt: 2,
  }] });
  expect(String(response?.body)).not.toContain("private-id");
  expect(body.tabStatuses[0]).not.toHaveProperty("tabId");
});

it("reports a connected browser with no controllable tabs and its attachment limitation", async () => {
  process.env.MEMMY_DESKTOP_MANAGED_GATEWAY = "1";
  vi.spyOn(externalBrowserBridge, "start").mockResolvedValue({ port: 1234 });
  vi.spyOn(externalBrowserBridge, "listConnected").mockReturnValue(["edge"]);
  vi.spyOn(externalBrowserBridge, "listClaims").mockReturnValue([]);
  vi.spyOn(externalBrowserBridge, "listTabStatuses").mockReturnValue([{
    connectionId: "private-id", tabId: 7, browser: "edge", title: "Test", url: "https://example.test/",
    status: "user_detached", reason: "你已停止连接此网页，请重新允许后再操作。", updatedAt: 1,
  }]);
  const channel = new WebSocketChannel({ enabled: true }, new MessageBus());
  channel.apiTokens.set("test", Date.now() / 1000 + 60);
  const response = await channel.handleExternalBrowserStatus({ method: "GET", headers: { authorization: "Bearer test" } });
  expect(response.status).toBe(200);
  expect(JSON.parse(String(response.body))).toMatchObject({
    connected: ["edge"], controllableTabCount: 0, claims: [],
    tabStatuses: [{ browser: "edge", status: "user_detached" }],
  });
});

it("excludes protected claims from the controllable count while accepting legacy claims without statuses", async () => {
  process.env.MEMMY_DESKTOP_MANAGED_GATEWAY = "1";
  vi.spyOn(externalBrowserBridge, "start").mockResolvedValue({ port: 1234 });
  vi.spyOn(externalBrowserBridge, "listConnected").mockReturnValue(["chrome"]);
  vi.spyOn(externalBrowserBridge, "listClaims").mockReturnValue([{
    connectionId: "private-id", tabId: 7, browser: "chrome", title: "Legacy", url: "https://example.test/", claimedAt: 1,
  }, {
    connectionId: "private-id", tabId: 8, browser: "chrome", title: "受保护页面", url: "https://example.test", claimedAt: 2,
  }]);
  vi.spyOn(externalBrowserBridge, "listTabStatuses").mockReturnValue([{
    connectionId: "private-id", tabId: 8, browser: "chrome", title: "受保护页面", url: "https://example.test",
    status: "protected", reason: "当前网页受凭据保护。", updatedAt: 2,
  }]);
  const channel = new WebSocketChannel({ enabled: true }, new MessageBus());
  channel.apiTokens.set("test", Date.now() / 1000 + 60);
  const response = await channel.handleExternalBrowserStatus({ method: "GET", headers: { authorization: "Bearer test" } });
  expect(response.status).toBe(200);
  expect(JSON.parse(String(response.body)).controllableTabCount).toBe(1);
});

it("starts the Chrome/Edge bridge with the desktop gateway before a settings request", async () => {
  process.env.MEMMY_DESKTOP_MANAGED_GATEWAY = "1";
  vi.spyOn(nativeExcelControl, "start").mockResolvedValue(undefined);
  vi.spyOn(nativeExcelControl, "stop").mockImplementation(() => undefined);
  const bridgeStart = vi.spyOn(externalBrowserBridge, "start").mockResolvedValue({ port: 1234 });
  const serverFactory = vi.fn(async () => ({}));
  const channel = new WebSocketChannel({ enabled: true, serverFactory }, new MessageBus());
  await channel.start();
  expect(bridgeStart).toHaveBeenCalledOnce();
  expect(serverFactory).toHaveBeenCalledOnce();
  await channel.stop();
});

it("keeps the gateway available and explains a bridge port conflict", async () => {
  process.env.MEMMY_DESKTOP_MANAGED_GATEWAY = "1";
  vi.spyOn(nativeExcelControl, "start").mockResolvedValue(undefined);
  vi.spyOn(nativeExcelControl, "stop").mockImplementation(() => undefined);
  vi.spyOn(externalBrowserBridge, "start").mockRejectedValue(new Error("EADDRINUSE"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const serverFactory = vi.fn(async () => ({}));
  const channel = new WebSocketChannel({ enabled: true, serverFactory }, new MessageBus());
  await expect(channel.start()).resolves.toBeUndefined();
  expect(serverFactory).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("another Memmy gateway"), { error: "EADDRINUSE" });
  await channel.stop();
});
