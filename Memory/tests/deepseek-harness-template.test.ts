import { describe, expect, it } from "vitest";
import { DEEPSEEK_HARNESS_PLUGIN_INDEX } from "../src/agent-source/integration/templates/memmy-deepseek-harness-plugin.js";

describe("DeepSeek Harness plugin template", () => {
  it("marks recalled context as Memmy memory", () => {
    expect(DEEPSEEK_HARNESS_PLUGIN_INDEX).toContain(
      'source: { kind: "memmy-memory", form: "recall" }'
    );
    expect(DEEPSEEK_HARNESS_PLUGIN_INDEX).not.toContain(
      'source: { kind: "plugin", plugin: name, form: "recall" }'
    );
  });
});
