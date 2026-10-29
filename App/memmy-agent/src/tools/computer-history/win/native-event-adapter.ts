import { resolveBrowserContext, sanitizeBrowserUrl, type BrowserAuthoritySnapshot } from "../browser-privacy.js";
import { BROWSER_BUNDLE_IDS } from "../mac/observation-settings.js";
import { redactSensitive } from "../mac/redaction.js";

type NativeEvent = Record<string, any>;

/** Keep the extension authority as corroboration for normal pages. Native
 * foreground/committed-address proof is sufficient for History events in any
 * browsing mode; privacy mode does not veto the whole window. */
export function applyWindowsBrowserPrivacy(event: NativeEvent, authority: BrowserAuthoritySnapshot | null,
  now = Date.now()): void {
  const app = event.app ?? event.application ?? {};
  const bundleId = app.bundleIdentifier ?? app.bundleId ?? "";
  if (event.window?.browser !== true && !BROWSER_BUNDLE_IDS.has(String(bundleId).toLowerCase())) return;
  const window = event.window ?? (event.window = {});
  window.browser = true;
  const windowId = typeof (window.windowId ?? window.id) === "string" ? window.windowId ?? window.id : undefined;
  const processId = Number.isSafeInteger(app.pid) ? app.pid : undefined;
  const native = window.browserContext;
  const nativeUrl = native && native.windowId === windowId && native.processId === processId
    && native.documentUrl === native.url && typeof native.url === "string"
    ? sanitizeBrowserUrl(native.url) : "";
  const result = resolveBrowserContext({
    browserName: app.name ?? bundleId,
    title: typeof window.title === "string" ? window.title : "",
    axText: typeof event.ax?.text === "string" ? event.ax.text : "",
    nativeContext: native,
    windowId,
    processId,
    authority,
    now,
  });
  // The native recorder already checked foreground identity, committed URI,
  // secure inputs, and WeChat consent before this event reached the adapter.
  delete window.privateBrowsing;
  delete window.privateBrowsingUnknown;
  delete window.url;
  // A contradictory focused extension tab can invalidate an otherwise
  // normal native URL. Private/unknown mode alone never rejects the event.
  if (nativeUrl && result.source !== "extension_mismatch") window.url = nativeUrl;
}

const categories = new Set(["typing", "submit", "shortcut", "navigation", "delete"]);
const semanticKeys: Record<string, string> = { submit: "return", shortcut: "shortcut", navigation: "navigation", delete: "backspace" };

function actionTarget(target: NativeEvent | undefined): Record<string, string> | null {
  if (!target || typeof target !== "object") return null;
  const result: Record<string, string> = {};
  for (const key of ["role", "subrole", "name", "description", "identifier"]) {
    if (typeof target[key] === "string") result[key] = redactSensitive(target[key].slice(0, 320));
  }
  return result;
}

/** Earlier controls are context for an input, never a verified click target. */
export function previousControlsAtPoint(value: unknown, actionTimestamp: unknown): {
  observedAt: string;
  controls: Record<string, string>[];
  interpretation: "previously_observed_not_confirmed_target";
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof actionTimestamp !== "string") return null;
  const source = value as Record<string, unknown>;
  if (source.interpretation !== "previously_observed_not_confirmed_target" || typeof source.observedAt !== "string"
    || !Array.isArray(source.controls) || source.controls.length < 1 || source.controls.length > 3) return null;
  const at = Date.parse(actionTimestamp), before = Date.parse(source.observedAt);
  if (!Number.isFinite(at) || !Number.isFinite(before) || before > at || at - before > 5_000) return null;
  const controls = source.controls.flatMap((control) => {
    if (!control || typeof control !== "object" || Array.isArray(control)) return [];
    const candidate = control as Record<string, unknown>;
    if (candidate.role === "AXSecureTextField" || candidate.subrole === "AXSecureTextField"
      || candidate.isPassword === true || candidate.IsPassword === true) return [];
    const projected: Record<string, string> = {};
    for (const field of ["role", "name", "title", "identifier"]) {
      if (typeof candidate[field] === "string") projected[field] = redactSensitive(candidate[field].slice(0, 320));
    }
    return Object.keys(projected).length ? [projected] : [];
  });
  return controls.length ? { observedAt: new Date(before).toISOString(), controls,
    interpretation: "previously_observed_not_confirmed_target" } : null;
}

/** Windows hooks report actions and counts; they never carry raw character data. */
export function normalizeWindowsKeyboardAction(event: NativeEvent,
  searchContext: { purpose: string; role: string; label: string } | null,
  captureSearchText: boolean, captureOrdinaryText = false): {
    eventType: "text_input" | "key_press";
    details: Record<string, unknown>;
  } | null {
  if (event.kind !== "keyboard.keydown" || event.app?.secureInput === true) return null;
  const keyboard = event.keyboard;
  if (!keyboard || !categories.has(keyboard.category)
    || !Number.isSafeInteger(keyboard.count) || keyboard.count < 1 || keyboard.count > 10000) return null;
  const target = keyboard.target;
  if (target?.role === "AXSecureTextField" || target?.subrole === "AXSecureTextField"
    || target?.isPassword === true || target?.IsPassword === true) return null;
  if (keyboard.category !== "typing") {
    return { eventType: "key_press", details: {
      keys: [semanticKeys[keyboard.category]], actionCount: keyboard.count,
      ...(actionTarget(target) ? { accessibility: actionTarget(target) } : {}),
    } };
  }
  // UIA supplies the focused control's current value, not the characters in
  // this key burst. The native worker has already checked the foreground,
  // focus and password ancestry before attaching this value.
  const retainValue = captureOrdinaryText || (captureSearchText && searchContext !== null);
  const value = retainValue && typeof target?.value === "string" && target.value.length > 0
    ? redactSensitive(target.value.slice(0, 1000)) : null;
  const readableValue = value && value !== "[REDACTED]" ? value : null;
  return { eventType: "text_input", details: {
    actionCount: keyboard.count, characterCount: 0,
    text: readableValue ?? "[REDACTED]", redacted: readableValue === null,
    ...(readableValue !== null ? { textSource: "focused_field_value" } : {}),
    ...(readableValue !== null && captureSearchText && searchContext
      ? { textPurpose: "search_query", input: searchContext } : {}),
    ...(actionTarget(target) ? { accessibility: actionTarget(target) } : {}),
  } };
}
