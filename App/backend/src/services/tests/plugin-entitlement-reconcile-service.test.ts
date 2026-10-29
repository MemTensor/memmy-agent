/** Entitlement-gated plugin reconciliation tests. */
import { PluginRulesSchema, type InstalledPlugin, type PluginManifest } from "@memmy/local-api-contracts";
import { describe, expect, it, vi } from "vitest";
import type { PluginService } from "../plugin-service.js";
import { entitledPluginIds, reconcileEntitledPlugins } from "../plugin-entitlement-reconcile-service.js";

describe("entitled plugin reconciliation", () => {
  it("installs, approves, and enables a newly granted plugin", async () => {
    const plugins = fakePluginService([], new Set(), ["vertical-demo"]);
    const failures = await reconcileEntitledPlugins({
      plugins: plugins.service,
      entitlements: ["plugin:vertical-demo", "unrelated:grant"]
    });

    expect(failures).toEqual([]);
    expect(plugins.calls).toEqual([
      "install:vertical-demo",
      "approvePermissions:vertical-demo",
      "enable:vertical-demo"
    ]);
  });

  it("preserves an installed plugin until a manual update", async () => {
    const plugins = fakePluginService([installed("vertical-demo", "active")], new Set(), ["vertical-demo"]);
    await reconcileEntitledPlugins({ plugins: plugins.service, entitlements: ["plugin:vertical-demo"] });

    // Already active, so no redundant enable is issued.
    expect(plugins.calls).toEqual(["approvePermissions:vertical-demo"]);
  });

  it("disables a plugin whose grant was revoked without uninstalling its data", async () => {
    const plugins = fakePluginService([installed("vertical-demo", "active")]);
    await reconcileEntitledPlugins({ plugins: plugins.service, entitlements: [] });

    expect(plugins.calls).toEqual(["disable:vertical-demo"]);
  });

  it("leaves plugins that declare no entitlement untouched", async () => {
    const plugins = fakePluginService([{ ...installed("open-plugin", "active"), manifest: manifest("open-plugin", null) }]);
    await reconcileEntitledPlugins({ plugins: plugins.service, entitlements: [] });

    expect(plugins.calls).toEqual([]);
  });

  it("keeps an entitled plugin active when its grant is still held", async () => {
    const plugins = fakePluginService([installed("vertical-demo", "active")]);
    await reconcileEntitledPlugins({ plugins: plugins.service, entitlements: ["plugin:vertical-demo"] });

    expect(plugins.calls).not.toContain("disable:vertical-demo");
  });

  it("reports a failing plugin without aborting the remaining ones", async () => {
    const plugins = fakePluginService([], new Set(["broken"]), ["broken", "healthy"]);
    const failures = await reconcileEntitledPlugins({
      plugins: plugins.service,
      entitlements: ["plugin:broken", "plugin:healthy"]
    });

    expect(failures).toEqual([{ pluginId: "broken", message: "registry unavailable" }]);
    expect(plugins.calls).toContain("enable:healthy");
  });

  it("pins first installation to the advertised version but never upgrades existing installations", async () => {
    const plugins = fakePluginService([], new Set(), ["vertical-demo"]);
    await reconcileEntitledPlugins({ plugins: plugins.service, entitlements: ["plugin:vertical-demo"] });
    expect(plugins.service.install).toHaveBeenCalledWith("vertical-demo", "2.0.0");
    expect(plugins.service.update).not.toHaveBeenCalled();
  });

  it("ignores legacy autoUpdate=true, absent catalogs and failed catalog lookups for existing plugins", async () => {
    for (const mode of ["legacy", "absent", "offline"]) {
      const plugins = fakePluginService([installed("vertical-demo", "active")], new Set(), mode === "legacy" ? ["vertical-demo"] : []);
      if (mode === "legacy") vi.spyOn(plugins.service, "catalog").mockResolvedValue([{
        manifest: { ...manifest("vertical-demo"), version: "2.0.0", rules: PluginRulesSchema.parse({ autoUpdate: true, installation: "automatic" }) },
        eligibility: { visible: true, canInstall: true, canUse: true, reason: null }
      }]);
      if (mode === "offline") vi.spyOn(plugins.service, "catalog").mockRejectedValue(new Error("offline"));
      await reconcileEntitledPlugins({ plugins: plugins.service, entitlements: ["plugin:vertical-demo"] });
      expect(plugins.service.update).not.toHaveBeenCalled();
      expect(plugins.service.install).not.toHaveBeenCalled();
      expect(plugins.service.list()[0].version).toBe("1.0.0");
    }
  });

  it("leaves a queued manual update untouched during account reconciliation", async () => {
    const plugins = fakePluginService([{ ...installed("vertical-demo", "active"), update: { status: "waiting", version: "2.0.0" } }]);
    await reconcileEntitledPlugins({ plugins: plugins.service, entitlements: ["plugin:vertical-demo"] });
    expect(plugins.calls).toEqual([]);
  });

  it("installs an entitled private plugin omitted from the public catalog", async () => {
    const plugins = fakePluginService();
    await reconcileEntitledPlugins({ plugins: plugins.service, entitlements: ["plugin:vertical-demo"] });
    expect(plugins.calls).toEqual([
      "install:vertical-demo",
      "approvePermissions:vertical-demo",
      "enable:vertical-demo"
    ]);
    expect(plugins.service.install).toHaveBeenCalledWith("vertical-demo");
  });

  it("still reconciles entitlement-only plugins when the public catalog is unavailable", async () => {
    const plugins = fakePluginService();
    vi.spyOn(plugins.service, "catalog").mockRejectedValue(new Error("offline"));
    const failures = await reconcileEntitledPlugins({ plugins: plugins.service, entitlements: ["plugin:vertical-demo"] });
    expect(failures).toEqual([{ pluginId: "catalog", message: "Error: offline" }]);
    expect(plugins.calls).toEqual([
      "install:vertical-demo",
      "approvePermissions:vertical-demo",
      "enable:vertical-demo"
    ]);
  });

  it("does not reinstall an entitled private plugin the user explicitly removed", async () => {
    const plugins = fakePluginService();
    await reconcileEntitledPlugins({
      plugins: plugins.service,
      entitlements: ["plugin:vertical-demo"],
      userUninstalledIds: new Set(["vertical-demo"])
    });
    expect(plugins.calls).toEqual([]);
  });

  it("ignores grants that are not plugin grants", () => {
    expect(entitledPluginIds(["plugin:a", "feature:b", "plugin:", "plugin:a"])).toEqual(["a"]);
  });
});

function manifest(id: string, requiredEntitlement: string | null = `plugin:${id}`): PluginManifest {
  return {
    apiVersion: "memmy/v1",
    id,
    name: id,
    version: "1.0.0",
    runtime: { adapter: "command", config: { command: "bin/run" } },
    capabilities: [{
      id: "run",
      name: "Run",
      description: "Runs the vertical workflow",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      execution: "request"
    }],
    permissions: [],
    ...(requiredEntitlement ? { requiredEntitlement } : {})
  } as PluginManifest;
}

function installed(id: string, state: InstalledPlugin["state"]): InstalledPlugin {
  return {
    id,
    version: "1.0.0",
    manifest: manifest(id),
    state,
    approvedPermissions: [],
    config: {},
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function fakePluginService(initial: InstalledPlugin[] = [], failing: ReadonlySet<string> = new Set(), catalogIds: string[] = []) {
  const calls: string[] = [];
  const state = new Map(initial.map((plugin) => [plugin.id, plugin]));
  const record = (action: string, id: string) => {
    calls.push(`${action}:${id}`);
    if (failing.has(id)) throw new Error("registry unavailable");
  };

  const service = {
    list: () => [...state.values()],
    catalog: async () => catalogIds.map((id) => ({
      manifest: { ...manifest(id), version: "2.0.0", rules: { installation: "automatic" } },
      eligibility: { visible: true, canInstall: true, canUse: true, reason: null }
    })),
    install: vi.fn(async (id: string) => {
      record("install", id);
      const plugin = installed(id, "installed");
      state.set(id, plugin);
      return plugin;
    }),
    update: vi.fn(async (id: string) => {
      record("update", id);
      return state.get(id)!;
    }),
    approvePermissions: async (id: string) => {
      record("approvePermissions", id);
      return state.get(id)!;
    },
    enable: async (id: string) => {
      record("enable", id);
      const plugin = { ...state.get(id)!, state: "active" as const };
      state.set(id, plugin);
      return plugin;
    },
    disable: async (id: string) => {
      record("disable", id);
      const plugin = { ...state.get(id)!, state: "disabled" as const };
      state.set(id, plugin);
      return plugin;
    }
  } as unknown as PluginService;

  return { service, calls };
}
