import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexHTTPError,
  OpenAICodexProvider,
  buildHeaders,
  codexErrorResponse,
  friendlyError,
  promptCacheKey,
  requestCodex,
  shouldRetryStatus,
  stripModelPrefix,
  logger,
  getCodexStorage,
} from "../../src/providers/openai-codex-provider.js";
import { makeProvider } from "../../src/providers/factory.js";
import { LLMProvider, LLMResponse } from "../../src/providers/base.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

class ReadTimeout extends Error {
  constructor(message = "") {
    super(message);
    this.name = "ReadTimeout";
  }
}

function successfulSse(content = "ok"): Response {
  return new Response(
    [
      `data: {"type":"response.output_text.delta","delta":${JSON.stringify(content)}}`,
      'data: {"type":"response.completed","response":{"status":"completed"}}',
      "data: [DONE]",
      "",
    ].join("\n"),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("OpenAI Codex provider", () => {
  it("documents the blank timeout root cause that used to produce empty Codex errors", () => {
    const error = new ReadTimeout("");
    const legacyContent = `Error calling Codex: ${error.message}`;

    expect(error.message).toBe("");
    expect(legacyContent).toBe("Error calling Codex: ");
    const legacyResponse = new LLMResponse({ content: legacyContent, finishReason: "error" });
    expect(legacyResponse.errorKind).toBeNull();
    expect(legacyResponse.errorShouldRetry).toBeNull();
  });

  it("omits raw upstream bodies from friendly HTTP errors", () => {
    const raw = "raw upstream body with PRIVATE PROMPT MUST NOT APPEAR";

    const message = friendlyError(500, raw);

    expect(message).toBe("HTTP 500: Codex API request failed");
    expect(message).not.toContain("PRIVATE PROMPT MUST NOT APPEAR");
  });

  it("populates HTTP metadata on non-200 Codex responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response('{"error":{"type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}', {
          status: 429,
          headers: { "retry-after": "2" },
        }),
      ),
    );

    try {
      await requestCodex("https://codex.example/responses", {}, { input: [] });
      throw new Error("request should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(CodexHTTPError);
      expect(String(error)).toContain("ChatGPT usage quota exceeded or rate limit triggered. Please try again later.");
      expect((error as CodexHTTPError).statusCode).toBe(429);
      expect((error as CodexHTTPError).retryAfter).toBe(2);
      expect((error as CodexHTTPError).errorType).toBe("rate_limit_exceeded");
      expect((error as CodexHTTPError).errorCode).toBe("rate_limit_exceeded");
      expect((error as CodexHTTPError).shouldRetry).toBe(true);
    }
  });

  it("uses a stable conversation prefix for Codex prompt cache keys", async () => {
    const bodies: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        bodies.push(JSON.parse(init.body));
        return successfulSse();
      }),
    );
    const provider = new OpenAICodexProvider({ getToken: () => ({ accountId: "acct", access: "tok" }) });

    await provider.chat({
      messages: [
        { role: "system", content: "You are memmy." },
        { role: "user", content: "first request" },
        { role: "assistant", content: "first answer" },
      ],
    });
    await provider.chat({
      messages: [
        { role: "system", content: "You are memmy." },
        { role: "user", content: "first request" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "follow up" },
      ],
    });
    await provider.chat({
      messages: [
        { role: "system", content: "You are memmy." },
        { role: "user", content: "different request" },
        { role: "assistant", content: "first answer" },
      ],
    });

    expect(bodies[0].prompt_cache_key).toBe(bodies[1].prompt_cache_key);
    expect(bodies[0].prompt_cache_key).not.toBe(bodies[2].prompt_cache_key);
  });

  it("converts blank timeout errors into typed retryable Codex responses", () => {
    const response = codexErrorResponse(new ReadTimeout(""));

    expect(response.finishReason).toBe("error");
    expect(response.content).toBe("Error calling Codex (ReadTimeout): timed out waiting for response");
    expect(response.errorKind).toBe("timeout");
    expect(response.errorShouldRetry).toBe(true);
  });

  it("writes sanitized diagnostics for timeout errors", async () => {
    const warning = vi.spyOn(logger, "warning").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new ReadTimeout("");
      }),
    );
    const provider = new OpenAICodexProvider({ getToken: () => ({ accountId: "acct", access: "tok" }) });

    const response = await provider.chat({ messages: [{ role: "user", content: "hello" }] });

    expect(response.content).toBe("Error calling Codex (ReadTimeout): timed out waiting for response");
    expect(warning).toHaveBeenCalledWith(
      "Codex API request failed: type={} kind={} retryable={} status={} errorType={} errorCode={} retryAfter={} summary={}",
      "ReadTimeout",
      "timeout",
      true,
      null,
      null,
      null,
      null,
      "ReadTimeout timeout",
    );
  });

  it("keeps prompt content out of Codex diagnostic logs", async () => {
    const warning = vi.spyOn(logger, "warning").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new ReadTimeout("");
      }),
    );
    const provider = new OpenAICodexProvider({ getToken: () => ({ accountId: "acct", access: "tok" }) });

    const response = await provider.chat({ messages: [{ role: "user", content: "PRIVATE PROMPT MUST NOT APPEAR" }] });

    expect(response.errorKind).toBe("timeout");
    expect(JSON.stringify(warning.mock.calls)).toContain("Codex API request failed");
    expect(JSON.stringify(warning.mock.calls)).toContain("ReadTimeout");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("PRIVATE PROMPT MUST NOT APPEAR");
  });

  it("uses structured timeout metadata for retry decisions", async () => {
    const delays: number[] = [];
    const provider = new OpenAICodexProvider({ getToken: () => ({ accountId: "acct", access: "tok" }) });
    let calls = 0;
    vi.spyOn(provider, "chat").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return codexErrorResponse(new ReadTimeout(""));
      return new LLMResponse({ content: "ok", finishReason: "stop" });
    });
    (provider as any).sleep = async (delay: number) => {
      delays.push(delay);
    };

    const response = await provider.chatWithRetry({ messages: [{ role: "user", content: "hello" }] });

    expect(response.content).toBe("ok");
    expect(calls).toBe(2);
    expect(delays).toEqual([1]);
  });

  it("preserves HTTP status, retry-after, and error codes in Codex errors", () => {
    const response = codexErrorResponse(
      new CodexHTTPError("HTTP 503: backend unavailable", {
        statusCode: 503,
        retryAfter: 2.5,
        errorType: "server_error",
        errorCode: "overloaded",
      }),
    );

    expect(response.finishReason).toBe("error");
    expect(response.content).toBe("Error calling Codex (CodexHTTPError): HTTP 503: backend unavailable");
    expect(response.errorStatusCode).toBe(503);
    expect(response.errorKind).toBe("http");
    expect(response.errorType).toBe("server_error");
    expect(response.errorCode).toBe("overloaded");
    expect(response.retryAfter).toBe(2.5);
    expect(response.errorShouldRetry).toBe(true);
  });

  it("omits raw upstream bodies from HTTP diagnostic logs", async () => {
    const warning = vi.spyOn(logger, "warning").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("raw upstream body with PRIVATE PROMPT MUST NOT APPEAR", { status: 500 })),
    );
    const provider = new OpenAICodexProvider({ getToken: () => ({ accountId: "acct", access: "tok" }) });

    const response = await provider.chat({ messages: [{ role: "user", content: "hello" }] });

    expect(response.content).toBe("Error calling Codex (CodexHTTPError): HTTP 500: Codex API request failed");
    expect(JSON.stringify(warning.mock.calls)).toContain("HTTP 500");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("PRIVATE PROMPT MUST NOT APPEAR");
  });

  it.each([
    ["rate_limit_exceeded", "rate_limit_exceeded", true],
    ["insufficient_quota", "insufficient_quota", false],
  ])("preserves 429 retry semantics for %s/%s", (errorType, errorCode, expectedRetry) => {
    const response = codexErrorResponse(
      new CodexHTTPError("ChatGPT usage quota exceeded or rate limit triggered. Please try again later.", {
        statusCode: 429,
        errorType,
        errorCode,
        shouldRetry: expectedRetry,
      }),
    );

    expect(response.errorStatusCode).toBe(429);
    expect(response.errorType).toBe(errorType);
    expect(response.errorCode).toBe(errorCode);
    expect(response.errorShouldRetry).toBe(expectedRetry);
  });

  it("keeps the friendly 429 fallback retryable when no structured code is known", () => {
    const response = codexErrorResponse(new CodexHTTPError(friendlyError(429, ""), { statusCode: 429 }));

    expect(response.errorStatusCode).toBe(429);
    expect(response.errorShouldRetry).toBe(true);
  });

  it.each([
    ['{"error":{"type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}', true],
    ['{"error":{"type":"insufficient_quota","code":"insufficient_quota"}}', false],
  ])("classifies 429 retryability from raw error semantics", (raw, expectedRetry) => {
    const [errorType, errorCode] = LLMProvider.extractErrorTypeCode(raw);

    expect(shouldRetryStatus(429, errorType, errorCode, raw)).toBe(expectedRetry);
  });

  it("strips codex prefixes and advertises progress deltas", () => {
    const provider = new OpenAICodexProvider({ defaultModel: "openai-codex/gpt-5.1-codex" });

    expect(provider.getDefaultModel()).toBe("openai-codex/gpt-5.1-codex");
    expect(stripModelPrefix("codex/gpt-5.1-codex")).toBe("gpt-5.1-codex");
    expect(OpenAICodexProvider.supportsProgressDeltas).toBe(true);
  });

  it("is selected by the provider factory", () => {
    expect(makeProvider("openai-codex", "openai-codex/gpt-5.1-codex")).toBeInstanceOf(OpenAICodexProvider);
  });

  it("resolves Codex OAuth tokens from local storage before env fallback", async () => {
    const oldPath = process.env.OAUTH_CLI_KIT_TOKEN_PATH;
    const oldAccess = process.env.OPENAI_CODEX_ACCESS_TOKEN;
    const oldAccount = process.env.OPENAI_CODEX_ACCOUNT_ID;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-codex-token-"));
    process.env.OAUTH_CLI_KIT_TOKEN_PATH = path.join(root, "auth", "codex.json");
    delete process.env.OPENAI_CODEX_ACCESS_TOKEN;
    delete process.env.OPENAI_CODEX_ACCOUNT_ID;
    try {
      getCodexStorage().save({ accountId: "stored-acct", access: "stored-token" });
      const provider = new OpenAICodexProvider();

      await expect(provider.resolveToken()).resolves.toEqual({ accountId: "stored-acct", access: "stored-token" });
    } finally {
      if (oldPath == null) delete process.env.OAUTH_CLI_KIT_TOKEN_PATH;
      else process.env.OAUTH_CLI_KIT_TOKEN_PATH = oldPath;
      if (oldAccess == null) delete process.env.OPENAI_CODEX_ACCESS_TOKEN;
      else process.env.OPENAI_CODEX_ACCESS_TOKEN = oldAccess;
      if (oldAccount == null) delete process.env.OPENAI_CODEX_ACCOUNT_ID;
      else process.env.OPENAI_CODEX_ACCOUNT_ID = oldAccount;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds Codex request headers and stable prompt cache keys", () => {
    expect(buildHeaders("acct", "tok")).toMatchObject({
      Authorization: "Bearer tok",
      "chatgpt-account-id": "acct",
      "OpenAI-Beta": "responses=experimental",
      accept: "text/event-stream",
    });

    expect(promptCacheKey([{ b: 2, a: 1 }])).toBe(promptCacheKey([{ a: 1, b: 2 }]));
  });

  it("posts Codex Responses SSE requests and streams deltas/tool calls", async () => {
    const calls: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        const sse = [
          'data: {"type":"response.output_text.delta","delta":"he"}',
          'data: {"type":"response.output_text.delta","delta":"llo"}',
          'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_1","id":"fc_1","name":"lookup","arguments":""}}',
          'data: {"type":"response.function_call_arguments.delta","call_id":"call_1","delta":"{\\"q\\":"}',
          'data: {"type":"response.function_call_arguments.delta","call_id":"call_1","delta":"\\"x\\"}"}',
          'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5},"output":[{"type":"reasoning","summary":[{"text":"hidden"}]}]}}',
          "data: [DONE]",
          "",
        ].join("\n");
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      }),
    );
    const provider = new OpenAICodexProvider({
      getToken: () => ({ accountId: "acct", access: "tok" }),
      codexUrl: "https://codex.test/responses",
      defaultModel: "openai-codex/gpt-5.1-codex",
    });
    const deltas: string[] = [];
    const toolDeltas: any[] = [];

    const result = await provider.chatStream({
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      reasoningEffort: "high",
      onContentDelta: (delta) => {
        deltas.push(delta);
      },
      onToolCallDelta: (delta) => {
        toolDeltas.push(delta);
      },
    });

    expect(result.content).toBe("hello");
    expect(result.reasoningContent).toBe("hidden");
    expect(result.usage.total_tokens).toBe(5);
    expect(result.toolCalls[0].toOpenAIToolCall()).toMatchObject({
      function: { name: "lookup", arguments: '{"q":"x"}' },
    });
    expect(deltas).toEqual(["he", "llo"]);
    expect(toolDeltas.map((delta) => delta.arguments_delta).join("")).toBe('{"q":"x"}');
    expect(calls[0].url).toBe("https://codex.test/responses");
    expect(calls[0].body).toMatchObject({
      model: "gpt-5.1-codex",
      stream: true,
      instructions: "sys",
      reasoning: { effort: "high" },
      tools: [{ type: "function", name: "lookup", description: "", parameters: { type: "object" } }],
    });
  });

  it("returns structured retry metadata for Codex failures", async () => {
    vi.spyOn(logger, "warning").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":{"type":"rate_limit_error","code":"rate_limit_exceeded"}}', { status: 429, headers: { "retry-after": "2" } })),
    );
    const provider = new OpenAICodexProvider({ getToken: () => ({ accountId: "acct", access: "tok" }) });

    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });

    expect(result.finishReason).toBe("error");
    expect(result.errorStatusCode).toBe(429);
    expect(result.errorShouldRetry).toBe(true);
    expect(result.retryAfter).toBe(2);
    expect(shouldRetryStatus(400, null, null, "bad request")).toBe(false);
    expect(
      codexErrorResponse(new CodexHTTPError("quota", { statusCode: 429, errorType: "insufficient_quota" })).errorShouldRetry,
    ).toBe(false);
  });
});
