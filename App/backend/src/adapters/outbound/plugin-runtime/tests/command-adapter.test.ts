import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityEvent } from "@memmy/local-api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPluginSandboxLaunch,
  createCommandPluginAdapter,
  resolveCommandRuntimeDependencies,
  resolvePluginEnvironment,
  selectOfficeCjkFontFiles
} from "../command-adapter.js";
import type { PluginRuntimeContext } from "../types.js";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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
    "limits macOS renderer services to Host-provisioned Office while preserving file and network boundaries", async () => {
      const data = realpathSync(mkdtempSync("/private/tmp/memmy-office-mach-"));
      const sentinel = join(data, "host-only.txt");
      writeFileSync(sentinel, "owned boundary fixture\n");
      const unix = createServer(socket => socket.end());
      const tcp = createServer(socket => socket.end());
      await new Promise<void>(ok => unix.listen(join(data, "host.sock"), ok));
      await new Promise<void>(ok => tcp.listen(0, "127.0.0.1", ok));
      try {
        const baseContext = context();
        const executable = join(root!, "runtime/plugin");
        execFileSync("/usr/bin/clang", ["-x", "c", "-o", executable, "-"], { input: String.raw`
          #include <sys/socket.h>
          #include <sys/un.h>
          #include <netinet/in.h>
          #include <mach/mach.h>
          #include <servers/bootstrap.h>
          #include <unistd.h>
          #include <stdio.h>
          #include <stdlib.h>
          #include <string.h>
          #include <errno.h>
          static int lookup(const char *name) {
            mach_port_t port = MACH_PORT_NULL;
            kern_return_t result = bootstrap_look_up(bootstrap_port, name, &port);
            if (result != KERN_SUCCESS || port == MACH_PORT_NULL) return 0;
            mach_port_deallocate(mach_task_self(), port);
            return 1;
          }
          int main(int argc, char **argv) {
            if (argc != 5 || chdir(argv[1]) != 0) return 2;
            int launch = lookup("com.apple.coreservices.launchservicesd");
            int window = lookup("com.apple.windowserver.active");
            struct sockaddr_un own = {0}; own.sun_family = AF_UNIX; strcpy(own.sun_path, "inside.sock");
            int a = socket(AF_UNIX, SOCK_STREAM, 0);
            int bound = bind(a, (struct sockaddr *)&own, sizeof(own)) == 0;
            struct sockaddr_un other = {0}; other.sun_family = AF_UNIX; strcpy(other.sun_path, argv[2]);
            int b = socket(AF_UNIX, SOCK_STREAM, 0);
            int external = connect(b, (struct sockaddr *)&other, sizeof(other)) == 0;
            struct sockaddr_in remote = {0}; remote.sin_family = AF_INET;
            remote.sin_addr.s_addr = htonl(0x7f000001); remote.sin_port = htons((unsigned short)atoi(argv[4]));
            int c = socket(AF_INET, SOCK_STREAM, 0);
            int network = connect(c, (struct sockaddr *)&remote, sizeof(remote)) == 0;
            errno = 0; FILE *read = fopen(argv[3], "r"); int read_error = errno;
            if (read) fclose(read);
            errno = 0; FILE *write = fopen(argv[3], "a"); int write_error = errno;
            if (write) fclose(write);
            printf("{\"launchServices\":%s,\"windowServer\":%s,\"bound\":%s,\"external\":%s,\"network\":%s,\"readOutside\":%s,\"writeOutside\":%s,\"readErrno\":%d,\"writeErrno\":%d}\n",
              launch ? "true" : "false", window ? "true" : "false", bound ? "true" : "false",
              external ? "true" : "false", network ? "true" : "false", read ? "true" : "false", write ? "true" : "false", read_error, write_error);
            close(a); close(b); close(c); return 0;
          }` });
        const fixtureRoot = realpathSync(root!);
        const tools = Object.fromEntries(["soffice", "pdfinfo", "pdftoppm", "pdftotext"]
          .map(name => [name, realpathSync(executable)]));
        const ensure = vi.fn(async () => ({ root: fixtureRoot, version: "test-renderer", tools }));
        vi.stubEnv("MEMMY_OFFICE_RUNTIME_PREFER_MANAGED", "1");
        const cases = [
          { name: "office", id: "office", provisioned: true, allowed: true },
          { name: "ordinary", id: "com.example.command", provisioned: true, allowed: false },
          { name: "forged-env", id: "office", provisioned: false, allowed: false }
        ];
        for (const testCase of cases) {
          const pluginContext = structuredClone(baseContext);
          pluginContext.plugin.id = testCase.id;
          pluginContext.plugin.manifest.id = testCase.id;
          const permission = { type: "host-service" as const, services: ["plugin-data"] };
          pluginContext.plugin.manifest.permissions = [permission];
          pluginContext.plugin.approvedPermissions = [permission];
          const dataRoot = join(data, testCase.name);
          pluginContext.plugin.manifest.runtime.config = {
            command: "runtime/plugin",
            args: [join(dataRoot, testCase.id), join(data, "host.sock"), sentinel, String((tcp.address() as { port: number }).port)],
            runtimeDependencies: testCase.provisioned ? ["office"] : [],
            env: testCase.provisioned ? {} : { MEMMY_OFFICE_TOOLS: JSON.stringify(tools), MEMMY_OFFICE_RENDERER_RESOLVED: "1" },
            ...(!testCase.provisioned ? { officeRendererResolved: true } : {})
          };
          const adapter = createCommandPluginAdapter({ pluginDataRoot: dataRoot, officeRuntimeInstaller: { ensure } });
          const session = await adapter.activate(pluginContext);
          try {
            const profile = (session as typeof session & { launch: { args: string[] } }).launch.args[1] ?? "";
            const services = [...profile.matchAll(/\(global-name\s+"([^"]+)"\)/gu)].map(match => match[1]);
            expect(services, testCase.name).toEqual(testCase.allowed
              ? ["com.apple.coreservices.launchservicesd", "com.apple.windowserver.active"] : []);
            expect(profile).not.toMatch(/global-name-prefix|local-name|xpc-service-name|system-graphics|\(allow\s+mach-lookup\s*\)/u);
            const events = await collect(adapter.invoke(session, {
              callId: testCase.name, pluginId: testCase.id, capabilityId: "run", conversationId: "test", input: {}
            }));
            expect(events).toHaveLength(1);
            expect(events[0]?.type).toBe("result");
            const output = (events[0] as Extract<CapabilityEvent, { type: "result" }>).output as Record<string, unknown>;
            expect(output, testCase.name).toMatchObject({
              launchServices: testCase.allowed, windowServer: testCase.allowed,
              bound: true, external: false, network: false, readOutside: false, writeOutside: false
            });
            expect([1, 13], `${testCase.name} read errno`).toContain(output.readErrno);
            expect([1, 13], `${testCase.name} write errno`).toContain(output.writeErrno);
          } finally { await adapter.deactivate(session); }
        }
        expect(ensure).toHaveBeenCalledTimes(2);
        expect(readFileSync(sentinel, "utf8")).toBe("owned boundary fixture\n");
      } finally {
        await Promise.all([new Promise<void>(ok => unix.close(() => ok())), new Promise<void>(ok => tcp.close(() => ok()))]);
        rmSync(data, { recursive: true, force: true });
      }
    }, 30000
  );

  it.runIf(process.platform === "darwin" && process.env.CODEX_SANDBOX !== "seatbelt")(
    "allows private plugin IPC while denying sockets outside plugin-data and loopback TCP", async () => {
      const data = realpathSync(mkdtempSync("/private/tmp/memmy-ipc-"));
      const unix = createServer(socket => socket.end());
      const tcp = createServer(socket => socket.end());
      await new Promise<void>(ok => unix.listen(join(data, "host.sock"), ok));
      await new Promise<void>(ok => tcp.listen(0, "127.0.0.1", ok));
      try {
        const pluginContext = context();
        const permission = { type: "host-service" as const, services: ["plugin-data"] };
        pluginContext.plugin.manifest.permissions = [permission];
        pluginContext.plugin.approvedPermissions = [permission];
        execFileSync("/usr/bin/clang", ["-x", "c", "-o", join(root!, "runtime/plugin"), "-"], { input: `
          #include <sys/socket.h>
          #include <sys/un.h>
          #include <netinet/in.h>
          #include <unistd.h>
          #include <stdio.h>
          #include <string.h>
          int main(int argc,char **argv) {
            chdir(argv[1]); struct sockaddr_un own={0}; own.sun_family=AF_UNIX; strcpy(own.sun_path,"inside.sock");
            int a=socket(AF_UNIX,SOCK_STREAM,0); int bound=bind(a,(struct sockaddr*)&own,sizeof(own))==0;
            struct sockaddr_un other={0}; other.sun_family=AF_UNIX; strcpy(other.sun_path,argv[2]);
            int b=socket(AF_UNIX,SOCK_STREAM,0); int external=connect(b,(struct sockaddr*)&other,sizeof(other))==0;
            struct sockaddr_in remote={0}; remote.sin_family=AF_INET; remote.sin_addr.s_addr=htonl(0x7f000001); remote.sin_port=htons(${(tcp.address() as { port: number }).port});
            int c=socket(AF_INET,SOCK_STREAM,0); int network=connect(c,(struct sockaddr*)&remote,sizeof(remote))==0;
            printf("{\\"bound\\":%s,\\"external\\":%s,\\"network\\":%s}\\n",bound?"true":"false",external?"true":"false",network?"true":"false");
            close(a);close(b);close(c);return 0;
          }` });
        pluginContext.plugin.manifest.runtime.config = { command: "runtime/plugin", args: [join(data, pluginContext.plugin.id), join(data, "host.sock")] };
        const adapter = createCommandPluginAdapter({ pluginDataRoot: data });
        const session = await adapter.activate(pluginContext);
        try {
          expect(await collect(adapter.invoke(session, {callId:"ipc",pluginId:pluginContext.plugin.id,capabilityId:"run",conversationId:"test",input:{}})))
            .toEqual([{ type: "result", output: { bound: true, external: false, network: false } }]);
        } finally { await adapter.deactivate(session); }
      } finally {
        await Promise.all([new Promise<void>(ok => unix.close(() => ok())), new Promise<void>(ok => tcp.close(() => ok()))]);
        rmSync(data, { recursive: true, force: true });
      }
    }, 30000
  );
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
    let childEnvironment: Record<string, string> | undefined;
    const adapter = createCommandPluginAdapter({
      spawnFn: ((command, args, options) => {
        childEnvironment = options?.env as Record<string, string>;
        return spawn(command, args, options as Parameters<typeof spawn>[2]) as ReturnType<typeof spawn>;
      }) as typeof spawn,
      buildLaunch: async (_context, config) => ({
        command: process.execPath,
        args: ["-e", "let body=''; process.stdin.on('data', chunk => body += chunk); process.stdin.on('end', () => { const call=JSON.parse(body); console.log(JSON.stringify({pluginId:call.pluginId,input:call.input})); })", ...config.args],
        cwd: root!
      })
    });
    const pluginContext = context();
    pluginContext.plugin.manifest.runtime.config = {
      ...pluginContext.plugin.manifest.runtime.config,
      interpreter: "node"
    };
    const session = await adapter.activate(pluginContext);
    expect(await collect(adapter.invoke(session, {
      callId: "call-1",
      pluginId: pluginContext.plugin.id,
      capabilityId: "run",
      conversationId: "conversation-1",
      input: { topic: "memory" }
    }))).toEqual([{ type: "result", output: { pluginId: "com.example.command", input: { topic: "memory" } } }]);
    expect(childEnvironment?.ELECTRON_RUN_AS_NODE).toBe("1");
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

  it("does not consume the command timeout while an interaction waits for the user", async () => {
    const adapter = createCommandPluginAdapter({
      buildLaunch: async (_context, config) => ({
        command: process.execPath,
        args: ["-e", `
          const rl=require('node:readline').createInterface({input:process.stdin});
          let first=true;
          rl.on('line', line => {
            const value=JSON.parse(line);
            if(first){
              first=false;
              console.log(JSON.stringify({type:'interaction',request:{interactionId:'review-card',type:'custom',payload:{}}}));
            } else {
              console.log(JSON.stringify({type:'result',output:{response:value.response}}));
              process.exit(0);
            }
          });
        `, ...config.args],
        cwd: root!
      })
    });
    const pluginContext = context("ndjson");
    pluginContext.plugin.manifest.runtime.config = {
      ...pluginContext.plugin.manifest.runtime.config,
      interactive: true,
      timeoutMs: 2000
    };
    const session = await adapter.activate(pluginContext);
    const iterator = adapter.invoke(session, {
      callId: "call-interaction",
      pluginId: pluginContext.plugin.id,
      capabilityId: "run",
      conversationId: "conversation-1",
      input: {}
    })[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toMatchObject({
      type: "interaction",
      request: { interactionId: "review-card" }
    });
    await new Promise((resolve) => setTimeout(resolve, 2100));
    await adapter.respond?.(session, "call-interaction", "review-card", { confirmed: true });
    expect((await iterator.next()).value).toEqual({ type: "result", output: { response: { confirmed: true } } });
    expect((await iterator.next()).done).toBe(true);
  });

  it("brokers approved Host-service requests over the private NDJSON channel", async () => {
    const adapter = createCommandPluginAdapter({
      hostServices: { invoke: async (call) => ({ content: `model:${call.conversationId}:${call.modelPreset}` }) },
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
      callId: "call-1", pluginId: pluginContext.plugin.id, capabilityId: "run", conversationId: "conversation-1",
      modelPreset: "account-deepseek-v4.1-flash", input: {}
    }))).toEqual([{ type: "result", output: { host: { content: "model:conversation-1:account-deepseek-v4.1-flash" } } }]);
  });

  it("brokers concurrent Host-service requests instead of serialising them", async () => {
    // A capability that fans out — the legal diagnosis judges sections in
    // parallel — gains nothing if the Host answers one request at a time.
    let inFlight = 0;
    let peak = 0;
    const adapter = createCommandPluginAdapter({
      hostServices: {
        invoke: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 30));
          inFlight -= 1;
          return { content: "ok" };
        }
      },
      buildLaunch: async (_context, config) => ({
        command: process.execPath,
        args: ["-e", `
          const rl=require('node:readline').createInterface({input:process.stdin});
          let first=true, answered=0;
          const ids=['a','b','c','d'];
          rl.on('line', line => {
            const value=JSON.parse(line);
            if(first){
              first=false;
              for(const id of ids) console.log(JSON.stringify({type:'host-service-request',requestId:id,service:'model-inference',input:{}}));
            } else if(++answered===ids.length){
              console.log(JSON.stringify({type:'result',output:{answered}}));
              process.exit(0);
            }
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
      callId: "call-parallel", pluginId: pluginContext.plugin.id, capabilityId: "run", conversationId: "conversation-1", input: {}
    }))).toEqual([{ type: "result", output: { answered: 4 } }]);
    // Serial dispatch would peak at one.
    expect(peak).toBeGreaterThan(1);
  });

  it("aborts in-flight Host services when a command-plugin run is cancelled", async () => {
    const started = Promise.withResolvers<void>();
    let hostSignal: AbortSignal | undefined;
    const adapter = createCommandPluginAdapter({
      hostServices: {
        invoke: async (call) => {
          hostSignal = call.signal;
          started.resolve();
          return await new Promise((_resolve, reject) => call.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
        }
      },
      buildLaunch: async (_context, config) => ({
        command: process.execPath,
        args: ["-e", `
          const rl=require('node:readline').createInterface({input:process.stdin}); let first=true;
          rl.on('line', () => { if(first){ first=false; console.log(JSON.stringify({type:'host-service-request',requestId:'model-1',service:'model-inference',input:{}})); } });
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
    const pending = collect(adapter.invoke(session, {
      callId: "call-cancel", pluginId: pluginContext.plugin.id, capabilityId: "run", conversationId: "conversation-1", input: {}
    }));
    await started.promise;
    await adapter.cancel?.(session, "call-cancel");
    expect(hostSignal?.aborted).toBe(true);
    await expect(pending).rejects.toBeDefined();
  });

  it("reports a closed response pipe as a call failure without an uncaught stream error", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const adapter = createCommandPluginAdapter({
      hostServices: { invoke },
      buildLaunch: async () => ({
        command: process.execPath,
        args: ["-e", `
          const fs=require('node:fs');
          fs.readSync(0,Buffer.alloc(65536),0,65536,null);
          fs.closeSync(0);
          // Keep descriptor zero occupied so libuv cannot reuse it for an
          // internal handle (some Node 24 builds assert when closing fd 0).
          fs.openSync(process.platform==='win32'?'NUL':'/dev/null','r');
          console.log(JSON.stringify({type:'host-service-request',requestId:'closed-pipe',service:'model-inference',input:{}}));
          setInterval(() => {}, 1000);
        `], cwd: root!
      })
    });
    const pluginContext = context("ndjson");
    pluginContext.plugin.manifest.runtime.config = { ...pluginContext.plugin.manifest.runtime.config, interactive: true };
    const permission = { type: "host-service" as const, services: ["model-inference"] };
    pluginContext.plugin.manifest.permissions = [permission];
    pluginContext.plugin.approvedPermissions = [permission];
    const session = await adapter.activate(pluginContext);
    try {
      await expect(collect(adapter.invoke(session, {
        callId: "call-closed-pipe", pluginId: pluginContext.plugin.id, capabilityId: "run", conversationId: "conversation-1", input: {}
      }))).rejects.toMatchObject({ code: "EPIPE" });
      expect(invoke).toHaveBeenCalledOnce();
    } finally { await adapter.deactivate(session); }
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

  it("keeps Host CJK font paths reserved after configured and secret environment injection", () => {
    const forged = JSON.stringify(["/untrusted/user-font.ttf"]);
    const trusted = JSON.stringify(["/trusted/system-font.ttc"]);
    const configured = { MEMMY_OFFICE_CJK_FONTS: forged };
    const secretEnv = { MEMMY_OFFICE_CJK_FONTS: "forged-fonts" };
    const secrets = { "forged-fonts": forged };
    expect(resolvePluginEnvironment(configured, secretEnv, secrets, [], { MEMMY_OFFICE_CJK_FONTS: trusted })
      .MEMMY_OFFICE_CJK_FONTS).toBe(trusted);
    expect(resolvePluginEnvironment(configured, secretEnv, secrets).MEMMY_OFFICE_CJK_FONTS).toBe("[]");
  });

  it("includes Host CJK font paths from the verified managed runtime without adding sandbox roots", async () => {
    context(); vi.stubEnv("MEMMY_OFFICE_RUNTIME_PREFER_MANAGED", "1");
    const installed = realpathSync(root!);
    mkdirSync(join(installed, "fonts"));
    const font = join(installed, "fonts", "NotoSansCJKsc-Regular.otf");
    writeFileSync(font, "owned font selection fixture");
    const tools = Object.fromEntries(["soffice", "pdfinfo", "pdftoppm", "pdftotext"].map(name => [name, join(installed, "runtime/plugin")]));
    const ensure = vi.fn(async () => ({ root: installed, version: "test-fonts", tools }));
    const dependencies = await resolveCommandRuntimeDependencies(["office"], "darwin", { ensure });
    expect(dependencies.environment.MEMMY_OFFICE_CJK_FONTS).toBeTypeOf("string");
    expect(JSON.parse(dependencies.environment.MEMMY_OFFICE_CJK_FONTS!)).toContain(realpathSync(font));
    expect(dependencies.readRoots).toEqual([installed]);
    expect(dependencies.executableRoots).toEqual([installed]);
  });

  it("selects only canonical readable Host CJK font files inside the approved source", async () => {
    context();
    const fixture = realpathSync(root!);
    const approved = join(fixture, "approved"); mkdirSync(approved);
    const fonts = join(approved, "fonts"); mkdirSync(fonts);
    const font = join(fonts, "owned.ttf"); writeFileSync(font, "owned font fixture");
    const userFonts = join(fixture, "user", "Library", "Fonts"); mkdirSync(userFonts, { recursive: true });
    writeFileSync(join(userFonts, "User.ttf"), "outside approved roots");
    symlinkSync(userFonts, join(approved, "escaped"), process.platform === "win32" ? "junction" : "dir");
    symlinkSync(fonts, join(approved, "alias"), process.platform === "win32" ? "junction" : "dir");
    mkdirSync(join(approved, "directory.ttf"));
    writeFileSync(join(approved, "empty.ttf"), "");
    writeFileSync(join(approved, "oversized.ttf"), ""); truncateSync(join(approved, "oversized.ttf"), 256 * 1024 * 1024 + 1);
    writeFileSync(join(approved, "not-a-font.txt"), "not a font");
    const candidates = ["fonts/owned.ttf", "alias/owned.ttf", "escaped/User.ttf", "../user/Library/Fonts/User.ttf",
      "directory.ttf", "empty.ttf", "oversized.ttf", "not-a-font.txt", "missing.otf"];
    if (process.platform !== "win32") {
      writeFileSync(join(approved, "unreadable.ttf"), "unreadable", { mode: 0o000 });
      candidates.push("unreadable.ttf");
    }
    expect(await selectOfficeCjkFontFiles([{ root: approved, candidates }])).toEqual([realpathSync(font)]);
    const redirected = join(fixture, "redirected");
    symlinkSync(approved, redirected, process.platform === "win32" ? "junction" : "dir");
    expect(await selectOfficeCjkFontFiles([{ root: redirected, candidates: ["fonts/owned.ttf"] }])).toEqual([]);
    expect(await selectOfficeCjkFontFiles([{ root: approved, candidates: ["missing.ttf"] }])).toEqual([]);
  });

  it("caps Host CJK font candidates at sixteen without adding font directories to sandbox grants", async () => {
    context();
    const approved = realpathSync(root!);
    const candidates = Array.from({ length: 20 }, (_, index) => `font-${index}.ttf`);
    for (const file of candidates) writeFileSync(join(approved, file), "owned font fixture");
    expect(await selectOfficeCjkFontFiles([{ root: approved, candidates }]))
      .toEqual(candidates.slice(0, 16).map(file => realpathSync(join(approved, file))));
    const dependency = await resolveCommandRuntimeDependencies([]);
    expect(dependency.readRoots).toEqual([]);
    expect(resolvePluginEnvironment({}, {}, {}, dependency.pathEntries, dependency.environment).MEMMY_OFFICE_CJK_FONTS).toBe("[]");
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

  it("builds a trusted Windows launcher plan with explicit roots and exact arguments", async () => {
    const pluginContext = context();
    const launch = await buildPluginSandboxLaunch(pluginContext, { command: "runtime/plugin", interpreter: "node", args: ["a b", "中文", 'quote"value'], cwd: "." }, "win32");
    expect(launch.command).toMatch(/powershell\.exe$/);
    const plan = JSON.parse(Buffer.from(launch.args[launch.args.indexOf("-Plan") + 1]!, "base64").toString("utf8"));
    expect(plan.command).toBe(realpathSync(process.execPath));
    expect(plan.args).toEqual(["--preserve-symlinks", "--preserve-symlinks-main", realpathSync(join(root!, "runtime/plugin")), "a b", "中文", 'quote"value']);
    expect(plan.readRoots).toContain(realpathSync(root!)); expect(plan.writeRoots).toEqual([]);
    expect(plan.profile).toMatch(/^memmy\.plugin\.[a-f0-9]{32}$/);
    await expect(buildPluginSandboxLaunch(pluginContext, { command: "runtime/plugin", interpreter: "node", args: [], cwd: "." }, "win32", true)).rejects.toThrow(/no network/);
  });

  it("resolves the default runtime route against the registry origin, including bases with /api", async () => {
    const pluginContext = context();
    vi.stubEnv("MEMMY_PLUGIN_REGISTRY_URL", "http://127.0.0.1:19391/api");
    vi.stubEnv("MEMMY_OFFICE_RUNTIME_PREFER_MANAGED", "1");
    vi.stubEnv("MEMMY_OFFICE_RUNTIME_CATALOG_URL", "");
    delete process.env.MEMMY_OFFICE_RUNTIME_CATALOG_URL;
    const fetchFn = vi.fn(async (_input: unknown) => new Response("not provisioned", { status: 404 })); vi.stubGlobal("fetch", fetchFn);
    pluginContext.plugin.manifest.runtime.config = { ...pluginContext.plugin.manifest.runtime.config, runtimeDependencies: ["office"] };
    await expect(createCommandPluginAdapter({ platform: "win32", pluginDataRoot: join(root!, "plugin-data") }).activate(pluginContext)).rejects.toThrow(/HTTP 404/);
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(`http://127.0.0.1:19391/api/v1/plugins/office/runtimes/win32-${process.arch}`);
  });

  it("automatically resolves the TeX runtime from the literature registry when missing", async () => {
    const pluginContext = context();
    vi.stubEnv("MEMMY_PLUGIN_REGISTRY_URL", "http://127.0.0.1:19391/api");
    vi.stubEnv("MEMMY_TEXLIVE_RUNTIME_PREFER_MANAGED", "1");
    vi.stubEnv("MEMMY_TEXLIVE_RUNTIME_CATALOG_URL", "");
    delete process.env.MEMMY_TEXLIVE_RUNTIME_CATALOG_URL;
    const fetchFn = vi.fn(async (_input: unknown) => new Response("not provisioned", { status: 404 })); vi.stubGlobal("fetch", fetchFn);
    pluginContext.plugin.manifest.runtime.config = { ...pluginContext.plugin.manifest.runtime.config, runtimeDependencies: ["texlive"] };
    await expect(createCommandPluginAdapter({ platform: "win32", pluginDataRoot: join(root!, "plugin-data") }).activate(pluginContext)).rejects.toThrow(/HTTP 404/);
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(`http://127.0.0.1:19391/api/v1/plugins/literature-review/runtimes/win32-${process.arch}`);
  });

  it("keeps plugin CLR/PowerShell variables out of the privileged Windows launcher", async () => {
    const pluginContext = context();
    pluginContext.plugin.manifest.runtime.config = { ...pluginContext.plugin.manifest.runtime.config, interpreter: "node", env: { COR_ENABLE_PROFILING: "1", COR_PROFILER_PATH: "untrusted.dll", PSModulePath: "untrusted-modules", SystemRoot: "untrusted-root", LOCALAPPDATA: "untrusted-profile" } };
    let launcherEnv: Record<string, string> = {};
    const adapter = createCommandPluginAdapter({ platform: "win32", spawnFn: ((command, _args, options) => {
      expect(command).toMatch(/powershell\.exe$/); launcherEnv = options?.env as Record<string, string>;
      return spawn(process.execPath, ["-e", "console.log('{}')"], options as Parameters<typeof spawn>[2]);
    }) as typeof spawn });
    const session = await adapter.activate(pluginContext);
    await collect(adapter.invoke(session, { callId: "env-test", pluginId: pluginContext.plugin.id, capabilityId: "run", conversationId: "test", input: {} }));
    expect(launcherEnv.COR_ENABLE_PROFILING).toBeUndefined(); expect(launcherEnv.COR_PROFILER_PATH).toBeUndefined();
    expect(launcherEnv.PSModulePath).toBe(`${launcherEnv.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\Modules`);
    expect(launcherEnv.SystemRoot).not.toBe("untrusted-root");
    expect(launcherEnv.LOCALAPPDATA).toBeUndefined();
    const isolatedEnv = JSON.parse(Buffer.from(launcherEnv.MEMMY_SANDBOX_CHILD_ENV!, "base64").toString("utf8"));
    expect(isolatedEnv.COR_PROFILER_PATH).toBe("untrusted.dll");
    expect(isolatedEnv.LOCALAPPDATA).toBe("untrusted-profile");
  });

  it.runIf(process.platform === "darwin")("does not authorize macOS services for an unverified Office renderer", async () => {
    context(); vi.stubEnv("MEMMY_OFFICE_RUNTIME_PREFER_MANAGED", "1");
    const installed = join(root!, "installed"); mkdirSync(installed);
    const external = join(root!, "outside-renderer"); writeFileSync(external, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const escaped = join(installed, "escaped-renderer"); symlinkSync(external, escaped);
    const nonExecutable = join(installed, "non-executable"); writeFileSync(nonExecutable, "fixture", { mode: 0o644 });
    const directory = join(installed, "directory"); mkdirSync(directory);
    for (const soffice of [external, escaped, nonExecutable, directory]) {
      const tools = Object.fromEntries(["soffice", "pdfinfo", "pdftoppm", "pdftotext"].map(name => [name, soffice]));
      const ensure = vi.fn(async () => ({ root: installed, version: "unverified", tools }));
      const dependencies = await resolveCommandRuntimeDependencies(["office"], "darwin", { ensure });
      expect(dependencies.officeRendererResolved, soffice).not.toBe(true);
    }
  });

  it("injects only the Host-installed portable Office tools into the runtime", async () => {
    context(); vi.stubEnv("MEMMY_OFFICE_RUNTIME_PREFER_MANAGED", "1");
    const tools = Object.fromEntries(["soffice", "pdfinfo", "pdftoppm", "pdftotext"].map(name => [name, join(root!, "runtime", `${name}.exe`)]));
    const ensure = vi.fn(async () => ({ root: root!, version: "test-1", tools }));
    const dependencies = await resolveCommandRuntimeDependencies(["office"], "win32", { ensure });
    expect(ensure).toHaveBeenCalledWith("win32", process.arch);
    expect(JSON.parse(dependencies.environment.MEMMY_OFFICE_TOOLS!)).toEqual(tools);
    expect(dependencies.readRoots).toEqual([root]); expect(dependencies.executableRoots).toEqual([root]);
  });

  describe("sandbox: none", () => {
    /**
     * Activates a `sandbox: "none"` plugin and reports the command that was
     * actually spawned, which is how the sandbox decision is observable:
     * the sandboxed path launches the sandbox binary, the exempt path
     * launches the plugin itself.
     */
    async function spawnedCommandFor(options: {
      entitlement: string | null;
      granted: string[];
      platform?: NodeJS.Platform;
    }): Promise<string> {
      let spawnedCommand = "";
      const adapter = createCommandPluginAdapter({
        platform: options.platform ?? "darwin",
        isEntitlementGranted: (entitlement) => options.granted.includes(entitlement),
        spawnFn: ((command, _args, spawnOptions) => {
          spawnedCommand = command;
          // Runs something harmless instead, so the assertion is about which
          // launch was chosen rather than about the sandbox working here.
          return spawn(process.execPath, ["-e", "console.log('{}')"], spawnOptions as Parameters<typeof spawn>[2]);
        }) as typeof spawn
      });
      const pluginContext = context();
      pluginContext.plugin.manifest.runtime.config = {
        ...pluginContext.plugin.manifest.runtime.config,
        sandbox: "none"
      };
      if (options.entitlement) pluginContext.plugin.manifest.requiredEntitlement = options.entitlement;
      const session = await adapter.activate(pluginContext);
      await collect(adapter.invoke(session, {
        callId: "call-1",
        pluginId: pluginContext.plugin.id,
        capabilityId: "run",
        conversationId: "conversation-1",
        input: {}
      }));
      return spawnedCommand;
    }

    it("runs a plugin unsandboxed when the account holds its declared entitlement", async () => {
      const command = await spawnedCommandFor({
        entitlement: "plugin:legal-labor",
        granted: ["plugin:legal-labor"]
      });

      expect(command).not.toMatch(/sandbox-exec|bwrap/u);
      expect(command).toContain("runtime/plugin");
    });

    it("keeps the sandbox on when the account does not hold the entitlement", async () => {
      // A third-party plugin can copy `sandbox: "none"` and any entitlement
      // name into its manifest, so the grant has to come from the account.
      const command = await spawnedCommandFor({
        entitlement: "plugin:legal-labor",
        granted: []
      });

      expect(command).toMatch(/sandbox-exec$/u);
    });

    it("keeps the sandbox on when the manifest declares no entitlement at all", async () => {
      const command = await spawnedCommandFor({ entitlement: null, granted: ["plugin:legal-labor"] });

      expect(command).toMatch(/sandbox-exec$/u);
    });

    it.each(["plugin:legal-labor", "plugin:literature-review"])("runs unsandboxed on Windows with %s", async (entitlement) => {
      // Existing entitled exemptions remain compatible with Windows.
      const command = await spawnedCommandFor({
        entitlement,
        granted: [entitlement],
        platform: "win32"
      });

      expect(command).not.toMatch(/sandbox-exec|bwrap/u);
    });

    it.each([null, "plugin:literature-review"])("uses AppContainer on Windows without a grant for %s", async (entitlement) => {
      const command = await spawnedCommandFor({ entitlement, granted: [], platform: "win32" });
      expect(command).toMatch(/powershell\.exe$/u);
    });
  });
});
