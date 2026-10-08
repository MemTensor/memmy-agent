import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDeepseekHarnessPluginPackageManifest,
  DEEPSEEK_HARNESS_PLUGIN_INDEX
} from "../src/agent-source/integration/templates/memmy-deepseek-harness-plugin.js";

describe("DeepSeek Harness plugin compatibility", () => {
  it("marks recalled context as Memmy memory", () => {
    expect(DEEPSEEK_HARNESS_PLUGIN_INDEX).toContain(
      'source: { kind: "memmy-memory", form: "recall" }'
    );
    expect(DEEPSEEK_HARNESS_PLUGIN_INDEX).not.toContain(
      'source: { kind: "plugin", plugin: name, form: "recall" }'
    );
  });

  it("writes a package identity accepted by DSH request inventory", () => {
    expect(createDeepseekHarnessPluginPackageManifest()).toMatchObject({
      name: "@memmy/memmy-memory",
      version: "1.0.0",
      type: "module"
    });
  });

  it.each([
    "dsh-v0.1.7-rc.2",
    "dsh-v0.2.0-rc.2",
    "dsh-v0.2.1-alpha.1"
  ])("keeps the shared %s lifecycle envelope", (tag) => {
    expect(DEEPSEEK_HARNESS_PLUGIN_INDEX).toContain("userQuery(payload.messages)");
    expect(DEEPSEEK_HARNESS_PLUGIN_INDEX).toContain('event.type === "assistant/message"');
    expect(tag).toMatch(/^dsh-v0\.(1\.7|2\.0|2\.1)-/);
  });

  it("keeps the standalone dsh adapter on the same current event envelope", () => {
    const adapter = readFileSync(
      resolve(import.meta.dirname, "../adapters/dsh/index.js"),
      "utf8"
    );
    expect(adapter).toContain("const query = userQuery(payload);");
    expect(adapter).toContain("function agentSessionKey(agent)");
    expect(adapter).toContain("turns.set(agentSessionKey(agent)");
    expect(adapter).toContain('event?.type !== "assistant/message"');
    expect(adapter).toContain('source: { kind: "memmy-memory", form: "recall" }');
  });
});
