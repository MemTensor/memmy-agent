import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityEvent } from "@memmy/local-api-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { buildPluginSandboxLaunch, createCommandPluginAdapter } from "../command-adapter.js";
import type { PluginRuntimeContext } from "../types.js";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function context(outputMode: "json" | "ndjson" = "json"): PluginRuntimeContext {
  root = mkdtempSync(join(tmpdir(), "memmy-command-plugin-"));
  mkdirSync(join(root, "runtime"));
  writeFileSync(join(root, "runtime/plugin"), "test");
  chmodSync(join(root, "runtime/plugin"), 0o755);
  const now = new Date().toISOString();
  return {
    plugin: {
      id: "com.example.command",
      version: "1.0.0",
      manifest: {
        apiVersion: "memmy/v1",
        id: "com.example.command",
        name: "Command",
        version: "1.0.0",
        runtime: { adapter: "command", config: { command: "runtime/plugin", outputMode } },
        capabilities: [{
          id: "run",
          name: "Run",
          description: "Run command",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          execution: "request"
        }],
        permissions: []
      },
      state: "active",
      approvedPermissions: [],
      config: {},
      artifactHash: "hash",
      rootPath: root,
      lastError: null,
      createdAt: now,
      updatedAt: now
    },
    config: {},
    secrets: {},
    rootPath: root
  };
}

async function collect(iterable: AsyncIterable<CapabilityEvent>): Promise<CapabilityEvent[]> {
  const events: CapabilityEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("CommandPluginAdapter", () => {
  it.runIf(process.platform === "darwin" && process.env.CODEX_SANDBOX !== "seatbelt")(
    "executes an artifact command through the macOS sandbox",
    async () => {
    const pluginContext = context();
    writeFileSync(join(root!, "runtime/plugin"), "#!/bin/sh\nprintf '{\"ok\":true}\\n'\n");
    chmodSync(join(root!, "runtime/plugin"), 0o755);
    const adapter = createCommandPluginAdapter();
    const session = await adapter.activate(pluginContext);
    expect(await collect(adapter.invoke(session, {
      callId: "call-1",
      pluginId: pluginContext.plugin.id,
      capabilityId: "run",
      conversationId: "conversation-1",
      input: {}
    }))).toEqual([{ type: "result", output: { ok: true } }]);
    }
  );

  it("maps a sandboxed command JSON response", async () => {
    const adapter = createCommandPluginAdapter({
      buildLaunch: async (_context, config) => ({
        command: process.execPath,
        args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ok:true})))", ...config.args],
        cwd: root!
      })
    });
    const pluginContext = context();
    const session = await adapter.activate(pluginContext);
    expect(await collect(adapter.invoke(session, {
      callId: "call-1",
      pluginId: pluginContext.plugin.id,
      capabilityId: "run",
      conversationId: "conversation-1",
      input: { topic: "memory" }
    }))).toEqual([{ type: "result", output: { ok: true } }]);
  });

  it("streams NDJSON events", async () => {
    const adapter = createCommandPluginAdapter({
      buildLaunch: async (_context, config) => ({
        command: process.execPath,
        args: ["-e", `console.log(JSON.stringify({type:'progress',current:1,total:1})); console.log(JSON.stringify({type:'result',output:{ok:true}}))`, ...config.args],
        cwd: root!
      })
    });
    const pluginContext = context("ndjson");
    const session = await adapter.activate(pluginContext);
    expect(await collect(adapter.invoke(session, {
      callId: "call-1",
      pluginId: pluginContext.plugin.id,
      capabilityId: "run",
      conversationId: "conversation-1",
      input: {}
    }))).toEqual([
      { type: "progress", current: 1, total: 1 },
      { type: "result", output: { ok: true } }
    ]);
  });

  it("allows only command-plugin network hosts approved by the host policy", async () => {
    const pluginContext = context();
    pluginContext.plugin.manifest.permissions = [{ type: "network", hosts: ["example.com"] }];
    await expect(createCommandPluginAdapter().activate(pluginContext)).rejects.toThrow(/not in the host allowlist/);
    let networkEnabled = false;
    const adapter = createCommandPluginAdapter({
      allowedNetworkHosts: ["example.com"],
      buildLaunch: async (_context, _config, enabled) => {
        networkEnabled = enabled;
        return { command: process.execPath, args: [], cwd: root! };
      }
    });
    await expect(adapter.activate(pluginContext)).resolves.toBeDefined();
    expect(networkEnabled).toBe(true);
  });

  it("rejects commands outside the artifact", async () => {
    const pluginContext = context();
    pluginContext.plugin.manifest.permissions = [];
    pluginContext.plugin.manifest.runtime.config = { command: "../outside" };
    await expect(createCommandPluginAdapter().activate(pluginContext)).rejects.toThrow(/relative/);
  });

  it("runs non-executable JavaScript artifacts with the host Node interpreter", async () => {
    const pluginContext = context();
    chmodSync(join(root!, "runtime/plugin"), 0o644);
    const launch = await buildPluginSandboxLaunch(pluginContext, {
      command: "runtime/plugin",
      interpreter: "node",
      args: ["--flag"],
      cwd: "."
    }, "darwin");
    const separator = launch.args.indexOf("--");
    expect(launch.args[separator + 1]).toBe(realpathSync(process.execPath));
    expect(launch.args.slice(separator + 2)).toEqual([realpathSync(join(root!, "runtime/plugin")), "--flag"]);
  });
});
