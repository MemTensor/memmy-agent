import { describe, expect, it } from "vitest";
import { createBuiltinAgentSourceRegistry } from "../builtin-agent-source-registry.js";

describe("built-in agent source registry", () => {
  it("keeps every built-in source available to both the main service and scan worker", () => {
    const registry = createBuiltinAgentSourceRegistry();

    expect(registry.list().map((adapter) => adapter.descriptor.sourceId)).toEqual([
      "cursor",
      "claude_code",
      "codex",
      "opencode",
      "openclaw",
      "hermes",
      "workbuddy",
      "pi",
      "qwenwork"
    ]);
    expect(registry.require("workbuddy").descriptor.displayName).toBe("WorkBuddy");
    expect(registry.require("pi").descriptor.displayName).toBe("Pi");
    expect(registry.require("qwenwork").descriptor.displayName).toBe("qwenwork");
  });
});
