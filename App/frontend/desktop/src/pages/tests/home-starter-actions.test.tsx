// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { zhCNMessages } from "../../i18n/messages.js";
import { HomeStarterActions } from "../home-starter-actions.js";
import type { PluginScenarioTarget } from "../plugin-conversation-controls.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const legalScenarios: PluginScenarioTarget[] = [
  { pluginId: "legal-labor", id: "labor-risk-diagnosis", name: "用工风险诊断",
    description: "企业资料、访谈录音，一键生成风险诊断报告", icon: "scale", prompt: "生成诊断报告" },
  { pluginId: "legal-labor", id: "labor-system-design", name: "用工体系设计",
    description: "基于诊断结果，生成制度流程、整改方案与落地计划", icon: "workflow", prompt: "设计用工体系" }
];

describe("home starter actions", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onSend = vi.fn();

  beforeEach(() => {
    onSend.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(scenarios: PluginScenarioTarget[], disabled = false) {
    await act(async () => root.render(
      <I18nProvider language="zh-CN"><HomeStarterActions scenarios={scenarios} disabled={disabled} onSend={onSend} /></I18nProvider>
    ));
  }

  it("restores the literature review when the legal diagnosis is unavailable", async () => {
    await render([]);
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".home-prompt-suggestions button")];
    expect(buttons.map((button) => button.textContent)).toEqual([
      zhCNMessages["home.suggestion.two"],
      zhCNMessages["home.suggestion.one"],
      zhCNMessages["home.suggestion.three"]
    ]);
    await act(async () => buttons[1]?.click());
    expect(onSend).toHaveBeenCalledWith(zhCNMessages["home.suggestionPrompt.one"]);
  });

  it("prioritizes the legal diagnosis over literature review while keeping three prompts", async () => {
    await render(legalScenarios);
    expect(container.querySelector(".home-scenario-cards")).toBeNull();
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".home-prompt-suggestions button")];
    expect(buttons.map((button) => button.textContent)).toEqual([
      zhCNMessages["home.suggestion.legalDiagnosis"],
      zhCNMessages["home.suggestion.two"],
      zhCNMessages["home.suggestion.three"]
    ]);
    await act(async () => buttons[0]?.click());
    expect(onSend).toHaveBeenCalledWith("生成诊断报告");
  });

  it("disables direct sending while the agent is unavailable", async () => {
    await render(legalScenarios, true);
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".home-prompt-suggestions button")];
    expect(buttons).toHaveLength(3);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    await act(async () => buttons[0]?.click());
    expect(onSend).not.toHaveBeenCalled();
  });
});
