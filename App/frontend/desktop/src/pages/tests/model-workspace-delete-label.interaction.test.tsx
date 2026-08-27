// @vitest-environment happy-dom

import type { ModelConfigView } from "@memmy/local-api-contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProviderConfig } from "../../api/config-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ModelWorkspaceSection } from "../model-workspace-section.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ModelWorkspaceSection delete confirmation provider labels", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it.each([
    ["volcengine", "字节豆包"],
    ["dashscope", "通义千问"]
  ] as const)("uses the visible %s provider name in the delete confirmation", (provider, expectedLabel) => {
    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <ModelWorkspaceSection mode="account" seedConfig={createSeedConfig(provider)} />
        </I18nProvider>
      );
    });

    const connectionCard = container.querySelector("article");
    const cardLabel = connectionCard?.querySelector("h4 span.truncate")?.textContent?.trim();
    expect(cardLabel).toBe(expectedLabel);

    const deleteButton = connectionCard?.querySelector<HTMLButtonElement>(
      `button[aria-label="删除 ${provider} 配置"]`
    );
    expect(deleteButton).not.toBeNull();
    act(() => deleteButton?.click());

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const message = dialog?.querySelector(".confirm-dialog__message")?.textContent?.replace(/\s+/g, " ").trim();
    expect(message).toBe(
      `删除 ${expectedLabel} 配置后，其下模型会从当前空间和候选列表中移除。此操作需要重新添加才能恢复。`
    );
    expect(message).toContain(`删除 ${cardLabel} 配置后`);
    expect(message).not.toContain(provider);
  });
});

function createSeedConfig(provider: "volcengine" | "dashscope"): ModelProviderConfig {
  const endpointId = `${provider}-endpoint`;
  const presetId = `${provider}-preset`;
  const model = {
    presetId,
    provider,
    endpointId,
    protocol: "openai-chat-completions" as const,
    model: provider === "volcengine" ? "doubao-pro-256k" : "qwen-max",
    source: "byok" as const,
    capabilities: ["agent" as const],
    available: true
  };
  const catalog: ModelConfigView = {
    configRevision: `revision-${provider}`,
    providers: [{
      provider,
      configured: true,
      hasApiKey: true,
      apiKeyMasked: "••••test",
      apiKey: "",
      endpoints: [{
        endpointId,
        apiBase: "https://example.com/v1",
        protocol: model.protocol,
        hasApiKey: true,
        apiKeyMasked: "••••test",
        apiKey: ""
      }],
      accountManaged: false,
      editable: true,
      models: [model]
    }],
    modelAssignments: {
      byok: {
        agent: { candidates: [presetId], default: presetId },
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
    provider,
    endpoint: "https://example.com/v1",
    model: model.model,
    apiKey: "",
    apiKeyMasked: "••••test",
    configured: true
  };
}
