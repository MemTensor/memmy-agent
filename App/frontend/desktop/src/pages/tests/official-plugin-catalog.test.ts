import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "@memmy/local-api-contracts";
import { officialPluginCatalog, pluginRequiresOfficialModel } from "../official-plugin-catalog.js";

describe("official plugin presentation policy", () => {
  it("lists the official plugins and binds host installations by id while ignoring unknown ones", () => {
    const plugins = officialPluginCatalog({ language: "zh-CN", installed: [{ id: "legal-labor", state: "active" } as InstalledPlugin, { id: "leftover" } as InstalledPlugin] });
    expect(plugins.map((plugin) => plugin.id)).toEqual(["literature-review", "office", "legal-labor"]);
    expect(plugins.find((plugin) => plugin.id === "legal-labor")?.installed?.id).toBe("legal-labor");
    expect(plugins.find((plugin) => plugin.id === "office")?.installed).toBeUndefined();
    expect(plugins.some((plugin) => plugin.id === "leftover")).toBe(false);
  });

  it("default inclusion never fabricates an installed record after removal", () => {
    const plugin = officialPluginCatalog({ language: "zh-CN", installed: [] })[0]!;
    expect(plugin.defaultInstalled).toBe(true);
    expect(plugin.requiresOfficialModel).toBe(true);
    expect(plugin.installed).toBeUndefined();
    expect(plugin.version).toBeUndefined();
    expect(plugin.installable).toBe(true);
  });

  it("preserves the host state, including incomplete permission approval", () => {
    const installed = { id: "literature-review", version: "0.5.41", state: "pending_approval" } as InstalledPlugin;
    const plugin = officialPluginCatalog({ language: "en-US", installed: [installed] })[0]!;
    expect(plugin.installed).toBe(installed);
    expect(plugin.version).toBe("0.5.41");
    expect(plugin.name).toBe("Literature Review");
  });

  it("requires the official model only for literature review", () => {
    expect(pluginRequiresOfficialModel("literature-review")).toBe(true);
    expect(pluginRequiresOfficialModel("/literature-review")).toBe(false);
    expect(pluginRequiresOfficialModel("office")).toBe(false);
    expect(pluginRequiresOfficialModel(undefined)).toBe(false);
  });
});
