import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryPluginRegistry, type PluginRelease } from "../../adapters/outbound/plugin-registry/index.js";
import { createAppStateStore, type AppStateStore } from "../../infrastructure/app-state-store/index.js";
import {
  createPluginService,
  type PluginArtifactManager,
  type PluginRuntimeHost
} from "../plugin-service.js";

let root: string | undefined;
let store: AppStateStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const release = {
  manifest: {
    apiVersion: "memmy/v1" as const,
    id: "com.example.review",
    name: "Review",
    version: "1.0.0",
    runtime: { adapter: "http" as const, config: { baseUrl: "https://plugin.example" } },
    capabilities: [{
      id: "run",
      name: "Run review",
      description: "Runs a review",
      inputSchema: { type: "object", required: ["topic"], properties: { topic: { type: "string" } } },
      outputSchema: { type: "object" },
      execution: "job" as const
    }],
    permissions: [
      { type: "network" as const, hosts: ["plugin.example"] },
      { type: "secret" as const, keys: ["api-key"] }
    ],
    configSchema: {
      type: "object",
      required: ["database"],
      properties: { database: { type: "string" } },
      additionalProperties: false
    }
  }
};

function createContext(releases: PluginRelease[] = [release]) {
  root = mkdtempSync(join(tmpdir(), "memmy-plugin-service-"));
  store = createAppStateStore({ databasePath: join(root, "app.sqlite") });
  const runtimeHost: PluginRuntimeHost = {
    supports: vi.fn(() => true),
    activate: vi.fn(async () => undefined),
    deactivate: vi.fn(async () => undefined),
    async *invoke() {
      yield { type: "result" as const, output: { ok: true } };
    },
    cancel: vi.fn(async () => undefined),
    respond: vi.fn(async () => undefined)
  };
  const artifactManager: PluginArtifactManager = {
    install: vi.fn(async (pluginRelease) => ({
      artifactHash: pluginRelease.artifact?.sha256.toLowerCase() ?? null,
      rootPath: null
    })),
    remove: vi.fn(async () => undefined)
  };
  return {
    runtimeHost,
    artifactManager,
    service: createPluginService({
      repository: store.repositories.plugins,
      secretStore: store.secretStore,
      registry: createInMemoryPluginRegistry(releases),
      runtimeHost,
      artifactManager
    })
  };
}

describe("PluginService", () => {
  it("installs, configures, approves, enables, disables, and uninstalls", async () => {
    const { service, runtimeHost, artifactManager } = createContext();
    expect((await service.install(release.manifest.id)).state).toBe("pending_approval");
    expect(() => service.configure(release.manifest.id, { config: {} })).toThrow(/Invalid plugin config/);
    service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { "api-key": "secret" }
    });
    expect((await service.approvePermissions(release.manifest.id, release.manifest.permissions)).state).toBe("installed");
    expect((await service.enable(release.manifest.id)).state).toBe("active");
    expect(runtimeHost.activate).toHaveBeenCalledWith(expect.objectContaining({ id: release.manifest.id }), {
      "api-key": "secret"
    });
    expect((await service.disable(release.manifest.id)).state).toBe("disabled");
    await service.uninstall(release.manifest.id);
    expect(service.list()).toEqual([]);
    expect(artifactManager.remove).toHaveBeenCalled();
  });

  it("rejects undeclared secrets and permissions", async () => {
    const { service } = createContext();
    await service.install(release.manifest.id);
    expect(() => service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { password: "nope" }
    })).toThrow(/not declared/);
    await expect(service.approvePermissions(release.manifest.id, [{
      type: "network",
      hosts: ["evil.example"]
    }])).rejects.toThrow(/did not declare/);
  });

  it("rejects a changed artifact digest for an installed version", async () => {
    const releases: PluginRelease[] = [{
      ...release,
      artifact: { url: "https://plugins.example/review.zip", sha256: "a".repeat(64) }
    }];
    const { service } = createContext(releases);
    await service.install(release.manifest.id);
    releases.push({
      ...release,
      artifact: { url: "https://plugins.example/review.zip", sha256: "b".repeat(64) }
    });

    await expect(service.install(release.manifest.id)).rejects.toThrow(/digest changed/);
  });

  it("marks activation failures without publishing the plugin as active", async () => {
    const { service, runtimeHost } = createContext();
    await service.install(release.manifest.id);
    service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { "api-key": "secret" }
    });
    await service.approvePermissions(release.manifest.id, release.manifest.permissions);
    vi.mocked(runtimeHost.activate).mockRejectedValueOnce(new Error("offline"));
    await expect(service.enable(release.manifest.id)).rejects.toThrow(/offline/);
    expect(service.get(release.manifest.id)).toMatchObject({ state: "failed", lastError: "offline" });
  });

  it("invokes only active declared capabilities", async () => {
    const { service, runtimeHost } = createContext();
    await service.install(release.manifest.id);
    service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { "api-key": "secret" }
    });
    await service.approvePermissions(release.manifest.id, release.manifest.permissions);
    await service.enable(release.manifest.id);
    const events = [];
    for await (const event of service.invoke({
      callId: "call-1",
      pluginId: release.manifest.id,
      capabilityId: "run",
      conversationId: "conversation-1",
      input: {}
    })) events.push(event);
    expect(events).toEqual([{ type: "result", output: { ok: true } }]);
    expect(runtimeHost.invoke).toBeDefined();
    expect(store!.db.prepare("SELECT outcome, error_code FROM plugin_call_logs WHERE call_id = ?")
      .get("call-1")).toEqual({ outcome: "success", error_code: null });
    expect(() => service.configure(release.manifest.id, {
      config: { database: "pubmed" }
    })).toThrow(/Disable plugin/);
  });

  it("updates an active plugin and reactivates it atomically", async () => {
    const nextRelease: PluginRelease = {
      manifest: { ...release.manifest, version: "2.0.0" }
    };
    const { service, runtimeHost } = createContext([release, nextRelease]);
    await service.install(release.manifest.id, "1.0.0");
    service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { "api-key": "secret" }
    });
    await service.approvePermissions(release.manifest.id, release.manifest.permissions);
    await service.enable(release.manifest.id);
    expect(await service.update(release.manifest.id, "2.0.0")).toMatchObject({
      version: "2.0.0",
      state: "active",
      config: { database: "crossref" }
    });
    expect(runtimeHost.deactivate).toHaveBeenCalledWith(release.manifest.id);
    expect(runtimeHost.activate).toHaveBeenCalledTimes(2);
  });

  it("restores and closes persisted active runtimes without changing their state", async () => {
    const { service, runtimeHost } = createContext();
    await service.install(release.manifest.id);
    service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { "api-key": "secret" }
    });
    await service.approvePermissions(release.manifest.id, release.manifest.permissions);
    await service.enable(release.manifest.id);
    vi.mocked(runtimeHost.activate).mockClear();

    await service.restoreActive();
    await service.shutdown();

    expect(runtimeHost.activate).toHaveBeenCalledOnce();
    expect(runtimeHost.deactivate).toHaveBeenCalledWith(release.manifest.id);
    expect(service.get(release.manifest.id).state).toBe("active");
  });
});
