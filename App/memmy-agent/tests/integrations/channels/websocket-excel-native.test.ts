import { afterEach, expect, it, vi } from "vitest";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import { WebSocketChannel } from "../../../src/integrations/channels/websocket.js";
import { nativeExcelControl } from "../../../src/tools/computer-use/excel-native-control.js";

afterEach(() => vi.restoreAllMocks());
it("requires bearer authorization for the one-time application grant, and GET never initializes it", async () => {
  const status = { scope: "application", enabled: false, configured: false, connected: false, workbooks: [] };
  const read = vi.spyOn(nativeExcelControl, "status").mockResolvedValue(status as any);
  const enable = vi.spyOn(nativeExcelControl, "setEnabled").mockResolvedValue({ ...status, enabled: true, configured: true } as any);
  const channel = new WebSocketChannel({ enabled: true, host: "127.0.0.1", port: 0 }, new MessageBus());
  const route = "/api/settings/computer-use/excel";
  channel.apiTokens.set("test", Date.now() / 1000 + 60);
  const connection = { remoteAddress: ["127.0.0.1"] };
  expect((await channel.dispatchHttp(connection, { path: route, method: "GET", headers: {} }))?.status).toBe(401);
  expect(read).not.toHaveBeenCalled();
  const headers = { authorization: "Bearer test" };
  const result = await channel.dispatchHttp(connection, { path: route, method: "GET", headers });
  expect(result?.headers["cache-control"]).toBe("no-store");
  expect(JSON.parse(String(result?.body)).scope).toBe("application");
  expect(enable).not.toHaveBeenCalled();
  expect((await channel.dispatchHttp(connection, { path: route + "?token=test", method: "POST", headers: {}, body: '{"enabled":true}' }))?.status).toBe(401);
  expect((await channel.dispatchHttp(connection, { path: route, method: "POST", headers, body: '{"enabled":"true"}' }))?.status).toBe(400);
  expect(enable).not.toHaveBeenCalled();
  expect((await channel.dispatchHttp(connection, { path: route, method: "POST", headers, body: '{"enabled":true}' }))?.status).toBe(200);
  expect(enable).toHaveBeenCalledExactlyOnceWith(true);
});

it("returns the actual system authorization failure without claiming connection success", async () => {
  vi.spyOn(nativeExcelControl, "setEnabled").mockRejectedValue(new Error("Automation denied (-1743)"));
  const channel = new WebSocketChannel({ enabled: true, host: "127.0.0.1", port: 0 }, new MessageBus());
  channel.apiTokens.set("test", Date.now() / 1000 + 60);
  const result = await channel.dispatchHttp({ remoteAddress: ["127.0.0.1"] }, { path: "/api/settings/computer-use/excel", method: "POST",
    headers: { authorization: "Bearer test" }, body: '{"enabled":true}' });
  expect(result?.status).toBe(503);
  expect(JSON.parse(String(result?.body))).toEqual({ error: "Automation denied (-1743)" });
});
