/** Asr stream upgrade tests. */
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgressBus } from "../../../../services/progress-bus.js";
import type { BackendServices } from "../../../../services/index.js";
import type { PermissionManager } from "../../../../permission/index.js";
import { createLocalApiServer } from "../server.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * Sends a raw WebSocket handshake and reports how the server answered.
 *
 * A real `ws` client would swallow the rejection into a generic error, and
 * the status line is exactly what this test is about.
 */
async function attemptUpgrade(
  server: FastifyInstance,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; upgraded: boolean }> {
  const { port } = server.server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers
      }
    });
    req.on("upgrade", (response: IncomingMessage, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode ?? 101, upgraded: true });
    });
    req.on("response", (response: IncomingMessage) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0, upgraded: false });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("asr stream upgrade", () => {
  it("rejects an upgrade without the runtime token before touching the relay", async () => {
    const handleUpgrade = vi.fn();
    app = createServer(handleUpgrade);
    await app.listen({ host: "127.0.0.1", port: 0 });

    const result = await attemptUpgrade(app, "/api/asr/stream");

    expect(result).toEqual({ status: 401, upgraded: false });
    expect(handleUpgrade).not.toHaveBeenCalled();
  });

  it("rejects an upgrade carrying a wrong token", async () => {
    const handleUpgrade = vi.fn();
    app = createServer(handleUpgrade);
    await app.listen({ host: "127.0.0.1", port: 0 });

    const result = await attemptUpgrade(app, "/api/asr/stream?token=nope");

    expect(result).toEqual({ status: 401, upgraded: false });
    expect(handleUpgrade).not.toHaveBeenCalled();
  });

  it("applies the same origin rule as HTTP so a foreign page cannot open the socket", async () => {
    const handleUpgrade = vi.fn();
    app = createServer(handleUpgrade);
    await app.listen({ host: "127.0.0.1", port: 0 });

    const result = await attemptUpgrade(app, "/api/asr/stream?token=test-token", { origin: "https://evil.example" });

    expect(result).toEqual({ status: 403, upgraded: false });
    expect(handleUpgrade).not.toHaveBeenCalled();
  });

  it("hands a correctly authenticated upgrade to the relay", async () => {
    // The stub completes the handshake itself so the client observes a real
    // 101 rather than a torn-down socket; what this asserts is that the relay
    // was reached with the original request.
    const handleUpgrade = vi.fn((_request: unknown, socket: { write(chunk: string): void; destroy(): void }) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      socket.destroy();
    });
    app = createServer(handleUpgrade);
    await app.listen({ host: "127.0.0.1", port: 0 });

    const result = await attemptUpgrade(app, "/api/asr/stream?token=test-token", { origin: "http://127.0.0.1:19100" });

    expect(result).toEqual({ status: 101, upgraded: true });
    expect(handleUpgrade).toHaveBeenCalledTimes(1);
    const [request] = handleUpgrade.mock.calls[0] as [IncomingMessage];
    expect(request.url).toBe("/api/asr/stream?token=test-token");
  });

  it("drops upgrades for any other path so unrelated sockets never reach the relay", async () => {
    const handleUpgrade = vi.fn();
    app = createServer(handleUpgrade);
    await app.listen({ host: "127.0.0.1", port: 0 });

    await expect(attemptUpgrade(app, "/api/events?token=test-token")).rejects.toThrow();
    expect(handleUpgrade).not.toHaveBeenCalled();
  });
});

function createServer(handleUpgrade: (...args: unknown[]) => void): FastifyInstance {
  return createLocalApiServer({
    permissionManager: createPermissionManager(),
    composioMcpToken: "mcp-token",
    services: {
      progressBus: createProgressBus(),
      asrStream: {
        handleUpgrade,
        async close() {
          return undefined;
        }
      }
    } as unknown as BackendServices,
    heartbeatIntervalMs: 20
  });
}

function createPermissionManager(): PermissionManager {
  return {
    async getRuntimeToken() {
      return "test-token";
    },
    async verifyRuntimeToken(token: string) {
      return token === "test-token";
    }
  } as PermissionManager;
}
