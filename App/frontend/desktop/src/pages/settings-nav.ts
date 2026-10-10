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

/** Deep-link that opens Token settings and scrolls to the memory budget card. */
export const SETTINGS_MEMORY_BUDGET_HASH = "#token-usage-memory-budget";
/** Same-window event used when Settings is already mounted. */
export const SETTINGS_MEMORY_BUDGET_EVENT = "memmy:settings-focus-memory-budget";
/** Section id for the memory task limit card. */
export const MEMORY_TOKEN_BUDGET_SECTION_ID = "memory-token-budget";
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
    case SETTINGS_MEMORY_BUDGET_HASH:
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

/** Whether the hash should scroll to and highlight the memory budget card. */
export function shouldFocusMemoryBudgetFromHash(hash: string): boolean {
  return hash === SETTINGS_MEMORY_BUDGET_HASH;
}

/** Opens Token usage and asks Settings to locate the memory budget card. */
export function writeSettingsMemoryBudgetFocus(): void {
  if (typeof window === "undefined") {
    return;
  }
  const nextUrl = `${window.location.pathname}${window.location.search}${SETTINGS_MEMORY_BUDGET_HASH}`;
  window.history.replaceState(window.history.state, "", nextUrl);
  window.dispatchEvent(new CustomEvent(SETTINGS_MEMORY_BUDGET_EVENT));
}

/**
 * Scrolls a settings section inside its own pane so the titlebar does not clip it.
 * Does not call `scrollIntoView`, which also moves ancestor panes and hides the page top.
 */
export function scrollSettingsSectionIntoView(element: HTMLElement): void {
  const scroller = findSettingsScroller(element);
  resetSettingsOuterScroll(element, scroller);
  if (!scroller) {
    return;
  }

  const toolbarHeight = readToolbarHeight(element);
  const gap = 12;
  const elementTop = offsetTopWithin(element, scroller);
  const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const nextTop = Math.min(Math.max(0, elementTop - toolbarHeight - gap), maxTop);
  if (typeof scroller.scrollTo === "function") {
    scroller.scrollTo({ top: nextTop, behavior: "auto" });
  } else {
    scroller.scrollTop = nextTop;
  }
}

/** Clears leftover ancestor offsets so the settings page can reach its own top. */
export function resetSettingsOuterScroll(element: HTMLElement, innerScroller: HTMLElement | null = element): void {
  let current = element.parentElement;
  while (current) {
    if (current !== innerScroller) {
      current.scrollTop = 0;
    }
    current = current.parentElement;
  }
  const doc = element.ownerDocument;
  if (doc.documentElement !== innerScroller) {
    doc.documentElement.scrollTop = 0;
  }
  if (doc.body !== innerScroller) {
    doc.body.scrollTop = 0;
  }
  const scrollingElement = doc.scrollingElement;
  if (scrollingElement instanceof HTMLElement && scrollingElement !== innerScroller) {
    scrollingElement.scrollTop = 0;
  }
}

function findSettingsScroller(element: HTMLElement): HTMLElement | null {
  const settingsPage = element.closest(".settings-page");
  if (settingsPage instanceof HTMLElement) {
    return settingsPage;
  }

  let current = element.parentElement;
  while (current) {
    const overflowY = current.ownerDocument.defaultView?.getComputedStyle(current).overflowY
      || current.style.overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function offsetTopWithin(element: HTMLElement, scroller: HTMLElement): number {
  const elementRect = element.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  return elementRect.top - scrollerRect.top + scroller.scrollTop;
}

function readToolbarHeight(element: HTMLElement): number {
  const raw = element.ownerDocument.defaultView
    ?.getComputedStyle(element)
    .getPropertyValue("--codex-toolbar-height")
    .trim();
  const parsed = Number.parseFloat(raw ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 46;
}
