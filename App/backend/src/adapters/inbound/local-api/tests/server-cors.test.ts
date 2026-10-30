import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createProgressBus } from "../../../../services/progress-bus.js";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";
import { VerificationRequestError } from "../../../../services/verification-request-error.js";
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
    expect(response.headers["access-control-expose-headers"]).toBe("Retry-After");
    expect(response.headers.vary).toBe("Origin");
  });

  it.each([429, 504] as const)("exposes remaining retry delay on %s errors only to allowed origins", async status => {
    app = createServer();
    app.post("/retry-test", withErrorEnvelope(async () => {
      throw new VerificationRequestError("retry later", status, 17);
    }));
    const allowed = await app.inject({ method: "POST", url: "/retry-test", headers: { origin: "http://127.0.0.1:19100" } });
    expect(allowed.statusCode).toBe(status);
    expect(allowed.headers["retry-after"]).toBe("17");
    expect(allowed.headers["access-control-expose-headers"]).toBe("Retry-After");
    const denied = await app.inject({ method: "POST", url: "/retry-test", headers: { origin: "https://untrusted.example" } });
    expect(denied.statusCode).toBe(403);
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    expect(denied.headers["access-control-expose-headers"]).toBeUndefined();
    expect(denied.headers["retry-after"]).toBeUndefined();
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
