import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LlmProviderLogo, llmProviderLogoUrl } from "../llm-provider-logo.js";

describe("llmProviderLogoUrl", () => {
  it("maps only desktop-supported providers and their frontend aliases", () => {
    for (const provider of [
      "openai",
      "anthropic",
      "gemini",
      "deepseek",
      "zhipu",
      "qwen",
      "moonshot",
      "minimax",
      "baidu",
      "doubao"
    ]) {
      expect(llmProviderLogoUrl(provider)).toMatch(/^data:image\/svg\+xml/);
    }

    expect(llmProviderLogoUrl("memmy_account")).toMatch(/memmy-account\.png$/);
    expect(llmProviderLogoUrl("google")).toBe(llmProviderLogoUrl("gemini"));
    expect(llmProviderLogoUrl("kimi")).toBe(llmProviderLogoUrl("moonshot"));
    expect(llmProviderLogoUrl("openrouter")).toBeNull();
  });

  it("uses an exact frontend copy of the desktop app icon for account mode", () => {
    const frontendIcon = readFileSync(fileURLToPath(new URL("../../assets/llm-provider-logo/memmy-account.png", import.meta.url)));
    const desktopIcon = readFileSync(fileURLToPath(new URL("../../../../../shell/desktop/build/icon.png", import.meta.url)));

    expect(frontendIcon).toEqual(desktopIcon);
  });

  it("marks provider images so account-mode transparent padding can be normalized", () => {
    expect(renderToString(<LlmProviderLogo provider=" Memmy_Account " />)).toContain('data-provider="memmy_account"');
  });
});
