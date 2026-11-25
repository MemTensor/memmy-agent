import { applicationObservationDecision, type ApplicationRule, type ObservationSettings } from "../core/observation-settings.js";
import { isWindowsApplicationId, windowsApplicationAlias, windowsApplicationId, windowsPathKey } from "../core/application-identity.js";
import type { WindowsHistorySettings } from "./settings.js";

export function windowsScopeAllows(settings: ObservationSettings, executable: string): boolean {
  return applicationObservationDecision(settings, { executable, bundleId: windowsApplicationAlias(executable) }).observe;
}
export function windowsScopeRule(executable: string, behavior: ApplicationRule["behavior"]): ApplicationRule {
  return { scope: "app", bundleID: windowsApplicationId(executable), executable, behavior };
}

/** Preserve the intersection of the two legacy application axes, without discovering apps. */
export function migrateWindowsObservation(legacy: WindowsHistorySettings, shared: ObservationSettings): ObservationSettings {
  const next = structuredClone(shared);
  if (legacy.defaultApplicationBehavior !== "observe") {
    next.observation.defaultApplicationBehavior = "do_not_observe";
    next.observation.rules = next.observation.rules.filter(rule => rule.scope !== "app"
      || !isWindowsApplicationId(rule.bundleID) || rule.behavior === "do_not_observe");
    next.observation.rules.push(...legacy.applications
      .filter(rule => windowsScopeAllows(shared, rule.executable))
      .map(rule => windowsScopeRule(rule.executable, "observe")));
  }
  for (const executable of legacy.deny?.executables ?? []) next.observation.rules.push(windowsScopeRule(executable, "do_not_observe"));
  next.observation.rules = next.observation.rules.filter((rule, index, rules) => index === rules.findIndex(other =>
    rule.scope === other.scope && rule.behavior === other.behavior && (rule.scope === "app" && other.scope === "app"
      ? rule.bundleID.toLowerCase() === other.bundleID.toLowerCase()
      : rule.scope === "url" && other.scope === "url" && rule.urlDomain === other.urlDomain)));
  return next;
}

/** Compatibility Windows API edits only the Windows application axis; websites stay intact. */
export function replaceWindowsObservation(input: WindowsHistorySettings, shared: ObservationSettings): ObservationSettings {
  const next = structuredClone(shared);
  next.observation.defaultApplicationBehavior = input.defaultApplicationBehavior ?? "do_not_observe";
  next.observation.rules = next.observation.rules.filter(rule => rule.scope !== "app" || !isWindowsApplicationId(rule.bundleID));
  if (next.observation.defaultApplicationBehavior !== "observe") {
    next.observation.rules.push(...input.applications.map(rule => windowsScopeRule(rule.executable, "observe")));
  }
  next.observation.rules.push(...(input.deny?.executables ?? []).map(executable => windowsScopeRule(executable, "do_not_observe")));
  return next;
}

export function projectWindowsSettings(internal: WindowsHistorySettings, shared: ObservationSettings): WindowsHistorySettings {
  const { observationSettingsVersion: _migration, ...configuration } = internal;
  void _migration;
  const profiles = new Map(internal.applications.map(rule => [windowsPathKey(rule.executable), rule]));
  const denied: string[] = [];
  for (const rule of shared.observation.rules) {
    if (rule.scope !== "app" || !rule.executable) continue;
    if (rule.behavior === "do_not_observe") denied.push(rule.executable);
    else if (!profiles.has(windowsPathKey(rule.executable))) profiles.set(windowsPathKey(rule.executable), { executable: rule.executable });
  }
  return { ...configuration, defaultApplicationBehavior: shared.observation.defaultApplicationBehavior,
    applications: [...profiles.values()], deny: { executables: denied } };
}
