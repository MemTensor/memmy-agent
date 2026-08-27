import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";
import { findByName } from "../../src/providers/registry.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Memmy Account provider headers", () => {
  it.each([
    ["cn", "cn"],
    ["intl", "intl"],
    [" INTL ", "intl"],
    ["unknown", "cn"],
  ] as const)("resolves edition %j to X-Agent-Region=%s", (edition, expected) => {
    vi.stubEnv("MEMMY_APP_EDITION", edition);

    const provider = new OpenAICompatProvider({
      apiKey: "account-token",
      defaultModel: "agent_chat",
      spec: findByName("memmy_account"),
    });

    expect(provider.defaultHeaders["X-Agent-Region"]).toBe(expected);
  });

  it("defaults to the domestic region when the edition is unset", () => {
    vi.stubEnv("MEMMY_APP_EDITION", "");

    const provider = new OpenAICompatProvider({
      apiKey: "account-token",
      defaultModel: "agent_chat",
      spec: findByName("memmy_account"),
    });

    expect(provider.defaultHeaders["X-Agent-Region"]).toBe("cn");
  });

  it("does not add X-Agent-Region to other providers", () => {
    vi.stubEnv("MEMMY_APP_EDITION", "intl");

    const provider = new OpenAICompatProvider({
      apiKey: "sk-test",
      defaultModel: "gpt-4o-mini",
      spec: findByName("openai"),
    });

    expect(provider.defaultHeaders).not.toHaveProperty("X-Agent-Region");
  });

  it("allows configured extra headers to override provider defaults", () => {
    vi.stubEnv("MEMMY_APP_EDITION", "cn");

    const provider = new OpenAICompatProvider({
      apiKey: "account-token",
      defaultModel: "agent_chat",
      spec: findByName("memmy_account"),
      extraHeaders: { "X-Agent-Region": "intl" },
    });

    expect(provider.defaultHeaders["X-Agent-Region"]).toBe("intl");
  });
});

describe("Memmy Account quota errors", () => {
  function provider(): OpenAICompatProvider {
    return new OpenAICompatProvider({
      apiKey: "account-token",
      defaultModel: "agent_chat",
      spec: findByName("memmy_account"),
    });
  }

  it("classifies an HTTP 200 business error with code 40309", () => {
    const response = provider().parseResponse({
      code: 40309,
      message: "account quota exhausted",
    });

    expect(response.finishReason).toBe("error");
    expect(response.errorStatusCode).toBeNull();
    expect(response.errorCode).toBe("40309");
    expect(response.errorCategory).toBe("quota_exhausted");
  });

  it("classifies code 40309 even when the gateway omits its message", () => {
    const response = provider().parseResponse({ code: 40309 });

    expect(response.finishReason).toBe("error");
    expect(response.errorCode).toBe("40309");
    expect(response.errorCategory).toBe("quota_exhausted");
  });

  it("classifies a streaming business error chunk with code 40309", () => {
    const detail = `account quota exhausted\n${"x".repeat(600)}\nTAIL`;
    const response = OpenAICompatProvider.parseChunks(
      [{ code: "40309", message: detail }],
      findByName("memmy_account"),
    );

    expect(response.finishReason).toBe("error");
    expect(response.errorCode).toBe("40309");
    expect(response.errorCategory).toBe("quota_exhausted");
    expect(response.content).toBe(`Error calling LLM: ${detail}`);
  });

  it.each([0, "0", 40308])("does not classify business code %j", (code) => {
    const response = provider().parseResponse({ code, message: "quota-like text" });

    expect(response.errorCategory).toBeNull();
  });
});

describe("Memmy Account image-to-text fallback", () => {
  it("is enabled only for the account provider", () => {
    const account = new OpenAICompatProvider({
      apiKey: "account-token",
      defaultModel: "agent_chat",
      spec: findByName("memmy_account"),
    });
    const openai = new OpenAICompatProvider({
      apiKey: "sk-test",
      defaultModel: "gpt-4o-mini",
      spec: findByName("openai"),
    });

    expect(account.supportsAccountImageTextFallback()).toBe(true);
    expect(openai.supportsAccountImageTextFallback()).toBe(false);
  });

  it("uses the existing client with fixed image2text request settings", async () => {
    const create = vi.fn(async () => ({
      choices: [{ message: { content: "a chart" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }));
    const provider = new OpenAICompatProvider({
      apiKey: "account-token",
      apiBase: "https://account.example.test/v1",
      defaultModel: "agent_chat",
      spec: findByName("memmy_account"),
      extraHeaders: { "X-Test": "same-client" },
      extraBody: { tenant: "same-body" },
    });
    provider.client = {
      responses: { create: vi.fn() },
      chat: { completions: { create } },
    };
    const signal = new AbortController().signal;
    const messages = [{
      role: "user",
      content: [
        { type: "text", text: "Describe Image 1" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ],
    }];

    const response = await provider.runAccountImageTextFallback({ messages, signal });

    expect(response?.content).toBe("a chart");
    expect(create).toHaveBeenCalledOnce();
    const [body, options] = create.mock.calls[0] as unknown as [
      Record<string, any>,
      Record<string, any>,
    ];
    expect(body).toMatchObject({
      model: "image2text",
      messages,
      temperature: 0,
      max_tokens: 2048,
      tenant: "same-body",
    });
    expect(body).not.toHaveProperty("tools");
    expect(options).toEqual({ signal });
    expect(provider.defaultHeaders).toMatchObject({
      "X-Agent-Region": expect.any(String),
      "X-Test": "same-client",
    });
  });

  it("returns null without an SDK request for non-account providers", async () => {
    const provider = new OpenAICompatProvider({
      apiKey: "sk-test",
      defaultModel: "gpt-4o-mini",
      spec: findByName("openai"),
    });
    const ensureClient = vi.spyOn(provider, "ensureClient");

    await expect(provider.runAccountImageTextFallback({ messages: [] })).resolves.toBeNull();
    expect(ensureClient).not.toHaveBeenCalled();
  });
});
