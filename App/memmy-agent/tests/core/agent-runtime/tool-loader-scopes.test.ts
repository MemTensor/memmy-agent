import { describe, expect, it } from "vitest";
import { ToolLoader } from "../../../src/core/agent-runtime/tools/loader.js";

describe("ToolLoader scopes", () => {
  it("loads a smaller subagent registry without orchestration-only tools", () => {
    const registry = new ToolLoader({ workspace: "/tmp/memmy-tool-loader-scopes" }).loadRegistry(null, { scope: "subagent" });

    expect(registry.toolNames).toEqual(expect.arrayContaining(["read_file", "edit_file"]));
    expect(registry.toolNames).not.toContain("spawn");
  });
});
