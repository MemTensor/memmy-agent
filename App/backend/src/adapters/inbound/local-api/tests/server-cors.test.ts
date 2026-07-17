import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createProgressBus } from "../../../../services/progress-bus.js";
import type { BackendServices } from "../../../../services/index.js";
import type { PermissionManager } from "../../../../permission/index.js";
import { createLocalApiServer } from "../server.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("local api cors", () => {
  it("allows packaged renderer requests from 127.0.0.1", async () => {
    app = createServer();

    const response = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: {
        origin: "http://127.0.0.1:19100"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:19100");
    expect(response.headers.vary).toBe("Origin");
  });
});

function createServer(): FastifyInstance {
  return createLocalApiServer({
    permissionManager: createPermissionManager(),
    composioMcpToken: "mcp-token",
    services: {
      bootstrap: {
        async getBootstrap() {
          throw new Error("bootstrap not used");
        }
      },
      progressBus: createProgressBus()
    } as BackendServices
  });
}

function createPermissionManager(): PermissionManager {
  return {
    async verifyRuntimeToken() {
      return true;
    }
  } as PermissionManager;
}
