import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelHttpError, postJsonWithRetry } from "../src/model/http.js";
import { classifyProcessingError } from "../src/service/worker/job-handlers.js";

afterEach(() => {
  vi.useRealTimers();
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

  it("preserves the structured provider code and unabridged detail", async () => {
    const detail = `Error:\n40309\n${"x".repeat(1_100)}\nTAIL`;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: { code: 40309, message: detail } }),
      { status: 403, headers: { "content-type": "application/json" } }
    )));

    const actualModelContext = {
      presetId: "summary-byok",
      provider: "openai",
      endpointId: "memory",
      protocol: "openai-chat-completions" as const,
      model: "gpt-summary",
      source: "byok" as const,
      ownerAccountId: null,
      capability: "memory_summary" as const,
      capabilities: ["memory_summary" as const]
    };
    const request = postJsonWithRetry({
      provider: "openai_compatible",
      actualModelContext,
      url: "https://api.example/v1/chat/completions",
      body: {},
      timeoutMs: 1_000,
      maxRetries: 0
    });

    await expect(request).rejects.toMatchObject({
      name: "ModelHttpError",
      provider: "openai_compatible",
      httpStatus: 403,
      errorCode: "40309",
      detail,
      actualModelContext
    });
  });

  it("rejects an HTTP 200 provider business error before parsing it as a completion", async () => {
    const detail = "memory_summary token 用量不足，请申请更多额度后再试。";
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        code: 40309,
        data: { quota_scene: "memory_summary" },
        message: detail
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )));

    const request = postJsonWithRetry({
      provider: "openai_compatible",
      url: "https://api.example/v1/chat/completions",
      body: {},
      timeoutMs: 1_000,
      maxRetries: 0
    });

    await expect(request).rejects.toMatchObject({
      name: "ModelHttpError",
      provider: "openai_compatible",
      httpStatus: 200,
      errorCode: "40309",
      detail
    });
  });

  it("does not reject an HTTP 200 response with a non-error business code", async () => {
    const body = { code: "success", data: { value: 1 }, message: "ok" };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify(body),
      { status: 200, headers: { "content-type": "application/json" } }
    )));

    await expect(postJsonWithRetry({
      provider: "openai_compatible",
      url: "https://api.example/v1/chat/completions",
      body: {},
      timeoutMs: 1_000,
      maxRetries: 0
    })).resolves.toEqual(body);
  });

  it("does not override a non-quota structured code from legacy detail text", () => {
    expect(classifyProcessingError(new ModelHttpError(
      "openai_compatible HTTP 400: request failed",
      "openai_compatible",
      400,
      "invalid_request",
      "provider metadata mentions old code 40309"
    ))).toEqual({ code: "invalid_model_request", retryAction: "none" });
  });

  it("does not retry deterministic HTTP 400 failures", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: { code: "invalid_request", message: "invalid embedding input" } }),
      { status: 400, headers: { "content-type": "application/json" } }
    ));
    vi.stubGlobal("fetch", fetchMock);

    const request = postJsonWithRetry({
      provider: "openai_compatible",
      url: "https://api.example/v1/embeddings",
      body: {},
      timeoutMs: 1_000,
      maxRetries: 2
    });
    const rejected = expect(request).rejects.toThrow("invalid embedding input");
    await vi.runAllTimersAsync();
    await rejected;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries HTTP 429 failures and returns the recovered response", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: { message: "rate limited" } }),
        { status: 429, headers: { "content-type": "application/json" } }
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ data: "ok" }),
        { status: 200, headers: { "content-type": "application/json" } }
      ));
    vi.stubGlobal("fetch", fetchMock);

    const request = postJsonWithRetry<{ data: string }>({
      provider: "openai_compatible",
      url: "https://api.example/v1/embeddings",
      body: {},
      timeoutMs: 1_000,
      maxRetries: 2
    });
    await vi.runAllTimersAsync();

    await expect(request).resolves.toEqual({ data: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("classifies embedding token-limit failures as terminal", () => {
    expect(classifyProcessingError(new ModelHttpError(
      "openai_compatible HTTP 400: maximum context length exceeded",
      "openai_compatible",
      400,
      "context_length_exceeded",
      "This model's maximum context length is 8192 tokens, however 12000 tokens were requested"
    ))).toEqual({ code: "model_input_too_long", retryAction: "none" });
  });
});
