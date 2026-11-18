import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectedUserTimeZone } from "../../lib/user-time-zone.js";
import { ApiRequestError, requestJson } from "../http.js";

const runtimeConfig = {
  baseUrl: "http://127.0.0.1:18100",
  localToken: "local-token",
  timeZone: "+00:00"
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

  it("sends the configured timezone with every request", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await requestJson({
      config: runtimeConfig,
      path: "/api/health",
      schema: z.object({ ok: z.literal(true) })
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/health", runtimeConfig.baseUrl),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-memmy-time-zone": "+00:00"
        })
      })
    );
  });

  it("detects the system timezone only when config is absent", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await requestJson({
      config: { baseUrl: runtimeConfig.baseUrl, localToken: runtimeConfig.localToken },
      path: "/api/health",
      schema: z.object({ ok: z.literal(true) })
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/health", runtimeConfig.baseUrl),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-memmy-time-zone": detectedUserTimeZone()
        })
      })
    );
  });
});

it("broadcasts a structured credit failure but preserves the original API error", async () => {
  const dispatchEvent = vi.fn();
  vi.stubGlobal("window", {dispatchEvent});
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({error:{code:"CREDIT_INSUFFICIENT",message:"积分不足",requestId:"credit-test"}}, {status:422})));
  try {
    await expect(requestJson({config:runtimeConfig,path:"/api/asr",schema:z.unknown()})).rejects.toMatchObject({code:"CREDIT_INSUFFICIENT"});
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchEvent.mock.calls[0]![0].type).toBe("memmy:credits-exhausted-prompt");
  } finally { vi.unstubAllGlobals(); }
});

it("does not broadcast exhaustion when another call reserves the balance", async () => {
  const dispatchEvent = vi.fn();
  vi.stubGlobal("window", {dispatchEvent});
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({error:{code:"CREDIT_BALANCE_RESERVED",message:"积分暂被其他调用占用",requestId:"reserved-test"}}, {status:409})));
  try {
    await expect(requestJson({config:runtimeConfig,path:"/api/asr",schema:z.unknown()})).rejects.toMatchObject({code:"CREDIT_BALANCE_RESERVED"});
    expect(dispatchEvent).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
