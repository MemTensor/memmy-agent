import { describe, expect, it } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";

describe("sanitize persisted blocks truncate-text regression", () => {
  it("uses shouldTruncateText without shadowing the truncate helper", () => {
    const dummy = Object.create(AgentLoop.prototype) as AgentLoop;
    (dummy as any).maxToolResultChars = 5;
    const content = [{ type: "text", text: "0123456789" }];

    const out = dummy.sanitizePersistedBlocks(content, { shouldTruncateText: true });

    expect(Array.isArray(out)).toBe(true);
    expect(out[0].type).toBe("text");
    expect(typeof out[0].text).toBe("string");
    expect(out[0].text).not.toBe(content[0].text);
  });
});
