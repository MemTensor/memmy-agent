import { describe, expect, it } from "vitest";
import { Config, ValueError } from "../../src/config/schema.js";

describe("agentHooks config", () => {
  it("defaults to an empty list and round-trips configured specifiers", () => {
    expect(new Config().agentHooks).toEqual([]);

    const config = new Config({
      agentHooks: ["@memmy/example-hook", "file:///opt/memmy/example-hook.js"],
    });

    expect(config.toObject().agentHooks).toEqual([
      "@memmy/example-hook",
      "file:///opt/memmy/example-hook.js",
    ]);
  });

  it("rejects non-string entries", () => {
    expect(() => new Config({ agentHooks: ["valid", 42] })).toThrow(ValueError);
  });
});
