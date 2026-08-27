import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatModelSelector } from "../home-page.js";

describe("ChatModelSelector", () => {
  it("Agent selector uses catalog Agent candidates and Agent-state preset selection only", () => {
    const source = readFileSync(resolve(__dirname, "..", "..", "components", "agent-model-selector.tsx"), "utf8");

    expect(source).toContain("getTaskModelCandidates(workspace, props.mode)");
    expect(source).toContain("pendingPresetByScope");
    expect(source).toContain("committedModelSelectionByScope");
    expect(source).toContain("agentActions.pendingModelPresetUpdated");
    expect(source).toContain("if (resolved.unavailable && resolved.candidateId)");
    expect(source).toContain('value={resolved.candidateId ?? ""}');
    expect(source).not.toContain("!hasNoModels && resolved.unavailable");
    expect(source).not.toContain("useModelWorkspace");
    expect(source).not.toContain("localStorage");
  });

  it("uses provider logos with model-only labels and omits unavailable presets", () => {
    const html = renderToString(
      <ChatModelSelector
        presets={[
          { name: "default", provider: "openai", model: "gpt-5.4", is_default: true, available: true },
          { name: "offline", provider: "local", model: "missing", is_default: false, available: false }
        ]}
        value="default"
        disabled={false}
        label="选择模型"
        onChange={() => undefined}
      />
    );

    expect(html).toContain("select-control--placement-top");
    expect(html).toContain("chat-model-select");
    expect(html).toContain('aria-label="选择模型"');
    expect(html).toContain("llm-provider-logo");
    expect(html).toContain("data:image/svg+xml");
    expect(html).toContain("OpenAI");
    expect(html).toContain(">gpt-5.4<");
    expect(html).not.toContain("openai / gpt-5.4");
    expect(html).not.toContain("missing");
  });

  it("sizes every provider icon to the following model label line height", () => {
    const styles = readFileSync(resolve(__dirname, "..", "..", "styles.css"), "utf8");
    const iconStyles = styles.slice(
      styles.indexOf(".chat-model-select .select-control__option-icon"),
      styles.indexOf(".chat-model-select .select-control__option:hover")
    );

    expect(iconStyles).toContain("width: 1.25em;");
    expect(iconStyles).toContain("height: 1.25em;");
    expect(iconStyles).toContain("flex-basis: 1.25em;");
    expect(iconStyles).toContain(".llm-provider-logo[data-provider=\"memmy_account\"]");
    expect(iconStyles).toContain("transform: scale(1.133);");
  });
});
