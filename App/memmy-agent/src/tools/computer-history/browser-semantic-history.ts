import fs from "node:fs";
import { sanitizeBrowserUrl } from "./browser-privacy.js";
import { evaluateObservation, type ObservationSettings } from "./mac/observation-settings.js";
import { redactSensitive } from "./mac/redaction.js";

export type BrowserHistoryActor = "human" | "agent" | "unknown";
export type BrowserHistoryPhase = "attempt" | "observed" | "context";
export type BrowserHistoryAction = "click" | "input" | "change" | "submit" | "key" | "scroll" | "navigation";
export interface BrowserHistoryTarget {
  role?: string;
  name?: string;
  tag?: string;
  inputType?: string;
  autocomplete?: string;
  sensitive?: boolean;
  value?: string;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
}
export interface BrowserHistoryState {
  url?: string;
  title?: string;
  text?: string[];
  target?: BrowserHistoryTarget;
}
export interface BrowserSemanticHistoryEvent {
  version: 1;
  eventId: string;
  observedAt: number;
  generation: string;
  documentId: string;
  action: BrowserHistoryAction;
  phase?: BrowserHistoryPhase;
  interactionId?: string;
  target?: BrowserHistoryTarget;
  before?: BrowserHistoryState;
  after?: BrowserHistoryState;
  key?: string;
}
/** Constructed by the authenticated bridge using browser APIs, never page payload fields. */
export interface BrowserHistoryTrustedContext {
  connectionId: string;
  browser: "chrome" | "edge";
  tabId: number;
  windowId: number;
  url: string;
  frameUrl?: string;
  /** Origins of the frame's ancestors, parent to top; absent or empty for a top frame. */
  ancestorOrigins?: string[];
  documentId: string;
  privateBrowsing: boolean | null;
  protected: boolean;
  actorEvidence?: { kind: "memmy_command"; commandId: string; taskId?: string }
    | { kind: "native_input"; eventId: string };
}
export interface BrowserHistoryCaptureIntent {
  enabled: boolean;
  generation: string | null;
  settings: ObservationSettings | null;
  captureText: boolean;
}

const ACTIONS = new Set<BrowserHistoryAction>(["click", "input", "change", "submit", "key", "scroll", "navigation"]);
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/u.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const boundedString = (value: unknown, maximum: number) => value === undefined || (typeof value === "string" && value.length <= maximum);
function validTarget(value: unknown): value is BrowserHistoryTarget | undefined {
  if (value === undefined) return true;
  return object(value) && ["role", "tag", "inputType", "autocomplete"].every(key => boundedString(value[key], 100))
    && boundedString(value.name, 500) && boundedString(value.value, 4000)
    && ["sensitive", "checked", "selected", "expanded"].every(key => value[key] === undefined || typeof value[key] === "boolean");
}
function validState(value: unknown): value is BrowserHistoryState | undefined {
  if (value === undefined) return true;
  return object(value) && boundedString(value.url, 4096) && boundedString(value.title, 500)
    && (value.text === undefined || (Array.isArray(value.text) && value.text.length <= 40
      && value.text.every(line => typeof line === "string" && line.length <= 500))) && validTarget(value.target);
}
function sensitiveTarget(target: BrowserHistoryTarget | undefined): boolean {
  return !!target && (target.sensitive === true || /^(?:password|hidden)$/iu.test(target.inputType ?? "")
    || /(?:one-time-code|current-password|new-password|cc-number|cc-csc|cc-exp)/iu.test(target.autocomplete ?? "")
    || /(?:password|passcode|secret|token|otp|one[-_ ]?time|verification|cvv|cvc|card[-_ ]?(?:number|no)|验证码|动态码|校验码|安全码|密码|口令|密钥|卡号|身份证)/iu
      .test(target.name ?? ""));
}
function luhn(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}
function targetEvidence(target: BrowserHistoryTarget | undefined, captureText: boolean, sensitive: boolean): BrowserHistoryTarget | undefined {
  if (!target) return undefined;
  const clean: BrowserHistoryTarget = {};
  for (const key of ["role", "name", "tag", "inputType", "autocomplete"] as const) {
    if (typeof target[key] === "string") clean[key] = browserText(target[key]);
  }
  for (const key of ["checked", "selected", "expanded"] as const) {
    if (typeof target[key] === "boolean") clean[key] = target[key];
  }
  if (target.value !== undefined) clean.value = captureText && !sensitive ? browserText(target.value) : "[REDACTED]";
  if (sensitive) clean.sensitive = true;
  return clean;
}
function browserText(value: string): string {
  return redactSensitive(value)
    .replace(/((?:验证码|动态码|密码|口令|密钥)\s*[:：=]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/((?:otp|verification code|验证码|动态码|校验码)\s*[:：=]?\s*)\d{4,8}\b/giu, "$1[REDACTED]")
    .replace(/\b\d(?:[ -]?\d){12,18}\b/gu, match => luhn(match.replace(/\D/gu, "")) ? "[REDACTED]" : match);
}
function stateEvidence(state: BrowserHistoryState | undefined, captureText: boolean, sensitive: boolean): BrowserHistoryState | undefined {
  if (!state) return undefined;
  return {
    ...(state.url !== undefined ? { url: redactSensitive(sanitizeBrowserUrl(state.url)) } : {}),
    ...(state.title !== undefined ? { title: sensitive ? "[REDACTED]" : browserText(state.title) } : {}),
    ...(state.text !== undefined ? { text: sensitive || !captureText ? ["[REDACTED]"] : state.text.map(browserText) } : {}),
    ...(state.target ? { target: targetEvidence(state.target, captureText, sensitive || sensitiveTarget(state.target)) } : {}),
  };
}
/** Matches the native observer's app identity, so one browsing session stays one activity block. */
export function browserHistoryApplication(browser: "chrome" | "edge", platform: NodeJS.Platform = process.platform) {
  if (platform === "win32") {
    return browser === "edge" ? { name: "msedge", bundleId: "win32.msedge" } : { name: "chrome", bundleId: "win32.chrome" };
  }
  return { name: browser === "edge" ? "Microsoft Edge" : "Google Chrome",
    bundleId: browser === "edge" ? "com.microsoft.edgemac" : "com.google.Chrome" };
}

/** Reject page-supplied permission/actor claims; authorize against the live History intent. */
export function prepareBrowserHistoryEvent(payload: unknown, context: BrowserHistoryTrustedContext,
  intent: BrowserHistoryCaptureIntent, now = Date.now(), platform: NodeJS.Platform = process.platform) {
  if (!intent.enabled || !intent.settings || !intent.generation || !object(payload) || payload.version !== 1
    || !id(payload.eventId) || !id(payload.documentId) || payload.documentId !== context.documentId
    || payload.generation !== intent.generation || !ACTIONS.has(payload.action as BrowserHistoryAction)
    || typeof payload.observedAt !== "number" || !Number.isFinite(payload.observedAt)
    || payload.observedAt > now + 1000 || payload.observedAt < now - 15_000
    || !validTarget(payload.target) || !validState(payload.before) || !validState(payload.after)
    || !boundedString(payload.key, 80) || !id(context.connectionId)
    || !["chrome", "edge"].includes(context.browser) || !Number.isSafeInteger(context.tabId) || context.tabId < 0
    || !Number.isSafeInteger(context.windowId) || context.windowId < 0 || context.privateBrowsing !== false
    || context.protected !== false) return null;
  const phase = payload.phase ?? "observed";
  if (!["attempt", "observed", "context"].includes(String(phase))
    || (payload.interactionId !== undefined && !id(payload.interactionId))
    || (phase === "attempt" && (!["click", "key"].includes(String(payload.action)) || payload.after !== undefined
      || typeof (payload.before as BrowserHistoryState | undefined)?.url !== "string"))
    || (phase === "context" && (payload.action !== "navigation" || payload.before !== undefined
      || typeof (payload.after as BrowserHistoryState | undefined)?.url !== "string"))) return null;
  const application = browserHistoryApplication(context.browser, platform);
  const url = sanitizeBrowserUrl(context.url), frameUrl = sanitizeBrowserUrl(context.frameUrl ?? context.url);
  const ancestors = (context.ancestorOrigins ?? []).map(origin => sanitizeBrowserUrl(origin));
  if (!url || !frameUrl || !ancestors.every(Boolean)) return null;
  const states = [payload.before, payload.after] as Array<BrowserHistoryState | undefined>;
  const urls = [url, frameUrl, ...ancestors];
  for (const state of states) {
    if (state?.url !== undefined) {
      const stateUrl = sanitizeBrowserUrl(state.url);
      // A page payload cannot claim to have observed another site's content.
      if (!stateUrl || new URL(stateUrl).origin !== new URL(frameUrl).origin) return null;
      urls.push(stateUrl);
    }
  }
  if (!urls.every(page => evaluateObservation(intent.settings!, {
    bundleId: application.bundleId, browser: true, url: page,
    privateBrowsing: false, privateBrowsingUnknown: false,
  }).observe)) return null;
  const target = payload.target as BrowserHistoryTarget | undefined;
  const sensitive = [target, ...states.map(state => state?.target)].some(sensitiveTarget);
  const actorEvidence = context.actorEvidence;
  const actor: BrowserHistoryActor = actorEvidence?.kind === "memmy_command" && id(actorEvidence.commandId) ? "agent"
    : actorEvidence?.kind === "native_input" && id(actorEvidence.eventId) ? "human" : "unknown";
  const details = {
    source: "browser_history", actor, browser: context.browser,
    eventId: payload.eventId, documentId: context.documentId, tabId: context.tabId, windowId: context.windowId,
    url: redactSensitive(url), ...(frameUrl !== url ? { frameUrl: redactSensitive(frameUrl) } : {}),
    action: payload.action as BrowserHistoryAction,
    phase: phase as BrowserHistoryPhase,
    ...(typeof payload.interactionId === "string" ? { interactionId: payload.interactionId } : {}),
    ...(target ? { target: targetEvidence(target, intent.captureText, sensitive) } : {}),
    ...(payload.before ? { before: stateEvidence(payload.before as BrowserHistoryState, intent.captureText, sensitive) } : {}),
    ...(payload.after ? { after: stateEvidence(payload.after as BrowserHistoryState, intent.captureText, sensitive) } : {}),
    ...(typeof payload.key === "string" ? { key: sensitive || payload.key.length === 1 ? "[REDACTED]" : redactSensitive(payload.key) } : {}),
    ...(actor === "agent" && actorEvidence?.kind === "memmy_command" ? {
      commandId: actorEvidence.commandId, ...(id(actorEvidence.taskId) ? { taskId: actorEvidence.taskId } : {}),
    } : {}),
  };
  const event = { recordType: "human_event", eventType: "browser_action",
    timestamp: new Date(payload.observedAt).toISOString(), application, details };
  // Bound each append and never pass arbitrary DOM fields into the durable stream.
  if (JSON.stringify(event).length > 48_000) return null;
  return { event, deduplicationKey: `${context.connectionId}:${context.tabId}:${context.documentId}:${payload.eventId}` };
}

/** Same canonical event stream as native capture and WeChat; no separate learning store. */
export function appendBrowserHistoryEvent(eventsFile: string,
  prepared: NonNullable<ReturnType<typeof prepareBrowserHistoryEvent>>): void {
  fs.appendFileSync(eventsFile, `${JSON.stringify(prepared.event)}\n`, { encoding: "utf8", mode: 0o600 });
}
