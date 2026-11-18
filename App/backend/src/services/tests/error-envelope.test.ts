/** Error envelope tests. */
import Fastify from "fastify";
import { createHttpCloudClient } from "../../adapters/outbound/cloud-client/http-cloud-client.js";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryLayerError, MemoryLayerNetworkError } from "../../adapters/outbound/memory-client/index.js";
import { API_ERROR_CODES, HTTP_STATUS_BY_CODE, withErrorEnvelope } from "../error-envelope.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("withErrorEnvelope", () => {
  it.each([["USAGE_FORBIDDEN", 403], ["USAGE_NOT_FOUND", 404]] as const)("preserves %s through the local API", async (code, status) => {
    const client = createHttpCloudClient({ fetchImpl: async () => Response.json({ code, message: "消费记录不可访问" }, { status }) });
    app = Fastify({ logger: false });
    app.get("/usage", withErrorEnvelope(async () => client.getCredits({ uuid: "test", resource: "usage/other-call" })));
    const response = await app.inject({ method: "GET", url: "/usage" });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
  });
  it("preserves the cloud rate-limit code and Retry-After through the local API", async () => {
    const client = createHttpCloudClient({ fetchImpl: async () => Response.json({
      code: "RATE_LIMITED", message: "稍后重试", details: { retryAfterSeconds: 52 }, retryable: true, traceId: "trace"
    }, { status: 429, headers: { "Retry-After": "52" } }) });
    app = Fastify({ logger: false });
    app.post("/reward", withErrorEnvelope(async () => client.postCredits({ uuid: "test", resource: "check-ins", body: { requestId: "same-request" } })));
    const response = await app.inject({ method: "POST", url: "/reward", payload: {} });
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("52");
    expect(response.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
  });
  it("preserves the ASR format error through the local API", async () => {
    const client = createHttpCloudClient({ fetchImpl: async () => Response.json({
      code: "ASR_FORMAT_UNSUPPORTED", message: "音频格式不支持"
    }, { status: 400 }) });
    app = Fastify({ logger: false });
    app.post("/asr", withErrorEnvelope(async () => client.transcribeAudio({ uuid: "test", audioBase64: "YQ==", mimeType: "text/plain" })));
    const response = await app.inject({ method: "POST", url: "/asr", payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "ASR_FORMAT_UNSUPPORTED" } });
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
