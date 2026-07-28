import { afterEach, describe, expect, it, vi } from "vitest";
import { postJsonWithRetry } from "../src/model/http.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("model HTTP responses", () => {
  it("reports an HTML 404 as an endpoint error before parsing JSON", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(
      "<!doctype html><html><body>Not Found</body></html>",
      { status: 404, headers: { "content-type": "text/html; charset=utf-8" } }
    )));

    const request = postJsonWithRetry({
      provider: "openai_compatible",
      url: "https://invalid.example/v1/chat/completions",
      body: {},
      timeoutMs: 1_000,
      maxRetries: 0
    });

    await expect(request).rejects.toThrow(
      "openai_compatible HTTP 404: endpoint returned HTML instead of JSON; check the configured model endpoint"
    );
    await expect(request).rejects.not.toThrow("Unexpected token");
  });

  it("explains when a successful URL serves an HTML fallback page", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(
      "<!doctype html><html><body>Memmy</body></html>",
      { status: 200, headers: { "content-type": "text/html" } }
    )));

    await expect(postJsonWithRetry({
      provider: "openai_compatible",
      url: "http://127.0.0.1:19000/not-a-model-api/chat/completions",
      body: {},
      timeoutMs: 1_000,
      maxRetries: 0
    })).rejects.toThrow(
      "openai_compatible HTTP 200: expected JSON but received HTML instead of a model API response; check the configured model endpoint"
    );
  });

  it("keeps a structured provider error without dumping its JSON envelope", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: { message: "model does not exist" } }),
      { status: 404, headers: { "content-type": "application/json" } }
    )));

    await expect(postJsonWithRetry({
      provider: "openai_compatible",
      url: "https://api.example/v1/chat/completions",
      body: {},
      timeoutMs: 1_000,
      maxRetries: 0
    })).rejects.toThrow("openai_compatible HTTP 404: model does not exist");
  });
});
