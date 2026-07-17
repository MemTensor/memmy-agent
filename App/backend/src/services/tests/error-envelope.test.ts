/** Error envelope tests. */
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryLayerError } from "../../adapters/outbound/memory-client/index.js";
import { API_ERROR_CODES, HTTP_STATUS_BY_CODE, withErrorEnvelope } from "../error-envelope.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("withErrorEnvelope", () => {
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
