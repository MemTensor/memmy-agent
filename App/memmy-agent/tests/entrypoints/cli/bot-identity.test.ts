import { describe, expect, it } from "vitest";
import { AgentDefaults, Config } from "../../../src/config/schema.js";
import { findModelInfo, formatTokenCount, getAllModels, getModelContextLimit, getModelSuggestions } from "../../../src/entrypoints/cli/models.js";
import { StreamRenderer, ThinkingSpinner } from "../../../src/entrypoints/cli/stream.js";

describe("CLI bot identity", () => {
  it("preserves default bot name and icon", () => {
    const defaults = new AgentDefaults();

    expect(defaults.botName).toBe("memmy");
    expect(defaults.botIcon).toBe("🍚");
  });

  it("can override bot name and icon from config", () => {
    const config = Config.fromObject({ agents: { defaults: { botName: "mybot", botIcon: "🤖" } } });

    expect(config.agents.defaults.botName).toBe("mybot");
    expect(config.agents.defaults.botIcon).toBe("🤖");
  });

  it("accepts an empty bot icon", () => {
    const config = Config.fromObject({ agents: { defaults: { botIcon: "" } } });

    expect(config.agents.defaults.botIcon).toBe("");
  });

  it("propagates bot name to spinner status text", () => {
    const spinner = new ThinkingSpinner({ botName: "mybot" });

    expect(spinner.spinner.status).toContain("mybot is thinking...");
  });

  it("stores renderer bot name and icon", () => {
    const renderer = new StreamRenderer({ showSpinner: false, botName: "mybot", botIcon: "🤖" });

    expect(renderer.botName).toBe("mybot");
    expect(renderer.botIcon).toBe("🤖");
  });

  it("builds a header without leading space when icon is empty", () => {
    const renderer = new StreamRenderer({ showSpinner: false, botName: "mybot", botIcon: "" });
    const header = renderer.botIcon ? `${renderer.botIcon} ${renderer.botName}` : renderer.botName;

    expect(header).toBe("mybot");
  });

  it("keeps onboard model database helper signatures stable while suggestions are disabled", () => {
    expect(getAllModels()).toEqual([]);
    expect(findModelInfo("openai/gpt")).toBeNull();
    expect(getModelContextLimit("openai/gpt", "openai")).toBeNull();
    expect(getModelSuggestions("gpt", "openai", 5)).toEqual([]);
    expect(formatTokenCount(200000)).toBe("200,000");
  });
});
