import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, requestJson } from "../http.js";

const runtimeConfig = {
  baseUrl: "http://127.0.0.1:18100",
  localToken: "local-token"
};

describe("requestJson", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses backend error envelopes into ApiRequestError metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: {
              code: "memory_layer_unavailable",
              message: "Memory layer unavailable",
              requestId: "req-1"
            }
          }),
          { status: 503, headers: { "content-type": "application/json" } }
        );
      })
    );

    await expect(
      requestJson({
        config: runtimeConfig,
        path: "/api/v1/health",
        schema: z.object({ ok: z.literal(true) })
      })
    ).rejects.toMatchObject({
      name: "ApiRequestError",
      status: 503,
      code: "memory_layer_unavailable",
      requestId: "req-1",
      message: "Memory layer unavailable"
    } satisfies Partial<ApiRequestError>);
  });

  it("does not send JSON content-type for bodyless POST requests", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestJson({
        config: runtimeConfig,
        path: "/api/v1/integrations/airtable/authorize",
        schema: z.object({ ok: z.literal(true) }),
        init: { method: "POST" }
      })
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/v1/integrations/airtable/authorize", runtimeConfig.baseUrl),
      expect.objectContaining({
        method: "POST",
        body: undefined,
        headers: expect.not.objectContaining({
          "content-type": "application/json"
        })
      })
    );
  });
});
