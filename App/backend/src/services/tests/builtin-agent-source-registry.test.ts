import { describe, expect, it } from "vitest";
import { createBuiltinAgentSourceRegistry } from "../builtin-agent-source-registry.js";

describe("built-in agent source registry", () => {
  it("keeps WorkBuddy available to both the main service and scan worker", () => {
    const registry = createBuiltinAgentSourceRegistry();

    expect(registry.list().map((adapter) => adapter.descriptor.sourceId)).toEqual([
      "cursor",
      "claude_code",
      "codex",
      "opencode",
      "openclaw",
      "hermes",
      "workbuddy"
    ]);
    expect(registry.require("workbuddy").descriptor.displayName).toBe("WorkBuddy");
  });
});
