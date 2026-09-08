import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityEvent } from "@memmy/local-api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPluginSandboxLaunch,
  createCommandPluginAdapter,
  resolveCommandRuntimeDependencies,
  resolvePluginEnvironment
} from "../command-adapter.js";
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
        args: ["-e", "let body=''; process.stdin.on('data', chunk => body += chunk); process.stdin.on('end', () => { const call=JSON.parse(body); console.log(JSON.stringify({pluginId:call.pluginId,input:call.input})); })", ...config.args],
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
    }))).toEqual([{ type: "result", output: { pluginId: "com.example.command", input: { topic: "memory" } } }]);
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

  it("brokers approved Host-service requests over the private NDJSON channel", async () => {
    const adapter = createCommandPluginAdapter({
      hostServices: { invoke: async (call) => ({ content: `model:${call.conversationId}` }) },
      buildLaunch: async (_context, config) => ({
        command: process.execPath,
        args: ["-e", `
          const rl=require('node:readline').createInterface({input:process.stdin});
          let first=true;
          rl.on('line', line => {
            const value=JSON.parse(line);
            if(first){ first=false; console.log(JSON.stringify({type:'host-service-request',requestId:'model-1',service:'model-inference',input:{messages:[{role:'user',content:'hello'}]}})); }
            else { console.log(JSON.stringify({type:'result',output:{host:value.response}})); process.exit(0); }
          });
        `, ...config.args],
        cwd: root!
      })
    });
    const pluginContext = context("ndjson");
    pluginContext.plugin.manifest.runtime.config = { ...pluginContext.plugin.manifest.runtime.config, interactive: true };
    const permission = { type: "host-service" as const, services: ["model-inference"] };
    pluginContext.plugin.manifest.permissions = [permission];
    pluginContext.plugin.approvedPermissions = [permission];
    const session = await adapter.activate(pluginContext);
    expect(await collect(adapter.invoke(session, {
      callId: "call-1", pluginId: pluginContext.plugin.id, capabilityId: "run", conversationId: "conversation-1", input: {}
    }))).toEqual([{ type: "result", output: { host: { content: "model:conversation-1" } } }]);
  });

  it("denies unapproved Host-service requests without invoking the service", async () => {
    const invoke = vi.fn();
    const adapter = createCommandPluginAdapter({
      hostServices: { invoke },
      buildLaunch: async () => ({
        command: process.execPath,
        args: ["-e", `
          const rl=require('node:readline').createInterface({input:process.stdin}); let first=true;
          rl.on('line', line => { const value=JSON.parse(line); if(first){ first=false; console.log(JSON.stringify({type:'host-service-request',requestId:'model-1',service:'model-inference',input:{}})); } else { console.log(JSON.stringify({type:'result',output:value.error})); process.exit(0); } });
        `], cwd: root!
      })
    });
    const pluginContext = context("ndjson");
    pluginContext.plugin.manifest.runtime.config = { ...pluginContext.plugin.manifest.runtime.config, interactive: true };
    const session = await adapter.activate(pluginContext);
    expect(await collect(adapter.invoke(session, { callId: "call-1", pluginId: pluginContext.plugin.id, capabilityId: "run", conversationId: "conversation-1", input: {} }))).toEqual([
      { type: "result", output: { code: "plugin_permission_denied", message: "Host service permission was not approved: model-inference", retryable: false } }
    ]);
    expect(invoke).not.toHaveBeenCalled();
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

  it("prepends only Host-resolved runtime paths to the plugin environment", () => {
    expect(resolvePluginEnvironment({ TEXMFHOME: "/plugin/path" }, {}, {}, ["/trusted/tex/bin"], { TEXMFHOME: "/trusted/texmf" })).toMatchObject({
      PATH: "/trusted/tex/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      TEXMFHOME: "/trusted/texmf"
    });
  });

  it("grants declared TeX Live dependencies read and executable sandbox access on macOS", async () => {
    const dependency = await resolveCommandRuntimeDependencies(["texlive"], "darwin");
    if (dependency.pathEntries.length === 0) return;
    const pluginContext = context();
    const launch = await buildPluginSandboxLaunch(
      pluginContext,
      { command: "runtime/plugin", interpreter: "node", args: [], cwd: "." },
      "darwin",
      false,
      [],
      undefined,
      dependency.readRoots,
      dependency.executableRoots
    );
    const profile = launch.args[1] ?? "";
    expect(dependency.pathEntries[0]).toMatch(/texlive/u);
    expect(dependency.environment.TEXMFHOME).toMatch(/texmf/u);
    expect(profile).toContain(`(allow file-read*`);
    expect(profile).toContain(`(subpath ${JSON.stringify(dependency.readRoots[0])})`);
    expect(profile).toContain(`(subpath ${JSON.stringify(dependency.executableRoots[0])})`);
  });
});
