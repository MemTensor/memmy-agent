import { describe, expect, it } from "vitest";
import { Config, ValueError } from "../../src/config/schema.js";
import { AnthropicProvider } from "../../src/providers/anthropic-provider.js";
import { AzureOpenAIProvider } from "../../src/providers/azure-openai-provider.js";
import { GitHubCopilotProvider } from "../../src/providers/github-copilot-provider.js";
import { makeProvider } from "../../src/providers/factory.js";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";
import { findByName } from "../../src/providers/registry.js";

describe("provider initialization", () => {
  it("normalizes hyphen and camel-case provider names", () => {
    expect(findByName("github-copilot")?.name).toBe("github_copilot");
    expect(findByName("volcengineCodingPlan")?.name).toBe("volcengine_coding_plan");
    expect(findByName("atomic-chat")?.name).toBe("atomic_chat");
    expect(findByName("antLing")?.defaultApiBase).toBe("https://api.ant-ling.com/v1");
    expect(findByName("memmy-account")?.name).toBe("memmy_account");
  });

  it("creates backend-specific provider classes", () => {
    expect(makeProvider("github-copilot", "github-copilot/gpt-4.1")).toBeInstanceOf(GitHubCopilotProvider);
    expect(makeProvider("anthropic", "anthropic/claude-opus-4-5")).toBeInstanceOf(AnthropicProvider);
    expect(
      makeProvider(
        new Config({
          agents: { defaults: { provider: "azure", model: "deployment" } },
          providers: { azure_openai: { apiKey: "key", apiBase: "https://res.openai.azure.com" } },
        }),
      ),
    ).toBeInstanceOf(AzureOpenAIProvider);
    expect(makeProvider("openai", "openai/gpt-4o-mini")).toBeInstanceOf(OpenAICompatProvider);
  });

  it("validates required provider credentials", () => {
    expect(() => makeProvider(new Config({ agents: { defaults: { provider: "openai", model: "gpt-4.1" } } }))).toThrow(
      ValueError,
    );
    expect(() =>
      makeProvider(new Config({ agents: { defaults: { provider: "azure", model: "deployment" } } })),
    ).toThrow("Azure OpenAI requires apiKey and apiBase");
  });
});
