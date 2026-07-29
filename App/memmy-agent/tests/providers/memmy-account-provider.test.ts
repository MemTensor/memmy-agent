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
