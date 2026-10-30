/** Error envelope tests. */
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryLayerError, MemoryLayerNetworkError } from "../../adapters/outbound/memory-client/index.js";
import { API_ERROR_CODES, HTTP_STATUS_BY_CODE, withErrorEnvelope } from "../error-envelope.js";
import { ApiErrorBodySchema } from "@memmy/local-api-contracts";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("withErrorEnvelope", () => {
  it("uses the actual server request id when the caller provides no correlation id", async () => {
    let serial = 0;
    app = Fastify({ logger: false, genReqId: () => `server-request-${++serial}` });
    app.get("/fail", withErrorEnvelope(async () => {
      throw Object.assign(new Error("incompatible plugin"), { code: "plugin_incompatible" });
    }));
    const first = await app.inject({ method: "GET", url: "/fail" });
    const second = await app.inject({ method: "GET", url: "/fail" });
    expect(first.json().error.requestId).toBe("server-request-1");
    expect(second.json().error.requestId).toBe("server-request-2");
    expect(ApiErrorBodySchema.parse(first.json())).toEqual(first.json());
  });
  it("preserves an explicit caller request header", async () => {
    app = Fastify({ logger: false });
    app.get("/fail", withErrorEnvelope(async () => { throw new Error("failed"); }));
    const response = await app.inject({ method: "GET", url: "/fail", headers: { "x-request-id": "caller-request" } });
    expect(response.json().error.requestId).toBe("caller-request");
  });
  it("reports a failed Memory connection as recoverable service unavailability", async () => {
    app = Fastify({ logger: false });
    app.get("/health", withErrorEnvelope(async () => {
      throw new MemoryLayerNetworkError(new Error("connection reset"));
    }));
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: {
      code: "memory_layer_unavailable", message: "memory layer network error"
    } });
  });
  it("maps every ApiErrorCode to the configured HTTP status", async () => {
    for (const code of API_ERROR_CODES) {
      app = Fastify({ logger: false });
      app.post(
        "/fail",
        withErrorEnvelope(async () => {
          throw Object.assign(new Error(`${code} message`), { code });
        })
      );

      const response = await app.inject({
        method: "POST",
        url: "/fail",
        payload: { requestId: `req-${code}` }
      });

      expect(response.statusCode).toBe(HTTP_STATUS_BY_CODE[code]);
      expect(ApiErrorBodySchema.parse(response.json())).toEqual(response.json());
      expect(response.json()).toEqual({
        error: {
          code,
          message: `${code} message`,
          requestId: `req-${code}`
        }
      });
      await app.close();
      app = undefined;
    }
  });

  it("passes through MemoryLayerError status and whitelisted code", async () => {
    app = Fastify({ logger: false });
    app.post(
      "/fail",
      withErrorEnvelope(async () => {
        throw new MemoryLayerError("not_found", 404, "missing memory");
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/fail",
      payload: { requestId: "req-1" }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: "not_found",
        message: "missing memory",
        requestId: "req-1"
      }
    });
  });

  it("maps ordinary errors to internal", async () => {
    app = Fastify({ logger: false });
    app.post(
      "/fail",
      withErrorEnvelope(async () => {
        throw new Error("boom");
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/fail",
      payload: { requestId: "req-1" }
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "internal",
        message: "boom",
        requestId: "req-1"
      }
    });
  });
});
