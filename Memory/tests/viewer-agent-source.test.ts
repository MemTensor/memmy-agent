import { describe, expect, it } from "vitest";
import {
  normalizeAgentSource,
  mergeAgentSourceOptions,
  sourceAgentInitials,
  sourceAgentLabel,
} from "../viewer/src/components/agent-source.js";

describe("Viewer Agent source labels", () => {
  it("uses the same display names as Memmy", () => {
    expect(sourceAgentLabel("hermes")).toBe("Hermes");
    expect(sourceAgentLabel("OPENCLAW")).toBe("OpenClaw");
    expect(sourceAgentLabel("memmy-agent")).toBe("Memmy");
    expect(sourceAgentLabel("computer_history")).toBe("Memmy");
  });

  it("normalizes source ids and creates initials for custom Agents", () => {
    expect(normalizeAgentSource("Claude-Code")).toBe("claude_code");
    expect(sourceAgentInitials("Kimi Code")).toBe("KC");
    expect(sourceAgentInitials("Qoder")).toBe("Q");
  });

  it("includes discovered custom Agents in search options", () => {
    const options = mergeAgentSourceOptions(
      [{ source: "hermes", count: 3 }, { source: "memmy", count: 2 }, { source: "computer_history", count: 1 }],
      [
        { sourceId: "hermes", displayName: "Hermes", builtin: true, available: true },
        { sourceId: "manual-kimi", displayName: "Kimi Code", builtin: false, available: true },
        { sourceId: "cursor", displayName: "Cursor", builtin: true, available: false },
      ],
    );
    expect(options).toEqual(expect.arrayContaining([
      { source: "hermes", count: 3, label: "Hermes" },
      { source: "manual_kimi", count: 0, label: "Kimi Code" },
      { source: "memmy_agent", count: 3, label: "Memmy" },
      { source: "cursor", count: 0, label: "Cursor" },
      { source: "opencode", count: 0, label: "OpenCode" },
    ]));
    expect(options.filter((option) => option.label === "Memmy")).toHaveLength(1);
    expect(options.some((option) => option.source === "computer_history")).toBe(false);
  });
});
