// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MODEL_NAME_MAX_LENGTH, type ModelConfigView } from "@memmy/local-api-contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProviderConfig } from "../../api/config-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ModelWorkspaceSection } from "../model-workspace-section.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LONG_MODEL_NAME = "gpt-4o-".repeat(24);
const stylesPath = resolve(__dirname, "..", "..", "styles.css");

describe("模型工作区长模型名称", () => {
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

  it("让模型库名称占用剩余空间后单行省略", () => {
    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <ModelWorkspaceSection mode="byok" seedConfig={seedConfig(LONG_MODEL_NAME)} />
        </I18nProvider>
      );
    });

    const modelName = container.querySelector<HTMLElement>(`.provider-model-list [title="${LONG_MODEL_NAME}"]`);
    expect(modelName).not.toBeNull();
    expect(modelName?.classList.contains("flex-1")).toBe(true);
    expect(modelName?.classList.contains("truncate")).toBe(true);

    const stylesSource = readFileSync(stylesPath, "utf8");
    const modelListRule = stylesSource.match(/\.provider-model-list\s*\{[^}]*\}/s)?.[0] ?? "";
    expect(modelListRule).toContain("max-width: 100%;");
    expect(modelListRule).toContain("overflow-x: hidden;");
  });

  it("限制编辑器中的模型名称输入长度", () => {
    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <ModelWorkspaceSection mode="byok" seedConfig={seedConfig(LONG_MODEL_NAME)} />
        </I18nProvider>
      );
    });

    const editConnection = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.getAttribute("aria-label")?.startsWith("编辑 "));
    expect(editConnection).toBeDefined();
    act(() => editConnection?.click());

    const editModel = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.getAttribute("aria-label") === `编辑模型 ${LONG_MODEL_NAME}`);
    expect(editModel).toBeDefined();
    act(() => editModel?.click());

    const modelInput = [...document.querySelectorAll<HTMLInputElement>('input[type="text"]')]
      .find((input) => input.value === LONG_MODEL_NAME);
    expect(modelInput).toBeDefined();
    expect(modelInput?.maxLength).toBe(MODEL_NAME_MAX_LENGTH);
  });
});

function seedConfig(modelName: string): ModelProviderConfig {
  const model = {
    presetId: "preset-long-model",
    provider: "openai" as const,
    endpointId: "endpoint-openai",
    protocol: "openai-chat-completions" as const,
    model: modelName,
    source: "byok" as const,
    capabilities: ["agent" as const],
    available: true
  };
  const assignment = {
    agent: { candidates: [model.presetId], default: model.presetId },
    memorySummary: null,
    memoryEvolution: null,
    embedding: null,
    asr: null,
    imageGeneration: null
  };
  const catalog: ModelConfigView = {
    configRevision: "revision-long-model",
    providers: [{
      provider: "openai",
      configured: true,
      hasApiKey: true,
      apiKeyMasked: "sk••••test",
      apiKey: "",
      endpoints: [{
        endpointId: model.endpointId,
        apiBase: "https://example.com/v1",
        protocol: model.protocol,
        hasApiKey: true,
        apiKeyMasked: "sk••••test",
        apiKey: ""
      }],
      accountManaged: false,
      editable: true,
      models: [model]
    }],
    modelAssignments: {
      byok: assignment,
      account: { ...assignment, agent: { candidates: [], default: null } }
    },
    effectiveCandidates: { byok: [model], account: [model] },
    configured: true,
    updatedAt: "2026-08-12T00:00:00.000Z"
  };
  return {
    catalog,
    provider: "openai",
    endpoint: "https://example.com/v1",
    model: modelName,
    apiKey: "",
    apiKeyMasked: "sk••••test",
    configured: true
  };
}
