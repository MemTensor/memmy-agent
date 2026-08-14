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

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("model workspace task picker layout", () => {
  it("keeps the default action separated from the model selection control", async () => {
    const style = document.createElement("style");
    style.textContent = readFileSync(stylesSourcePath, "utf8").replace(/^@import[^;]+;$/gm, "");
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
      .find((button) => button.textContent?.includes("1 个已选"));
    if (!pickerButton) throw new Error("Missing task-model picker button");
    act(() => pickerButton.click());

    const row = [...container.querySelectorAll<HTMLElement>(".task-model-picker__option")]
      .find((option) => option.textContent?.includes("gpt-5.4")
        && option.textContent.includes("OpenAI 兼容")
        && option.textContent.includes("默认"));
    if (!row) throw new Error("Missing default custom-model row");
    const choiceButton = row.querySelector<HTMLButtonElement>('button[role="checkbox"]');
    const defaultButton = row.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    if (!choiceButton || !defaultButton) throw new Error("Missing task-model row actions");

    const choiceStyle = getComputedStyle(choiceButton);
    expect(choiceStyle.display).toBe("flex");
    expect(choiceStyle.flex).toBe("1 1 auto");
    expect(parseFloat(choiceStyle.minWidth)).toBe(0);
    const separation = parseFloat(getComputedStyle(row).gap || "0")
      + parseFloat(getComputedStyle(defaultButton).marginLeft || "0");
    expect(separation).toBeGreaterThanOrEqual(16);

    act(() => root.unmount());
    document.head.removeChild(style);
    document.body.removeChild(container);
  });
});

function createSeedConfig(): ModelProviderConfig {
  const model = {
    presetId: "byok-gpt",
    provider: "openai" as const,
    endpointId: "openai-main",
    protocol: "openai-chat-completions" as const,
    model: "gpt-5.4",
    source: "byok" as const,
    capabilities: ["agent" as const],
    available: true
  };
  const catalog: ModelConfigView = {
    configRevision: "revision-task-picker-spacing",
    providers: [{
      provider: "openai",
      configured: true,
      hasApiKey: true,
      apiKeyMasked: "sk-••••test",
      apiKey: "",
      endpoints: [{
        endpointId: model.endpointId,
        apiBase: "https://api.openai.com/v1",
        protocol: model.protocol,
        hasApiKey: true,
        apiKeyMasked: "sk-••••test",
        apiKey: ""
      }],
      accountManaged: false,
      editable: true,
      models: [model]
    }],
    modelAssignments: {
      byok: {
        agent: { candidates: [model.presetId], default: model.presetId },
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
    effectiveCandidates: { byok: [model], account: [] },
    configured: true,
    updatedAt: "2026-08-12T00:00:00.000Z"
  };
  return {
    catalog,
    provider: "openai",
    endpointId: model.endpointId,
    protocol: model.protocol,
    endpoint: "https://api.openai.com/v1",
    model: model.model,
    apiKey: "",
    apiKeyMasked: "sk-••••test",
    configured: true
  };
}
