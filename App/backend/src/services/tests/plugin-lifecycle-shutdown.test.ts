import { PluginManifestSchema } from "@memmy/local-api-contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultAgentAdapterRegistry } from "../../adapters/outbound/agent-adapter/index.js";
import type { MemmyAgentAdminClient } from "../../adapters/outbound/memmy-agent-admin-client/index.js";
import { createInMemoryPluginRegistry } from "../../adapters/outbound/plugin-registry/index.js";
import { createAppStateStore, type AppStateStore } from "../../infrastructure/app-state-store/index.js";
import { createMemmyConfigWriter } from "../../infrastructure/memmy-config/index.js";
import { createPermissionManager } from "../../permission/index.js";
import { createMockCloudClient } from "../../tests/support/mock-cloud-client.js";
import { createMockMemoryClient } from "../../tests/support/mock-memory-client.js";
import { createBackendServices } from "../index.js";
import type { PluginArtifactManager, PluginRuntimeHost } from "../plugin-service.js";

const native = vi.hoisted(() => ({
  busy: false,
  isBusy: vi.fn(() => false),
  release: vi.fn(async (_id: string) => {}),
  close: vi.fn(async () => {}),
}));
vi.mock("../plugin-native-host-services.js", () => ({
  createPluginNativeHostServices: () => ({ ...native,
    start: vi.fn(), hostServices: { invoke: vi.fn() },
  }),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function settlesWithin(promise: Promise<void>, milliseconds = 500) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise.then(() => true), new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
let root: string | undefined;
let store: AppStateStore | undefined;
afterEach(() => {
  store?.close(); store = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});

async function setup() {
  root = mkdtempSync(join(tmpdir(), "memmy-plugin-shutdown-"));
  vi.stubEnv("MEMMY_AGENT_WORKSPACE", join(root, "workspace"));
  vi.stubEnv("MEMMY_AGENT_DATA_DIR", root);
  store = createAppStateStore({ databasePath: join(root, "app.sqlite") });
  native.busy = false;
  native.isBusy.mockReset().mockImplementation(() => native.busy);
  native.release.mockReset().mockImplementation(async () => { native.busy = false; });
  native.close.mockReset().mockResolvedValue(undefined);
  const state = { taskBusy: false };
  const hasActiveTasks = vi.fn(async () => state.taskBusy);
  const releaseLease = vi.fn(async () => {});
  const reloadMcpConfig = vi.fn(async () => ({ ok: true, message: "reloaded", requires_restart: false }));
  const manifest = PluginManifestSchema.parse({
    apiVersion: "memmy/v1", id: "shutdown-fixture", name: "Shutdown fixture", version: "1.0.0",
    runtime: { adapter: "http", config: { baseUrl: "https://plugin.example" } },
    rules: { autoUpdate: true, requiresLogin: false }, permissions: [],
    capabilities: [{ id: "run", name: "Run", description: "Run fixture", inputSchema: { type: "object" },
      outputSchema: { type: "object" }, execution: "request" }],
  });
  const registry = createInMemoryPluginRegistry([{ manifest }, { manifest: { ...manifest, version: "2.0.0" } }]);
  const catalog = vi.spyOn(registry, "list");
  const artifactManager: PluginArtifactManager = {
    install: vi.fn(async () => ({ artifactHash: null, rootPath: null })),
    readTextFile: async () => "", remove: vi.fn(async () => {}),
  };
  const runtimeHost: PluginRuntimeHost = {
    supports: () => true, activate: vi.fn(async () => {}), deactivate: vi.fn(async () => {}),
    async *invoke() { yield { type: "result", output: {} }; },
    cancel: async () => {}, respond: async () => {},
  };
  const services = createBackendServices({
    appStateStore: store, agentAdapterRegistry: createDefaultAgentAdapterRegistry(),
    permissionManager: createPermissionManager({ appStateStore: store }),
    cloudClient: createMockCloudClient(), memoryClient: createMockMemoryClient(), accountChannel: "email",
    memmyConfigWriter: createMemmyConfigWriter({ configPath: join(root, "config.yaml"), accountChannel: "email" }),
    memmyConfigPath: join(root, "config.yaml"),
    memmyAgentAdminClient: { hasActiveTasks, reloadMcpConfig,
      tryAcquirePluginUpdateLease: async () => releaseLease } as unknown as MemmyAgentAdminClient,
    pluginRegistry: registry, pluginArtifactManager: artifactManager, pluginRuntimeHost: runtimeHost,
  });
  const lifecycle = services.pluginLifecycle!;
  await lifecycle.start();
  await services.plugins.install(manifest.id, "1.0.0");
  await services.plugins.enable(manifest.id);
  return { services, lifecycle, id: manifest.id, state, hasActiveTasks, releaseLease,
    reloadMcpConfig, catalog, artifactManager, runtimeHost };
}

describe("Backend plugin lifecycle shutdown", () => {
  it("closes while idle and prevents further update scheduling", async () => {
    const f = await setup();
    await f.lifecycle.close();
    f.lifecycle.startUpdates();
    expect(f.catalog).not.toHaveBeenCalled();
    expect(f.runtimeHost.deactivate).toHaveBeenCalledOnce();
    expect(native.close).toHaveBeenCalledOnce();
  });

  it.each(["download", "task", "recording", "tool"] as const)(
    "cancels an automatic update waiting for %s before draining it", async waitingFor => {
      const f = await setup();
      const download = deferred(), entered = deferred(), waited = deferred();
      const staged = { artifactHash: "next", rootPath: join(root!, "staged-update") };
      vi.mocked(f.artifactManager.install).mockImplementationOnce(async () => {
        entered.resolve(); await download.promise; return staged;
      });
      let call: AsyncIterator<unknown> | undefined;
      let closing: Promise<void> | undefined;
      f.lifecycle.startUpdates();
      try {
        await entered.promise;
        if (waitingFor === "task") {
          f.state.taskBusy = true;
          f.hasActiveTasks.mockImplementation(async () => { waited.resolve(); return f.state.taskBusy; });
        } else if (waitingFor === "recording") {
          native.busy = true;
          native.isBusy.mockImplementation(() => { waited.resolve(); return native.busy; });
        } else if (waitingFor === "tool") {
          // Keep the real PluginService call open while the old version is still usable.
          call = f.services.plugins.invoke({ callId: "in-flight", pluginId: f.id, capabilityId: "run",
            conversationId: "chat", input: {} })[Symbol.asyncIterator]();
          await call.next();
          expect(f.services.plugins.get(f.id).activeCallCount).toBe(1);
        }
        if (waitingFor !== "download") download.resolve();
        if (waitingFor === "task" || waitingFor === "recording") await waited.promise;
        closing = f.lifecycle.close();
        expect(await settlesWithin(closing)).toBe(true);
        expect(f.services.plugins.get(f.id).version).toBe("1.0.0");
        expect(f.services.plugins.get(f.id).update).toBeUndefined();
        expect(f.runtimeHost.activate).toHaveBeenCalledTimes(1);
        if (waitingFor === "task") expect(f.state.taskBusy).toBe(true);
        if (waitingFor === "tool") expect(f.services.plugins.get(f.id).activeCallCount).toBe(1);
        expect(native.close).toHaveBeenCalledOnce();
        expect(f.reloadMcpConfig).not.toHaveBeenCalled();
        // A download may complete after cancellation; its staged artifact is still removed.
        download.resolve();
        await vi.waitFor(() => expect(f.artifactManager.remove).toHaveBeenCalledWith(staged));
        const checks = f.catalog.mock.calls.length;
        f.lifecycle.startUpdates();
        expect(f.catalog).toHaveBeenCalledTimes(checks);
      } finally {
        f.state.taskBusy = false; native.busy = false; download.resolve();
        await call?.return?.();
        await (closing ?? f.lifecycle.close());
      }
    },
  );

  it.each(["activation", "rollback"] as const)("drains %s before releasing native resources", async phase => {
    const f = await setup();
    const entered = deferred(), finish = deferred();
    if (phase === "activation") {
      vi.mocked(f.runtimeHost.activate).mockImplementationOnce(async () => { entered.resolve(); await finish.promise; });
    } else {
      vi.mocked(f.runtimeHost.activate).mockRejectedValueOnce(new Error("activation failed"))
        .mockImplementationOnce(async () => { entered.resolve(); await finish.promise; });
    }
    let closing: Promise<void> | undefined;
    f.lifecycle.startUpdates();
    try {
      await entered.promise;
      closing = f.lifecycle.close();
      expect(await settlesWithin(closing, 30)).toBe(false);
      expect(native.close).not.toHaveBeenCalled();
      expect(f.releaseLease).not.toHaveBeenCalled();
      finish.resolve();
      expect(await settlesWithin(closing)).toBe(true);
      expect(f.services.plugins.get(f.id).version).toBe(phase === "activation" ? "2.0.0" : "1.0.0");
      expect(f.services.plugins.get(f.id).update).toBeUndefined();
      expect(f.releaseLease).toHaveBeenCalledOnce();
      expect(native.close).toHaveBeenCalledOnce();
      expect(vi.mocked(f.runtimeHost.deactivate).mock.invocationCallOrder.at(-1)).toBeLessThan(native.close.mock.invocationCallOrder[0]!);
      expect(f.reloadMcpConfig).not.toHaveBeenCalled();
    } finally { finish.resolve(); await (closing ?? f.lifecycle.close()); }
  });

  it("still closes native resources when plugin shutdown rejects", async () => {
    const f = await setup();
    vi.spyOn(f.services.plugins, "shutdown").mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(f.lifecycle.close()).rejects.toThrow("cleanup failed");
    expect(native.close).toHaveBeenCalledOnce();
    await f.services.plugins.shutdown();
  });
});
