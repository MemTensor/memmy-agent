/** Shared settings sidebar navigation for Desktop AppFrame + Settings page. */
import type { MessageKey } from "../i18n/messages.js";

export type SettingsTabId = "account" | "model" | "tokens" | "preferences" | "about";

export interface SettingsNavItem {
  id: SettingsTabId;
  labelKey: MessageKey;
}

export interface SettingsNavSection {
  titleKey: MessageKey;
  items: ReadonlyArray<SettingsNavItem>;
}

export const SETTINGS_NAV_SECTIONS: ReadonlyArray<SettingsNavSection> = [
  {
    titleKey: "settings.nav.account",
    items: [{ id: "account", labelKey: "settings.account" }]
  },
  {
    titleKey: "settings.nav.models",
    items: [
      { id: "model", labelKey: "settings.model" },
      { id: "tokens", labelKey: "settings.tokens" }
    ]
  },
  {
    titleKey: "settings.nav.app",
    items: [
      { id: "preferences", labelKey: "settings.preferences" },
      { id: "about", labelKey: "settings.about" }
    ]
  }
];

/** Flat list of settings nav items in sidebar order. */
export const SETTINGS_NAV_ITEMS: ReadonlyArray<SettingsNavItem> = SETTINGS_NAV_SECTIONS.flatMap(
  (section) => section.items
);

/** Deep-link that opens Model settings and the add-configuration modal. */
export const SETTINGS_ADD_MODEL_HASH = "#model-config-add";
/** Same-window event used when Settings is already mounted in the route shell. */
export const SETTINGS_ADD_MODEL_EVENT = "memmy:settings-open-add-model";
/** Marks that the add-model flow should return to the composer when closed. */
export const SETTINGS_ADD_MODEL_RETURN_STORAGE_KEY = "memmy.settings.addModel.returnRoute";

/** Reads a valid route to resume after configuring additional onboarding models. */
export function readSettingsAddModelReturnRoute(
  storage: Pick<Storage, "getItem"> | undefined
): "/main" | "/onboarding" | null {
  const value = storage?.getItem(SETTINGS_ADD_MODEL_RETURN_STORAGE_KEY);
  return value === "/main" || value === "/onboarding" ? value : null;
}

/** Resolves the settings tab that should open for a location hash deep-link. */
export function resolveSettingsTabFromHash(hash: string): SettingsTabId | null {
  switch (hash) {
    case "#account":
      return "account";
    case "#pet-avatar":
    case "#preferences":
      return "preferences";
    case "#model-config":
    case "#model":
    case SETTINGS_ADD_MODEL_HASH:
      return "model";
    case "#token-usage":
    case "#tokens":
      return "tokens";
    case "#about":
      return "about";
    default:
      return null;
  }
}

/** Whether the hash should auto-open the add-configuration modal. */
export function shouldOpenAddModelFromHash(hash: string): boolean {
  return hash === SETTINGS_ADD_MODEL_HASH;
}

/** Canonical hash for a settings tab (empty string clears the hash for account). */
export function settingsTabHash(tab: SettingsTabId): string {
  switch (tab) {
    case "account":
      return "";
    case "model":
      return "#model-config";
    case "tokens":
      return "#token-usage";
    case "preferences":
      return "#preferences";
    case "about":
      return "#about";
  }
}

/** Reads the initial settings tab from an optional location hash. */
export function readInitialSettingsTab(hash?: string): SettingsTabId {
  if (!hash) {
    return "account";
  }
  return resolveSettingsTabFromHash(hash) ?? "account";
}

/** Writes the settings tab hash without adding a browser history entry. */
export function writeSettingsTabHash(tab: SettingsTabId): void {
  if (typeof window === "undefined") {
    return;
  }
  const nextHash = settingsTabHash(tab);
  const nextUrl = `${window.location.pathname}${window.location.search}${nextHash}`;
  window.history.replaceState(window.history.state, "", nextUrl);
}
