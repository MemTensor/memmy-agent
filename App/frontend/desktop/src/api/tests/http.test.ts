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
  it.each([
    ["plugin_incompatible", 400, "Missing Host capabilities: memmy.event-checkpoints/v1"],
    ["plugin_permission_denied", 403, "Plugin permissions need approval"],
    ["plugin_activation_failed", 409, "Plugin runtime could not start"]
  ] as const)("preserves %s details from the plugin API", async (code, status, message) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { code, message, requestId: "plugin-install-test" }
    }), { status, headers: { "content-type": "application/json" } })));
    await expect(requestJson({ config: runtimeConfig, path: "/api/v1/plugins/install",
      schema: z.object({ ok: z.literal(true) }), body: { pluginId: "teach-mode", version: "0.4.1" }
    })).rejects.toMatchObject({ code, status, message, requestId: "plugin-install-test" });
  });
  it("preserves a plugin entitlement denial instead of turning it into an unknown error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { code: "plugin_entitlement_required", message: "Plugin grant missing", requestId: "plugin-test" }
    }), { status: 403, headers: { "content-type": "application/json" } })));
    await expect(requestJson({ config: runtimeConfig, path: "/api/v1/plugins/legal-labor/capabilities/session-start/invoke",
      schema: z.object({ ok: z.literal(true) }), body: {} })).rejects.toMatchObject({
        status: 403, code: "plugin_entitlement_required", requestId: "plugin-test"
      });
  });
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
