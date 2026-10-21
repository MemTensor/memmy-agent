import { once } from "node:events";
import { get, type IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import type { PermissionManager } from "../../../../permission/index.js";
import type { BackendServices } from "../../../../services/index.js";
import { createProgressBus } from "../../../../services/progress-bus.js";
import { createLocalApiServer } from "../server.js";

describe("local API shutdown", () => {
  it("ends an active renderer event stream before waiting for HTTP connections to close", async () => {
    const app = createLocalApiServer({
      permissionManager: {
        async verifyRuntimeToken(token: string) { return token === "test-token"; }
      } as PermissionManager,
      composioMcpToken: "test-mcp-token",
      services: { progressBus: createProgressBus() } as BackendServices
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const request = get(`${address}/api/events?token=test-token`);
    let response: IncomingMessage | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      [response] = await once(request, "response") as [IncomingMessage];
      expect(response.statusCode).toBe(200);
      const stream = response;
      const connected = await new Promise<string>((resolve, reject) => {
        let message = "";
        const onData = (chunk: Buffer) => {
          message += chunk.toString();
          if (!message.includes("\n\n")) return;
          stream.off("data", onData);
          stream.off("error", reject);
          resolve(message);
        };
        stream.on("data", onData);
        stream.once("error", reject);
      });
      expect(connected).toContain("event: app.connected");

      const ended = once(response, "end");
      response.resume();
      const closed = await Promise.race([
        Promise.all([app.close(), ended]).then(() => true),
        new Promise<boolean>((resolve) => {
          deadline = setTimeout(() => resolve(false), 2_000);
        })
      ]);
      expect(closed).toBe(true);
      expect(response.readableEnded).toBe(true);
    } finally {
      clearTimeout(deadline);
      response?.destroy();
      request.destroy();
      await app.close();
    }
  });

  it.each([true, false])("closes a request whose authentication finishes during shutdown (allowed=%s)", async (allowed) => {
    let beginVerification!: () => void;
    const verifying = new Promise<void>((resolve) => { beginVerification = resolve; });
    let finishVerification!: (allowed: boolean) => void;
    const verification = new Promise<boolean>((resolve) => { finishVerification = resolve; });
    let beginClose!: () => void;
    const preClosed = new Promise<void>((resolve) => { beginClose = resolve; });
    const app = createLocalApiServer({
      permissionManager: {
        async verifyRuntimeToken() {
          beginVerification();
          return verification;
        }
      } as PermissionManager,
      composioMcpToken: "test-mcp-token",
      services: { progressBus: createProgressBus() } as BackendServices
    });
    app.addHook("preClose", async () => { beginClose(); });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const request = get(`${address}/api/events?token=test-token`);
    const responded = once(request, "response") as Promise<[IncomingMessage]>;
    let response: IncomingMessage | undefined;
    try {
      await verifying;
      const closed = Promise.resolve(app.close());
      await preClosed;
      finishVerification(allowed);
      [response] = await responded;
      expect(response.statusCode).toBe(503);
      const ended = once(response, "end");
      response.resume();
      await Promise.all([closed, ended]);
    } finally {
      finishVerification(false);
      response?.destroy();
      request.destroy();
      await app.close();
    }
  });
});
