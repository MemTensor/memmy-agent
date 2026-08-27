import { describe, expect, it } from "vitest";
import { runtimeLines, sessionExtra } from "../../../src/entrypoints/frontend-bridge/mcp-presets-runtime.js";

function message() {
  return {
    content: "use @browserbase",
    metadata: {
      mcp_presets: [
        {
          name: "browserbase",
          display_name: "Browserbase",
          transport: "streamableHttp",
        },
      ],
    },
  };
}

describe("mcp preset runtime annotations", () => {
  it("describes the MCP tool prefix", () => {
    const lines = runtimeLines(message(), {
      configuredServerNames: new Set(["browserbase"]),
      connectedServerNames: new Set(["browserbase"]),
    });

    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("@browserbase");
    expect(lines[0]).toContain("mcp_browserbase_");
    expect(lines[0]).toContain("shell commands");
  });

  it("warns when the gateway has not loaded the latest MCP settings", () => {
    const lines = runtimeLines(message(), {
      configuredServerNames: new Set(),
      connectedServerNames: new Set(),
    });

    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("has not loaded the latest MCP settings");
  });

  it("warns when the MCP connection is not live", () => {
    const lines = runtimeLines(message(), {
      configuredServerNames: new Set(["browserbase"]),
      connectedServerNames: new Set(),
    });

    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("connection is not currently live");
  });

  it("persists only structured MCP preset mentions", () => {
    expect(sessionExtra({})).toEqual({});
    expect(sessionExtra({ mcp_presets: [{ name: "browserbase" }] })).toEqual({
      mcp_presets: [{ name: "browserbase" }],
    });
  });
});
