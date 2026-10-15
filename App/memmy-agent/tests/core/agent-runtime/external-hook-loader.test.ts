import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Config } from "../../../src/config/schema.js";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { loadExternalAgentHooks } from "../../../src/core/agent-runtime/external-hook-loader.js";

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("external agent hook loader", () => {
  it("loads configured hook factories without host arguments", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-agent-hook-"));
    roots.push(root);
    const pluginPath = path.join(root, "plugin.mjs");
    fs.writeFileSync(pluginPath, [
      "export default async (...args) => ({",
      "  argsLength: args.length,",
      "  reraise: true,",
      "  async beforeIteration() {},",
      "});",
    ].join("\n"));

    const hooks = await loadExternalAgentHooks([pathToFileURL(pluginPath).href]);

    expect(hooks).toHaveLength(1);
    expect((hooks[0] as unknown as { argsLength: number }).argsLength).toBe(0);
    expect(hooks[0]?.reraise).toBe(false);
  });

  it("skips modules without a default hook factory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-agent-hook-"));
    roots.push(root);
    const pluginPath = path.join(root, "plugin.mjs");
    fs.writeFileSync(pluginPath, "export const value = 1;\n");
    await expect(loadExternalAgentHooks([pathToFileURL(pluginPath).href])).resolves.toEqual([]);
  });

  it("continues loading after a module fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-agent-hook-"));
    roots.push(root);
    const firstPluginPath = path.join(root, "first-plugin.mjs");
    const invalidPluginPath = path.join(root, "invalid-plugin.mjs");
    const lastPluginPath = path.join(root, "last-plugin.mjs");
    fs.writeFileSync(firstPluginPath, [
      "export default () => ({",
      '  id: "first",',
      "});",
    ].join("\n"));
    fs.writeFileSync(invalidPluginPath, "export const value = 1;\n");
    fs.writeFileSync(lastPluginPath, 'export default () => ({ id: "last" });\n');

    const hooks = await loadExternalAgentHooks([
      pathToFileURL(firstPluginPath).href,
      pathToFileURL(invalidPluginPath).href,
      lastPluginPath,
    ]);

    expect(hooks.map((hook) => (hook as unknown as { id: string }).id)).toEqual(["first", "last"]);
  });

  it("rejects relative and home-relative specifiers without failing the batch", async () => {
    await expect(loadExternalAgentHooks(["./plugin.mjs", "../plugin.mjs", "~/plugin.mjs"]))
      .resolves.toEqual([]);
  });

  it("rejects URL protocols other than file", async () => {
    await expect(loadExternalAgentHooks([
      "data:text/javascript,export default () => ({})",
      "node:fs",
    ])).resolves.toEqual([]);
  });

  it("times out hook initialization without blocking the batch", async () => {
    vi.useFakeTimers();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-agent-hook-"));
    roots.push(root);
    const pluginPath = path.join(root, "plugin.mjs");
    fs.writeFileSync(pluginPath, "export default () => new Promise(() => {});\n");

    const loading = loadExternalAgentHooks([pathToFileURL(pluginPath).href]);
    await vi.advanceTimersByTimeAsync(600_000);

    await expect(loading).resolves.toEqual([]);
  });

  it("loads once and shuts down once through AgentLoop runtime lifecycle", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-agent-hook-"));
    roots.push(root);
    const pluginPath = path.join(root, "plugin.mjs");
    const counterKey = `__memmyHookShutdown_${Date.now()}_${Math.random()}`;
    (globalThis as any)[counterKey] = 0;
    fs.writeFileSync(pluginPath, [
      "export default () => ({",
      '  id: "external",',
      `  async shutdown() { globalThis[${JSON.stringify(counterKey)}] += 1; },`,
      "});",
    ].join("\n"));
    const loop = new AgentLoop({
      config: new Config({
        agentHooks: [pathToFileURL(pluginPath).href],
        agents: { defaults: { workspace: root } },
      }),
      workspace: root,
      provider: { getDefaultModel: () => "test", generation: { maxTokens: 1024 } } as any,
    });

    await (loop as any).ensureExternalHooksLoaded();
    await (loop as any).ensureExternalHooksLoaded();
    expect(loop.extraHooks.filter((hook: any) => hook.id === "external")).toHaveLength(1);

    await (loop as any).shutdownExternalHooks();
    await (loop as any).shutdownExternalHooks();
    expect((globalThis as any)[counterKey]).toBe(1);
    delete (globalThis as any)[counterKey];
  });
});
