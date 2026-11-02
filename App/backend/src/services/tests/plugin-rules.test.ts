import { describe, expect, it } from "vitest";
import { PluginRulesSchema } from "@memmy/local-api-contracts";
import { pluginEligibility, pluginRules } from "../plugin-rules.js";

describe("plugin product policy", () => {
  it("preserves public manual installation defaults", () => {
    expect(PluginRulesSchema.parse({}).autoUpdate).toBe(false);
    expect(pluginRules({}).installation).toBe("manual");
    expect(pluginEligibility({}, false, () => false)).toEqual({ visible: true, canInstall: true, canUse: true, reason: null });
  });
  it("hides beta plugins without server-issued grants", () => {
    const manifest = { requiredEntitlement: "plugin:legal", rules: PluginRulesSchema.parse({ requiresLogin: true, unavailableVisibility: "hidden" }) };
    expect(pluginEligibility(manifest, false, () => false).visible).toBe(false);
    expect(pluginEligibility(manifest, true, () => false).reason).toBe("entitlement_required");
    expect(pluginEligibility(manifest, true, (grant) => grant === "plugin:legal").canUse).toBe(true);
  });
  it("enforces requiredEntitlement with and without additional rules", () => {
    for (const rules of [undefined, PluginRulesSchema.parse({ installation: "automatic" })]) {
      const manifest = { requiredEntitlement: "plugin:legal", ...(rules ? { rules } : {}) };
      expect(pluginEligibility(manifest, true, () => false).canInstall).toBe(false);
      expect(pluginEligibility(manifest, true, () => false).reason).toBe("entitlement_required");
      if (!rules) expect(pluginEligibility(manifest, true, () => false).visible).toBe(false);
      expect(pluginEligibility(manifest, true, (grant) => grant === "plugin:legal").canUse).toBe(true);
    }
  });
  it("allows an explicit policy to show an unavailable private plugin", () => {
    const manifest = { requiredEntitlement: "plugin:legal", rules: PluginRulesSchema.parse({ unavailableVisibility: "visible" }) };
    expect(pluginEligibility(manifest, true, () => false)).toEqual({
      visible: true, canInstall: false, canUse: false, reason: "entitlement_required"
    });
  });
  it("does not turn a model recommendation into an access restriction", () => {
    const manifest = { rules: PluginRulesSchema.parse({ recommendsOfficialModel: true }) };
    expect(pluginEligibility(manifest, false, () => false).canUse).toBe(true);
  });
});
