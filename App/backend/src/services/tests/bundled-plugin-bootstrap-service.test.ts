import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "@memmy/local-api-contracts";
import { createInMemoryPluginRegistry, type PluginRelease } from "../../adapters/outbound/plugin-registry/index.js";
import { createAppStateStore, type AppStateStore } from "../../infrastructure/app-state-store/index.js";
import {
  reconcileBundledPlugins,
  suppressBundledPlugins
} from "../bundled-plugin-bootstrap-service.js";
import { createPluginService, type PluginService } from "../plugin-service.js";

let root: string | undefined;
let store: AppStateStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const manifest = {
  apiVersion: "memmy/v1" as const,
  id: "literature-review",
  name: "Literature Review",
  version: "0.5.17",
  runtime: { adapter: "command" as const, config: { command: "dist/runtime.js" } },
  capabilities: [],
  permissions: [{ type: "network" as const, hosts: ["arxiv.org"] }]
};

function installed(version = manifest.version): InstalledPlugin {
  return {
    id: manifest.id,
    name: manifest.name,
    version,
    manifest: { ...manifest, version },
    state: "installed",
    approvedPermissions: [],
    config: {},
    lastError: null,
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z"
  };
}

function createPersistedContext() {
  root = mkdtempSync(join(tmpdir(), "memmy-bundled-plugin-"));
  const databasePath = join(root, "app.sqlite");
  store = createAppStateStore({ databasePath });
  const release: PluginRelease = {
    manifest: {
      ...manifest,
      capabilities: [{
        id: "run", name: "Run", description: "Run review",
        inputSchema: { type: "object" }, outputSchema: { type: "object" }, execution: "request"
      }]
    }
  };
  const releases: PluginRelease[] = [release];
  const artifactManager = {
    install: vi.fn(async () => ({ artifactHash: null, rootPath: null })),
    remove: vi.fn(async () => undefined),
    readTextFile: vi.fn(async () => "")
  };
  const createService = () => createPluginService({
    repository: store!.repositories.plugins,
    secretStore: store!.secretStore,
    registry: createInMemoryPluginRegistry(releases),
    artifactManager,
    runtimeHost: {
      supports: () => true,
      activate: async () => undefined,
      deactivate: async () => undefined,
      async *invoke() { yield { type: "result", output: {} }; }
    }
  });
  let service = createService();
  return {
    get service() { return service; },
    releases,
    artifactManager,
    bootstrap: () => reconcileBundledPlugins({
      plugins: service,
      releases: releases.map(({ manifest: item }) => ({ id: item.id, version: item.version })),
      enabledById: {},
      userUninstalledIds: new Set(store!.repositories.plugins.listUserUninstalledIds())
    }),
    async restart() {
      await service.shutdown();
      store!.close();
      store = createAppStateStore({ databasePath });
      service = createService();
    }
  };
}

describe("reconcileBundledPlugins", () => {
  it("keeps an explicit uninstall across restarts and restores defaults after reinstall", async () => {
    const context = createPersistedContext();
    await expect(context.bootstrap()).resolves.toEqual([]);
    expect(context.service.get(manifest.id).state).toBe("active");

    await context.service.uninstall(manifest.id);
    await context.restart();
    context.releases.push({ manifest: { ...context.releases[0].manifest, id: "another-bundled-plugin" } });
    await expect(context.bootstrap()).resolves.toEqual([]);
    expect(context.service.list().map((plugin) => plugin.id)).toEqual(["another-bundled-plugin"]);

    await context.service.install(manifest.id);
    await context.restart();
    await expect(context.bootstrap()).resolves.toEqual([]);
    expect(context.service.get(manifest.id).state).toBe("active");
    expect(store!.repositories.plugins.listUserUninstalledIds()).toEqual([]);
  });

  it("preserves the uninstall preference when explicit reinstallation fails", async () => {
    const context = createPersistedContext();
    await context.bootstrap();
    await context.service.uninstall(manifest.id);
    context.artifactManager.install.mockRejectedValueOnce(new Error("download failed"));

    await expect(context.service.install(manifest.id)).rejects.toThrow("download failed");
    await context.restart();
    await expect(context.bootstrap()).resolves.toEqual([]);
    expect(context.service.list()).toEqual([]);
    expect(store!.repositories.plugins.listUserUninstalledIds()).toEqual([manifest.id]);
  });

  it("keeps the installed choice when uninstall cleanup fails", async () => {
    const context = createPersistedContext();
    await context.bootstrap();
    context.artifactManager.remove.mockRejectedValueOnce(new Error("remove failed"));

    await expect(context.service.uninstall(manifest.id)).rejects.toThrow("remove failed");
    expect(store!.repositories.plugins.listUserUninstalledIds()).toEqual([]);
    await context.restart();
    await expect(context.bootstrap()).resolves.toEqual([]);
    expect(context.service.get(manifest.id).state).toBe("active");
  });

  it("installs, auto-approves, and enables a trusted release by default", async () => {
    const plugin = installed();
    const service = {
      list: vi.fn(() => []),
      install: vi.fn(async () => plugin),
      update: vi.fn(),
      approvePermissions: vi.fn(async () => plugin),
      enable: vi.fn(async () => ({ ...plugin, state: "active" })),
      disable: vi.fn()
    } as unknown as PluginService;

    await expect(reconcileBundledPlugins({
      plugins: service,
      releases: [{ id: manifest.id, version: manifest.version }],
      enabledById: {}
    })).resolves.toEqual([]);
    expect(service.install).toHaveBeenCalledWith(manifest.id, manifest.version);
    expect(service.approvePermissions).toHaveBeenCalledWith(manifest.id, manifest.permissions);
    expect(service.enable).toHaveBeenCalledWith(manifest.id);
    expect(service.disable).not.toHaveBeenCalled();
  });

  it("preserves the installed version without automatic upgrade", async () => {
    const previous = installed("0.5.16");
    const current = installed();
    const service = {
      list: vi.fn(() => [previous]),
      install: vi.fn(),
      update: vi.fn(async () => current),
      approvePermissions: vi.fn(async () => current),
      enable: vi.fn(),
      disable: vi.fn(async () => ({ ...current, state: "disabled" })),
      uninstall: vi.fn()
    } as unknown as PluginService;

    await reconcileBundledPlugins({
      plugins: service,
      releases: [{ id: manifest.id, version: manifest.version }],
      enabledById: { [manifest.id]: false }
    });
    expect(service.update).not.toHaveBeenCalled();
    expect(service.disable).toHaveBeenCalledWith(manifest.id);
    expect(service.uninstall).not.toHaveBeenCalled();
  });
});

describe("suppressBundledPlugins", () => {
  it("deactivates a persisted active plugin omitted by this distribution", async () => {
    const active = { ...installed(), state: "active" as const };
    const service = {
      list: vi.fn(() => [active]),
      disable: vi.fn(async () => ({ ...active, state: "disabled" as const })),
      uninstall: vi.fn()
    } as unknown as PluginService;

    await expect(suppressBundledPlugins({
      plugins: service,
      releases: [],
      managedPluginIds: [manifest.id],
      enabledById: {}
    })).resolves.toEqual([]);

    expect(service.disable).toHaveBeenCalledWith(manifest.id);
    expect(service.uninstall).not.toHaveBeenCalled();
  });

  it("keeps an included and enabled plugin active", async () => {
    const active = { ...installed(), state: "active" as const };
    const service = {
      list: vi.fn(() => [active]),
      disable: vi.fn()
    } as unknown as PluginService;

    await suppressBundledPlugins({
      plugins: service,
      releases: [{ id: manifest.id, version: manifest.version }],
      managedPluginIds: [manifest.id],
      enabledById: { [manifest.id]: true }
    });

    expect(service.disable).not.toHaveBeenCalled();
  });
});
