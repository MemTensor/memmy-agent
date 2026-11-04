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

  it("rejects a message-only HTTP 200 memory_evolution quota error", async () => {
    const detail = "memory_evolution token 用量不足，请申请更多额度后再试。";
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ message: detail }),
      { status: 200, headers: { "content-type": "application/json" } }
    )));

    await expect(postJsonWithRetry({
      provider: "openai_compatible",
      url: "https://api.example/v1/chat/completions",
      body: {},
      timeoutMs: 1_000,
      maxRetries: 2
    })).rejects.toMatchObject({
      name: "ModelHttpError",
      provider: "openai_compatible",
      httpStatus: 200,
      errorCode: "40309",
      detail
    });

    expect(classifyProcessingError(new ModelHttpError(
      `openai_compatible HTTP 200: ${detail}`,
      "openai_compatible",
      200,
      "40309",
      detail
    ))).toEqual({ code: "quota_exhausted", retryAction: "open_settings" });
  });

  it.each([
    [40100, "Not logged in", "authentication_required"],
    [40000, "Invalid request parameters", "invalid_model_request"],
    [40308, "Token quota is insufficient", "quota_exhausted"],
    [50000, "Internal server error", "provider_server_error"]
  ] as const)("rejects Memmy Account HTTP 200 business code %s", async (code, message, errorCategory) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ code, data: null, message }),
      { status: 200, headers: { "content-type": "application/json" } }
    )));

    await expect(postJsonWithRetry({
      provider: "openai_compatible",
      businessEnvelope: "memmy_account",
      url: "https://api.example/v1/chat/completions",
      body: {},
      timeoutMs: 1_000,
      maxRetries: 0
    })).rejects.toMatchObject({
      name: "ModelHttpError",
      httpStatus: 200,
      errorCode: String(code),
      errorCategory,
      detail: message
    });
  });

  it.each([200, 403])(
    "prefers the canonical Memmy code from a legacy-compatible HTTP %s quota envelope",
    async (status) => {
      const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
        error: {
          message: "Token quota is insufficient",
          type: "insufficient_quota",
          code: "40309",
          memmy_code: "40308"
        }
      }), { status, headers: { "content-type": "application/json" } }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(postJsonWithRetry({
        provider: "openai_compatible",
        businessEnvelope: "memmy_account",
        url: "https://api.example/v1/chat/completions",
        body: {},
        timeoutMs: 1_000,
        maxRetries: 2
      })).rejects.toMatchObject({
        name: "ModelHttpError",
        httpStatus: status,
        errorCode: "40308",
        errorType: "insufficient_quota",
        errorCategory: "quota_exhausted"
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  );

  it("does not apply the Memmy Account top-level code contract to generic providers", async () => {
    const body = { code: 20001, data: [{ embedding: [0.1, 0.2] }], message: "provider success" };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify(body),
      { status: 200, headers: { "content-type": "application/json" } }
    )));

    await expect(postJsonWithRetry({
      provider: "openai_compatible",
      url: "https://third-party.example/v1/embeddings",
      body: {},
      timeoutMs: 1_000,
      maxRetries: 0
    })).resolves.toEqual(body);
  });

  it.each([
    [
      "a rejected API key",
      401,
      { message: "Incorrect API key provided: sk-xx.", type: "invalid_request_error", param: null, code: "invalid_api_key" },
      { code: "model_configuration", retryAction: "open_settings" }
    ],
    [
      "an unknown model",
      404,
      { message: "The model `gpt-x` does not exist or you do not have access to it.", type: "invalid_request_error", param: null, code: "model_not_found" },
      { code: "model_configuration", retryAction: "open_settings" }
    ],
    [
      "an over-long input",
      400,
      { message: "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.", type: "invalid_request_error", param: "messages", code: "context_length_exceeded" },
      { code: "model_input_too_long", retryAction: "none" }
    ]
  ] as const)("keeps the configuration semantics of %s from a user's own OpenAI key", async (_name, status, error, expected) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error }),
      { status, headers: { "content-type": "application/json" } }
    )));

    const failure = await postJsonWithRetry({
      provider: "openai_compatible",
      url: "https://api.openai.example/v1/chat/completions",
      body: {},
      timeoutMs: 1_000,
      maxRetries: 0
    }).catch((caught: unknown) => caught);

    expect(failure).toMatchObject({ name: "ModelHttpError", httpStatus: status, errorCategory: undefined });
    expect(classifyProcessingError(failure)).toEqual(expected);
  });

  it("keeps an upstream over-long input passed through the Memmy gateway terminal but shrinkable", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: {
        message: "This model's maximum context length is 8192 tokens.",
        type: "invalid_request_error",
        code: "context_length_exceeded"
      }
    }), { status: 400, headers: { "content-type": "application/json" } })));

    const failure = await postJsonWithRetry({
      provider: "openai_compatible",
      businessEnvelope: "memmy_account",
      url: "https://api.example/v1/chat/completions",
      body: {},
      timeoutMs: 1_000,
      maxRetries: 0
    }).catch((caught: unknown) => caught);

    expect(classifyProcessingError(failure)).toEqual({ code: "model_input_too_long", retryAction: "none" });
  });

  it("classifies a user's own OpenAI insufficient_quota as quota without retrying", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" }
    }), { status: 429, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const failure = await postJsonWithRetry({
      provider: "openai_compatible",
      url: "https://api.openai.example/v1/chat/completions",
      body: {},
      timeoutMs: 1_000,
      maxRetries: 2
    }).catch((caught: unknown) => caught);

    expect(failure).toMatchObject({ errorCategory: "quota_exhausted" });
    expect(classifyProcessingError(failure)).toEqual({ code: "quota_exhausted", retryAction: "open_settings" });
    expect(fetchMock).toHaveBeenCalledOnce();
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

  it("does not retry an HTTP 429 insufficient-quota response", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: { code: "40308", type: "insufficient_quota", message: "quota exhausted" } }),
      { status: 429, headers: { "content-type": "application/json" } }
    ));
    vi.stubGlobal("fetch", fetchMock);

    const request = postJsonWithRetry({
      provider: "memmy_account",
      businessEnvelope: "memmy_account",
      url: "https://api.example/v1/chat/completions",
      body: {},
      timeoutMs: 1_000,
      maxRetries: 2
    });
    await expect(request).rejects.toMatchObject({
      name: "ModelHttpError",
      httpStatus: 429,
      errorCode: "40308",
      errorType: "insufficient_quota",
      errorCategory: "quota_exhausted"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
