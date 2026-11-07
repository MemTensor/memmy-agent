/** Evaluates plugin policy against current server-issued account facts. */
import { PluginRulesSchema, type PluginManifest, type PluginEligibility } from "@memmy/local-api-contracts";

export function pluginRules(manifest: Pick<PluginManifest, "rules" | "requiredEntitlement">) {
  // Legacy private manifests predate rules. Do not expose them after a grant
  // is revoked; an explicit policy can still opt into an unavailable listing.
  return PluginRulesSchema.parse(manifest.rules ?? {
    unavailableVisibility: manifest.requiredEntitlement ? "hidden" : "visible"
  });
}

export function pluginEligibility(manifest: Pick<PluginManifest, "rules" | "requiredEntitlement">,
  authenticated: boolean, hasEntitlement: (grant: string) => boolean): PluginEligibility {
  const rules = pluginRules(manifest);
  const entitlement = manifest.requiredEntitlement;
  const reason = (rules.requiresLogin || rules.distribution === "account") && !authenticated
    ? "login_required" : entitlement && !hasEntitlement(entitlement) ? "entitlement_required" : null;
  return { visible: !reason || rules.unavailableVisibility === "visible", canInstall: !reason, canUse: !reason, reason };
}
