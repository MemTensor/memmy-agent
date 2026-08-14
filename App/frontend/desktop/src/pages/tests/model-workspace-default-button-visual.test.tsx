// @vitest-environment happy-dom

import type { ModelConfigView } from "@memmy/local-api-contracts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { ModelProviderConfig } from "../../api/config-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ModelWorkspaceSection } from "../model-workspace-section.js";

const stylesSourcePath = resolve(__dirname, "..", "..", "styles.css");
const tokensSourcePath = resolve(__dirname, "..", "..", "theme", "tokens.css");

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("model workspace default-model button", () => {
  it("renders the current and available default actions as recognizable buttons", async () => {
    const style = document.createElement("style");
    style.textContent = `${readFileSync(tokensSourcePath, "utf8")}\n${
      readFileSync(stylesSourcePath, "utf8").replace(/^@import[^;]+;$/gm, "")
    }`;
    document.head.append(style);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <ModelWorkspaceSection mode="byok" seedConfig={createSeedConfig()} />
        </I18nProvider>
      );
    });

    const pickerButton = [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]')]
      .find((button) => button.textContent?.includes("2 个已选"));
    if (!pickerButton) throw new Error("Missing task-model picker button");
    act(() => pickerButton.click());

    const currentDefault = [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed="true"]')]
      .find((button) => button.textContent?.trim() === "默认");
    const availableDefault = [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed="false"]')]
      .find((button) => button.textContent?.trim() === "设为默认");
    if (!currentDefault || !availableDefault) throw new Error("Missing default-model actions");

    const currentStyle = getComputedStyle(currentDefault);
    const availableStyle = getComputedStyle(availableDefault);
    for (const computed of [currentStyle, availableStyle]) {
      expect(computed.display).toBe("inline-flex");
      expect(computed.minHeight).toBe("24px");
      expect(computed.paddingLeft).toBe("9px");
      expect(computed.paddingRight).toBe("9px");
      expect(computed.borderTopWidth).toBe("1px");
      expect(computed.borderTopStyle).toBe("solid");
      expect(computed.cursor).toBe("pointer");
    }
    expect(currentStyle.fontWeight).toBe("700");
    expect(currentStyle.backgroundColor).toBe("#5cbfae");
    expect(currentStyle.color).toBe("white");
    expect(availableStyle.fontWeight).toBe("600");
    expect(availableStyle.backgroundColor).toBe("#ffffff");

    act(() => availableDefault.click());
    expect(currentDefault.getAttribute("aria-pressed")).toBe("false");
    expect(availableDefault.getAttribute("aria-pressed")).toBe("true");
    expect(getComputedStyle(currentDefault).backgroundColor).toBe("#ffffff");
    expect(getComputedStyle(availableDefault).backgroundColor).toBe("#5cbfae");

    act(() => root.unmount());
    document.head.removeChild(style);
    document.body.removeChild(container);
  });
});

function createSeedConfig(): ModelProviderConfig {
  const models = ["gpt-5.4", "gpt-4o"].map((model, index) => ({
    presetId: `byok-${index}`,
    provider: "openai" as const,
    endpointId: "openai-main",
    protocol: "openai-chat-completions" as const,
    model,
    source: "byok" as const,
    capabilities: ["agent" as const],
    available: true
  }));
  const catalog: ModelConfigView = {
    configRevision: "revision-default-button-visual",
    providers: [{
      provider: "openai",
      configured: true,
      hasApiKey: true,
      apiKeyMasked: "sk-••••test",
      apiKey: "",
      endpoints: [{
        endpointId: "openai-main",
        apiBase: "https://api.openai.com/v1",
        protocol: "openai-chat-completions",
        hasApiKey: true,
        apiKeyMasked: "sk-••••test",
        apiKey: ""
      }],
      accountManaged: false,
      editable: true,
      models
    }],
    modelAssignments: {
      byok: {
        agent: { candidates: models.map((model) => model.presetId), default: models[0]!.presetId },
        memorySummary: null,
        memoryEvolution: null,
        embedding: null,
        asr: null,
        imageGeneration: null
      },
      account: {
        agent: { candidates: [], default: null },
        memorySummary: null,
        memoryEvolution: null,
        embedding: null,
        asr: null,
        imageGeneration: null
      }
    },
    effectiveCandidates: { byok: models, account: [] },
    configured: true,
    updatedAt: "2026-08-12T00:00:00.000Z"
  };
  return {
    catalog,
    provider: "openai",
    endpointId: "openai-main",
    protocol: "openai-chat-completions",
    endpoint: "https://api.openai.com/v1",
    model: models[0]!.model,
    apiKey: "",
    apiKeyMasked: "sk-••••test",
    configured: true
  };
}
