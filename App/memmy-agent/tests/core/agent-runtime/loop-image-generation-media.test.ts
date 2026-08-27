import { describe, expect, it } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";

describe("AgentLoop media persistence", () => {
  it("replaces persisted image data URLs with readable placeholders", () => {
    const loop = new AgentLoop({ provider: { generation: {}, getDefaultModel: () => "m" }, workspace: "/tmp/memmy-loop-media" });
    const blocks = loop.sanitizePersistedBlocks([
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" }, meta: { path: "/tmp/a.png" } },
    ]);

    expect(blocks).toEqual([{ type: "text", text: "[image: /tmp/a.png]" }]);
  });
});
