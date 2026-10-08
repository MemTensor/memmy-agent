// Observation settings decide what the background recorder is allowed to see.
//
// The model has two orthogonal axes rather than one list: an application axis
// keyed by bundle identifier, and a website axis keyed by bare domain. Each axis
// carries its own default, so "record everything except my bank" and "record
// nothing except my IDE" are both expressible. A browser page with a readable
// host has to satisfy both axes. A website block rule matches only that host:
// an unreadable address is not treated as every excluded domain.

export type ObservationBehavior = "observe" | "do_not_observe";

export interface ApplicationRule {
  scope: "app";
  bundleID: string;
  behavior: ObservationBehavior;
}

export interface UrlRule {
  scope: "url";
  /** Bare domain. Matches the domain itself and any subdomain of it. */
  urlDomain: string;
  behavior: ObservationBehavior;
}

export type ObservationRule = ApplicationRule | UrlRule;

export interface ObservationSettings {
  memory: { syncEnabled: boolean };
  observation: {
    defaultApplicationBehavior: ObservationBehavior;
    defaultURLBehavior: ObservationBehavior;
    rules: ObservationRule[];
  };
}

export interface ObservationSubject {
  bundleId?: string | null;
  /** Extra, explicit user consent for personal WeChat chat content. */
  weChatChatAccess?: boolean;
  /** The native recorder recognizes a browser even when URL lookup failed. */
  browser?: boolean;
  /** Absolute URL of the focused page, when the record has a usable one. */
  url?: string | null;
  /** A verified private browser window is excluded whatever the rules say. */
  privateBrowsing?: boolean;
  /** Windows browser privacy state is not yet verifiable per window. */
  privateBrowsingUnknown?: boolean;
}

export interface ObservationDecision {
  observe: boolean;
  /** Why the record was dropped, for status output and tests. */
  reason:
    | "observed"
    | "private_browsing"
    | "separate_source_consent"
    | "system_surface"
    | "wechat_consent_required"
    | "application_blocked"
    | "application_not_allowed"
    | "url_blocked"
    | "url_not_allowed";
}

// Observe by default and use the blocklist for exceptions.
//
// An allowlist default fails silently in the worst possible way: the UI says
// it is recording while nothing is written, and the gap is only discovered
// days later when the history is asked for and turns out to be empty. What
// protects the user here is the blocklist, pause, the exclusion of private
// windows, secure-input suppression, local-only storage and the retention
// window — none of which depend on which way this default points.
//
// Browser windows with an unknown private state are also excluded by the
// recorder, even when the application default is otherwise permissive.
export const DEFAULT_OBSERVATION_SETTINGS: ObservationSettings = {
  memory: { syncEnabled: true },
  observation: {
    defaultApplicationBehavior: "observe",
    defaultURLBehavior: "observe",
    rules: [],
  },
};

// The login window and the screen saver are what is in front while the Mac is
// locked or nobody is at it. Recording them wrote a summary of a locked screen
// for every window of the night.
const SYSTEM_SURFACE_BUNDLE_IDS = new Set(["com.apple.loginwindow", "com.apple.ScreenSaver.Engine"]);

// The same consent gates both native UI observation and the database reader.
export const SENSITIVE_MESSAGE_APP_BUNDLE_IDS = new Set([
  "com.tencent.xinwechat", "com.tencent.wechat",
  "win32.wechat", "win32.weixin",
]);

export const BROWSER_BUNDLE_IDS = new Set([
  "com.google.chrome", "com.google.chrome.canary", "com.apple.safari",
  "com.apple.safaritechnologypreview", "company.thebrowser.browser",
  "com.microsoft.edgemac", "com.brave.browser", "org.mozilla.firefox",
  "org.chromium.chromium", "com.operasoftware.opera", "com.vivaldi.vivaldi",
  "com.quark.desktop",
  // Windows process ids use the same lowercased form the observer emits.
  "win32.chrome", "win32.msedge", "win32.firefox", "win32.brave",
  "win32.vivaldi", "win32.opera", "win32.chromium", "win32.arc", "win32.quark",
]);

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
}

/** Returns the registrable host of an absolute http(s) URL, or null. */
export function hostFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const host = normalizeDomain(parsed.hostname);
    return host || null;
  } catch {
    return null;
  }
}

function withoutWww(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

function domainMatches(host: string, domain: string): boolean {
  const left = withoutWww(normalizeDomain(host));
  const right = withoutWww(normalizeDomain(domain));
  if (!left || !right) return false;
  return left === right || left.endsWith(`.${right}`);
}

// Bundle ids are compared without case: macOS sometimes differs only by case,
// and Windows ids are already lowercased. A helper bundled inside an excluded
// app (…ScreenShotHelper) follows the app the user actually picked.
function sameApplication(ruleId: string, subjectId: string): boolean {
  const rule = ruleId.trim().toLowerCase();
  const subject = subjectId.trim().toLowerCase();
  if (!rule || !subject) return false;
  if (rule === subject) return true;
  if (!subject.startsWith(`${rule}.`)) return false;
  return /(helper|agent|service|xpc|renderer|crash|gpu|plugin|screenshot)/iu.test(subject.slice(rule.length + 1));
}

// A block rule always wins inside its own axis, so an allowlist entry can never
// re-enable something the user explicitly excluded.
function resolveAxis(
  matching: ObservationRule[],
  fallback: ObservationBehavior,
): ObservationBehavior {
  if (matching.some((rule) => rule.behavior === "do_not_observe")) return "do_not_observe";
  if (matching.some((rule) => rule.behavior === "observe")) return "observe";
  return fallback;
}

export function evaluateObservation(
  settings: ObservationSettings,
  subject: ObservationSubject,
): ObservationDecision {
  if (subject.bundleId && SENSITIVE_MESSAGE_APP_BUNDLE_IDS.has(subject.bundleId.toLowerCase())
    && subject.weChatChatAccess !== true) {
    return { observe: false, reason: "wechat_consent_required" };
  }
  if (subject.privateBrowsing || subject.privateBrowsingUnknown) return { observe: false, reason: "private_browsing" };
  if (subject.bundleId && SYSTEM_SURFACE_BUNDLE_IDS.has(subject.bundleId)) {
    return { observe: false, reason: "system_surface" };
  }

  const { defaultApplicationBehavior, defaultURLBehavior, rules } = settings.observation;

  const appRules = rules.filter(
    (rule): rule is ApplicationRule =>
      rule.scope === "app" && Boolean(subject.bundleId) && sameApplication(rule.bundleID, subject.bundleId!),
  );
  const appBehavior = resolveAxis(appRules, defaultApplicationBehavior);
  if (appBehavior === "do_not_observe") {
    return {
      observe: false,
      reason: appRules.length ? "application_blocked" : "application_not_allowed",
    };
  }

  // Native apps have no website axis. A block rule can drop only a host it
  // matches, so a browser whose address bar was not read stays when the
  // website default is to observe. An allowlist default is the other case:
  // without a host the page cannot be shown to be one of the sites the user
  // chose to keep.
  const host = subject.url ? hostFromUrl(subject.url) : null;
  if (!host) {
    const browser = subject.browser || BROWSER_BUNDLE_IDS.has((subject.bundleId ?? "").toLowerCase());
    return browser && defaultURLBehavior === "do_not_observe"
      ? { observe: false, reason: "url_not_allowed" }
      : { observe: true, reason: "observed" };
  }

  const urlRules = rules.filter(
    (rule): rule is UrlRule => rule.scope === "url" && domainMatches(host, rule.urlDomain),
  );
  const urlBehavior = resolveAxis(urlRules, defaultURLBehavior);
  if (urlBehavior === "do_not_observe") {
    return { observe: false, reason: urlRules.length ? "url_blocked" : "url_not_allowed" };
  }
  return { observe: true, reason: "observed" };
}

export class ObservationSettingsError extends Error {}

function assertBehavior(value: unknown, field: string): ObservationBehavior {
  if (value !== "observe" && value !== "do_not_observe") {
    throw new ObservationSettingsError(
      `${field} must be "observe" or "do_not_observe"`,
    );
  }
  return value;
}

/**
 * Validates a complete settings document.
 *
 * Updates replace the whole document rather than merging, so a caller that
 * omits a rule deletes it. That is why the update tool requires a read first.
 */
export function parseObservationSettings(input: unknown): ObservationSettings {
  if (!input || typeof input !== "object") {
    throw new ObservationSettingsError("settings must be an object");
  }
  const observation = (input as { observation?: unknown }).observation;
  if (!observation || typeof observation !== "object") {
    throw new ObservationSettingsError("settings.observation is required");
  }
  const source = observation as Record<string, unknown>;
  const rawRules = source.rules ?? [];
  if (!Array.isArray(rawRules)) {
    throw new ObservationSettingsError("settings.observation.rules must be an array");
  }

  const rules = rawRules.map((rule, index): ObservationRule => {
    if (!rule || typeof rule !== "object") {
      throw new ObservationSettingsError(`rules[${index}] must be an object`);
    }
    const entry = rule as Record<string, unknown>;
    const behavior = assertBehavior(entry.behavior, `rules[${index}].behavior`);
    if (entry.scope === "app") {
      const bundleID = entry.bundleID;
      if (typeof bundleID !== "string" || !bundleID.trim()) {
        throw new ObservationSettingsError(`rules[${index}].bundleID is required for app rules`);
      }
      return { scope: "app", bundleID: bundleID.trim(), behavior };
    }
    if (entry.scope === "url") {
      const urlDomain = entry.urlDomain;
      if (typeof urlDomain !== "string" || !normalizeDomain(urlDomain)) {
        throw new ObservationSettingsError(`rules[${index}].urlDomain is required for url rules`);
      }
      if (/^[a-z]+:\/\//i.test(urlDomain) || urlDomain.includes("/")) {
        throw new ObservationSettingsError(
          `rules[${index}].urlDomain must be a bare domain, not a URL`,
        );
      }
      return { scope: "url", urlDomain: normalizeDomain(urlDomain), behavior };
    }
    throw new ObservationSettingsError(`rules[${index}].scope must be "app" or "url"`);
  });

  const memorySyncEnabled = (input as { memory?: { syncEnabled?: unknown } }).memory?.syncEnabled;
  return {
    memory: { syncEnabled: memorySyncEnabled === undefined || memorySyncEnabled === true },
    observation: {
      defaultApplicationBehavior: assertBehavior(
        source.defaultApplicationBehavior,
        "settings.observation.defaultApplicationBehavior",
      ),
      defaultURLBehavior: assertBehavior(
        source.defaultURLBehavior,
        "settings.observation.defaultURLBehavior",
      ),
      rules,
    },
  };
}
