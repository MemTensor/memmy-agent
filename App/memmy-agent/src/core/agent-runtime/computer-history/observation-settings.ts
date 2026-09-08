// Observation settings decide what the background recorder is allowed to see.
//
// The model has two orthogonal axes rather than one list: an application axis
// keyed by bundle identifier, and a website axis keyed by bare domain. Each axis
// carries its own default, so "record everything except my bank" and "record
// nothing except my IDE" are both expressible, and a browser record has to
// satisfy both axes before it is kept.

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
  observation: {
    defaultApplicationBehavior: ObservationBehavior;
    defaultURLBehavior: ObservationBehavior;
    rules: ObservationRule[];
  };
}

export interface ObservationSubject {
  bundleId?: string | null;
  /** Absolute URL of the focused page, when the record has a usable one. */
  url?: string | null;
  /** Private browsing is excluded unconditionally, whatever the rules say. */
  privateBrowsing?: boolean;
}

export interface ObservationDecision {
  observe: boolean;
  /** Why the record was dropped, for status output and tests. */
  reason:
    | "observed"
    | "private_browsing"
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
// protects the user here is the blocklist, pause, the unconditional private
// browsing exclusion, secure-input suppression, local-only storage and the
// retention window — none of which depend on which way this default points.
export const DEFAULT_OBSERVATION_SETTINGS: ObservationSettings = {
  observation: {
    defaultApplicationBehavior: "observe",
    defaultURLBehavior: "observe",
    rules: [],
  },
};

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

function domainMatches(host: string, domain: string): boolean {
  const normalized = normalizeDomain(domain);
  if (!normalized) return false;
  return host === normalized || host.endsWith(`.${normalized}`);
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
  if (subject.privateBrowsing) return { observe: false, reason: "private_browsing" };

  const { defaultApplicationBehavior, defaultURLBehavior, rules } = settings.observation;

  const appRules = rules.filter(
    (rule): rule is ApplicationRule =>
      rule.scope === "app" && Boolean(subject.bundleId) && rule.bundleID === subject.bundleId,
  );
  const appBehavior = resolveAxis(appRules, defaultApplicationBehavior);
  if (appBehavior === "do_not_observe") {
    return {
      observe: false,
      reason: appRules.length ? "application_blocked" : "application_not_allowed",
    };
  }

  // A record without a usable URL is judged by its application alone.
  const host = subject.url ? hostFromUrl(subject.url) : null;
  if (!host) return { observe: true, reason: "observed" };

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

  return {
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
