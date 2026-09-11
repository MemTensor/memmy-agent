import { describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "@memmy/local-api-contracts";
import { reconcileBundledPlugins } from "../bundled-plugin-bootstrap-service.js";
import type { PluginService } from "../plugin-service.js";

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

describe("reconcileBundledPlugins", () => {
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

  it("upgrades an installed release and disables it without uninstalling", async () => {
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
    expect(service.update).toHaveBeenCalledWith(manifest.id, manifest.version);
    expect(service.disable).toHaveBeenCalledWith(manifest.id);
    expect(service.uninstall).not.toHaveBeenCalled();
  });
});
