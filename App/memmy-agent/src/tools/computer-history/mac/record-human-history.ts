// Record authorized foreground activity as a local JSONL event stream.

import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { redactSensitive } from "./redaction.js";
import { captureGapRecord, nativeRecorderDiagnostic, recorderHealthReporter } from "./recorder-health.js";
import { historyNativeCommand } from "./native-helper.js";
import { WeChatHistoryConsentStore, defaultWeChatConsentFile } from "./wechat-consent.js";
import { isWindows11, windowsObserverCommand } from "../win/win11.js";
import { readBrowserAuthority } from "../browser-privacy.js";
import { applyWindowsBrowserPrivacy, normalizeWindowsKeyboardAction, previousControlsAtPoint } from "../win/native-event-adapter.js";

import {
  BROWSER_BUNDLE_IDS,
  DEFAULT_OBSERVATION_SETTINGS,
  SENSITIVE_MESSAGE_APP_BUNDLE_IDS,
  evaluateObservation,
  parseObservationSettings,
  type ObservationSettings,
  type ObservationSubject,
} from "./observation-settings.js";

export const WINDOWS_HISTORY_STREAM_DISCONNECT = "Memmy Windows History stream disconnected unexpectedly.";

/** Keep the native disconnect protocol on its own line for the parent service. */
export function recorderFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message === WINDOWS_HISTORY_STREAM_DISCONNECT ? message : `human history recording failed: ${message}`;
}

/** A line from the Swift helper. Its fields depend on `kind`. */
type HelperEvent = Record<string, any>;

interface Application {
  name?: string;
  bundleId?: string;
}

export interface RecorderArgs {
  allowApps: string[];
  onlyApps: string[];
  captureText: boolean;
  captureSearchText: boolean;
  screenshots: boolean;
  title?: string;
  out?: string;
  recordingsDir?: string;
  contextUrl?: string;
  observationSettings?: string;
  /** Windows only: authoritative browser tab state from the extension bridge. */
  browserAuthority?: string;
  help?: boolean;
}

interface SearchInputContext {
  purpose: "search_query";
  role: string;
  label: string;
}

interface NormalizedEvent {
  eventType: string;
  application: Application;
  details: Record<string, unknown>;
}

interface RecorderPermissions {
  inputMonitoring: boolean;
  screenRecording: boolean;
  accessibility: boolean;
  mainDisplayWidth: number;
  mainDisplayHeight: number;
}

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// Source installs compile this file; desktop packages ship a native executable.
const HELPER_SOURCE = path.join(SCRIPT_DIR, "human-recorder.swift");
// Where the service keeps recordings. This was once resolved against the
// repository root, which a packaged app does not have.
const DEFAULT_RECORDINGS_DIR = path.join(os.homedir(), ".memmy", "computer-history", "recordings");
const TEXT_IDLE_MS = 700;
const NAVIGATION_SETTLE_MS = 900;

function usage(): void {
  console.log(`Usage:
  node dist/tools/computer-history/mac/record-human-history.js [options]

Options:
  --title <text>          recording goal shown in the History Markdown
  --out <events.jsonl>    explicit output path
  --recordings-dir <dir>  generated recording root
  --context-url <url>     approved starting page recorded without query or fragment
  --capture-search-text   retain text typed into recognized search/address fields
  --capture-text          retain text in observed applications and non-password controls
  --allow-app <bundle-id> restrict retained text to this application; repeatable
  --only-app <bundle-id>  record events only from this approved app; repeatable
  --no-screenshots        record events without key screenshots
  --help                  show this help

Press control+option+cmd+r while the result remains visible to stop recording.
Returning to this terminal and pressing Enter (or Ctrl+C) is also supported.`);
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function parseArgs(argv: string[]): RecorderArgs {
  const args: RecorderArgs = {
    allowApps: [],
    onlyApps: [],
    captureText: false,
    captureSearchText: false,
    screenshots: true,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next || next.startsWith("--")) throw new Error(`${key} requires a value`);
      return next;
    };
    if (key === "--title") args.title = value();
    else if (key === "--out") args.out = value();
    else if (key === "--recordings-dir") args.recordingsDir = value();
    else if (key === "--context-url") args.contextUrl = value();
    else if (key === "--capture-search-text") args.captureSearchText = true;
    else if (key === "--capture-text") args.captureText = true;
    else if (key === "--allow-app") args.allowApps.push(value());
    else if (key === "--only-app") args.onlyApps.push(value());
    else if (key === "--observation-settings") args.observationSettings = value();
    else if (key === "--browser-authority") args.browserAuthority = value();
    else if (key === "--no-screenshots") args.screenshots = false;
    else if (key === "--help" || key === "-h") args.help = true;
    else throw new Error(`unknown argument: ${key}`);
  }
  return args;
}

function timestampForPath(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(":", "-");
}

function defaultOutput(args: RecorderArgs, recordingId: string): string {
  const recordingsDir = path.resolve(expandHome(args.recordingsDir ?? DEFAULT_RECORDINGS_DIR));
  return path.join(recordingsDir, `${timestampForPath()}-${recordingId.slice(0, 8)}`, "events.jsonl");
}

function normalizedContextUrl(value: string | undefined): string | null {
  if (!value) return null;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("--context-url must use http or https");
  if (url.username || url.password) throw new Error("--context-url must not contain credentials");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function appAllowed(application: Application | undefined, allowedApps: string[]): boolean {
  return Boolean(application?.bundleId && allowedApps.includes(application.bundleId));
}

// The recorder emits Codex-shaped envelopes (app.bundleIdentifier / app.name).
// The history JSONL keeps its own {name, bundleId} shape so summarize-history
// and its fixtures stay valid.
export function appFrom(event: HelperEvent | undefined): Application {
  const app = event?.app ?? {};
  const application: Application = {};
  if (typeof app.name === "string") application.name = app.name;
  if (typeof app.bundleIdentifier === "string") application.bundleId = app.bundleIdentifier;
  return application;
}

export function isSecureInput(event: HelperEvent | undefined): boolean {
  return event?.app?.secureInput === true
    || isPasswordTarget(event?.keyboard?.target ?? event?.selection?.target);
}

function focusedTarget(accessibility: unknown): Record<string, unknown> | null {
  if (!accessibility || typeof accessibility !== "object") return null;
  const value = accessibility as Record<string, unknown>;
  const focused = value.focused;
  return focused && typeof focused === "object" && !Array.isArray(focused)
    ? focused as Record<string, unknown> : value;
}

function isPasswordTarget(accessibility: unknown): boolean {
  if (!accessibility || typeof accessibility !== "object") return false;
  const outer = accessibility as Record<string, unknown>;
  const focused = focusedTarget(accessibility);
  const isPasswordNode = (node: Record<string, unknown> | null): boolean =>
    node?.role === "AXSecureTextField" || node?.subrole === "AXSecureTextField"
      || node?.isPassword === true || node?.IsPassword === true;
  return isPasswordNode(outer) || isPasswordNode(focused);
}

const SEARCH_INPUT_ROLES = new Set(["AXSearchField"]);
const SEARCHABLE_TEXT_INPUT_ROLES = new Set(["AXTextField", "AXComboBox"]);
const SEARCH_INPUT_HINT = /(?:\bsearch\b|\bquery\b|\bfind\b|address and search|搜索|检索|查找)/iu;

export function searchInputContextFromAccessibility(accessibility: any): SearchInputContext | null {
  if (!accessibility || typeof accessibility !== "object") return null;
  // Only the current target (or its explicitly focused element) grants text
  // retention. A search field elsewhere in a window is not evidence of focus.
  const node = focusedTarget(accessibility);
  if (!node || typeof node !== "object") return null;
  const role = typeof node.role === "string" ? node.role : "";
  const subrole = typeof node.subrole === "string" ? node.subrole : "";
  if (isPasswordTarget(node)) return null;
  const label = [node.title, node.description, node.identifier]
    .filter((value) => typeof value === "string")
    .join(" ")
    .trim();
  if (
    SEARCH_INPUT_ROLES.has(role)
    || SEARCH_INPUT_ROLES.has(subrole)
    || (SEARCHABLE_TEXT_INPUT_ROLES.has(role) && SEARCH_INPUT_HINT.test(label))
  ) {
    return { purpose: "search_query", role: subrole || role, label: label.slice(0, 240) };
  }
  return null;
}

const REDACTED = "[REDACTED]";

// What a window shows is what Computer History exists to read, so a control's
// text is kept. Withholding every text area's value was tried and emptied the
// summaries: a text area is as often a terminal, a transcript or a document as
// a draft. What is withheld is what is never content — a password field — and
// credential patterns wherever they appear.
function keepsFieldValue(role: string, subrole: string, isPassword = false): boolean {
  return role !== "AXSecureTextField" && subrole !== "AXSecureTextField" && !isPassword;
}

function isDockTarget(role: string, subrole: string): boolean {
  return role === "AXDockItem" || subrole.endsWith("WindowDockItem")
    || subrole === "AXApplicationDockItem";
}

/**
 * Scrubs an accessibility payload before it is written: all content fields
 * of a password control are withheld, and credentials are masked elsewhere.
 */
export function scrubAccessibility(value: unknown): unknown {
  if (typeof value === "string") return redactSensitive(value);
  if (Array.isArray(value)) return value.map((item) => scrubAccessibility(item));
  if (!value || typeof value !== "object") return value;
  const node = value as Record<string, unknown>;
  const role = typeof node.role === "string" ? node.role : "";
  const subrole = typeof node.subrole === "string" ? node.subrole : "";
  // Dock labels can identify an excluded application or a private browser's
  // minimized window, even when the click belongs to an allowed foreground
  // app. Older helpers do not carry the target's own observation policy.
  if (isDockTarget(role, subrole)) return { role: "AXUnknown" };
  if (!keepsFieldValue(role, subrole, node.isPassword === true || node.IsPassword === true)) {
    // Providers can expose a password in Name/Description or a generic child,
    // not just Value. Discard the entire node payload before persistence.
    return { role: role || "AXSecureTextField", subrole: "AXSecureTextField", value: REDACTED };
  }
  const scrubbed: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(node)) {
    scrubbed[key] = scrubAccessibility(field);
  }
  return scrubbed;
}

// A window snapshot line is `role|subrole|title|description|identifier|value`,
// prefixed with `+ ` or `- ` when the snapshot is a diff.
function scrubTreeLine(line: string): string {
  const prefix = /^[+-] /u.test(line) ? line.slice(0, 2) : "";
  const parts = line.slice(prefix.length).split("|");
  const [role = "", subrole = ""] = parts;
  if (isDockTarget(role, subrole)) return `${prefix}AXUnknown|||||`;
  if (!keepsFieldValue(role, subrole)) {
    return `${prefix}${role || "AXSecureTextField"}|AXSecureTextField||||${REDACTED}`;
  }
  return prefix + redactSensitive(parts.join("|"));
}

/** Scrubs a window snapshot, full or diff, line by line. */
export function scrubAxSnapshot(ax: unknown): unknown {
  if (!ax || typeof ax !== "object") return ax;
  const snapshot = ax as Record<string, unknown>;
  if (typeof snapshot.text !== "string") return scrubAccessibility(ax);
  return {
    // A full native snapshot can also carry a focused control with its own
    // raw value. Scrub that envelope as well as the serialized tree lines.
    ...scrubAccessibility(snapshot) as Record<string, unknown>,
    text: snapshot.text.split("\n").map((line) => scrubTreeLine(line)).join("\n"),
  };
}

interface AxBaseline {
  windowKey: string;
  lines: string[];
  observedAt?: string;
  truncated?: boolean;
  readFailures?: number;
}

function prepareAuthorizedAxSnapshot(ax: unknown, previous: AxBaseline | null): {
  snapshot: Record<string, unknown> | null;
  baseline: AxBaseline | null;
} {
  const current = scrubAxSnapshot(ax) as Record<string, unknown> | null;
  // Action envelopes may carry only focus/window identity. They contain no
  // replacement tree and must not erase an already-authorized baseline.
  if (current && !("mode" in current) && !("text" in current)) return { snapshot: null, baseline: previous };
  // Only complete native observations can establish permission to store text.
  // Legacy/unknown diffs may contain removed text from an excluded interval.
  if (current?.mode !== "fullTree" || typeof current.text !== "string") {
    return { snapshot: null, baseline: null };
  }
  const lines = current.text.split("\n");
  const baseline = typeof current.windowKey === "string"
    ? { windowKey: current.windowKey, lines,
      ...(typeof current.observedAt === "string" && Number.isFinite(Date.parse(current.observedAt))
        ? { observedAt: new Date(current.observedAt).toISOString() } : {}),
      ...(typeof current.truncated === "boolean" ? { truncated: current.truncated } : {}),
      ...(typeof current.readFailures === "number" ? { readFailures: current.readFailures } : {}) } : null;
  if (!baseline || previous?.windowKey !== baseline.windowKey) return { snapshot: current, baseline };
  // A complete read can have the same text as an earlier partial one. Keep
  // that change in coverage instead of deduplicating its recovery evidence.
  if (previous.truncated !== baseline.truncated || previous.readFailures !== baseline.readFailures) {
    return { snapshot: current, baseline };
  }
  if (previous.lines.length === lines.length && previous.lines.every((line, index) => line === lines[index])) {
    return { snapshot: null, baseline };
  }
  const before = new Set(previous.lines);
  const after = new Set(lines);
  const removed = previous.lines.filter((line) => !after.has(line));
  const added = lines.filter((line) => !before.has(line));
  const changed = removed.length + added.length;
  // Reordering/duplicate rows cannot be represented by a set-based diff.
  if (!changed || before.size !== previous.lines.length || after.size !== lines.length
    || changed > Math.max(lines.length, 1) * 0.6) return { snapshot: current, baseline };
  return { snapshot: { ...current, mode: "diffFromPrevious",
    text: [...removed.map((line) => `- ${line}`), ...added.map((line) => `+ ${line}`)].join("\n") }, baseline };
}

// The recorder now classifies keystrokes itself, so the consumer no longer has
// to infer printability from modifiers: a keyboard.text_input event is text by
// construction, and secure-input windows never produce one.

// The recorder decides with the same policy the service and the agent tools
// describe. It used to carry a copy, because as a standalone script it could
// not import one, and the copy drifted: it lacked the unconditional
// exclusions, and read a missing default as "record nothing".
function loadObservationSettings(file: string | undefined): ObservationSettings {
  if (!file) return DEFAULT_OBSERVATION_SETTINGS;
  try {
    return parseObservationSettings(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    // An explicit policy that is temporarily unreadable must not revert to
    // recording everything. The next event retries the current file.
    return { memory: { syncEnabled: false }, observation: {
      defaultApplicationBehavior: "do_not_observe",
      defaultURLBehavior: "do_not_observe",
      rules: [],
    } };
  }
}

function observationSubject(event: HelperEvent): ObservationSubject {
  return {
    bundleId: appFrom(event).bundleId,
    browser: event.window?.browser === true,
    url: typeof event.window?.url === "string" ? event.window.url : null,
  };
}

export function shouldObserve(settings: ObservationSettings | null, subject: ObservationSubject): boolean {
  return evaluateObservation(settings ?? DEFAULT_OBSERVATION_SETTINGS, subject).observe;
}

function printableKey(event: HelperEvent): boolean {
  return event?.kind === "keyboard.text_input"
    && typeof event.keyboard?.text === "string"
    && event.keyboard.text.length > 0;
}

function textAllowedInApplication(application: Application, allowedApps: string[]): boolean {
  return allowedApps.length === 0 || appAllowed(application, allowedApps);
}

export function normalizeKeyBurst(
  events: HelperEvent[],
  // Search-field retention is opt-in, and absent means off.
  options: Pick<RecorderArgs, "captureText" | "allowApps"> & { captureSearchText?: boolean },
): NormalizedEvent {
  const application = appFrom(events.at(-1));
  const rawText = events.filter(printableKey).map((event) => event.keyboard.text).join("");
  const searchInput: SearchInputContext | null = events.length > 0
    && events.every((event) => event.inputContext?.purpose === "search_query")
    ? events.at(-1)!.inputContext
    : null;
  const retainText = events.every((event) => !isSecureInput(event))
    && textAllowedInApplication(application, options.allowApps)
    && (options.captureText || (options.captureSearchText && searchInput));
  if (rawText && events.every(printableKey)) {
    return {
      eventType: "text_input",
      application,
      details: retainText
        ? {
            text: redactSensitive(rawText),
            characterCount: [...rawText].length,
            redacted: false,
            ...(searchInput ? { textPurpose: "search_query", input: searchInput } : {}),
          }
        : { text: "[REDACTED]", characterCount: [...rawText].length, redacted: true },
    };
  }
  const keys = events.map((event) => {
    const keyboard = event.keyboard ?? {};
    const modifiers = keyboard.modifiers ?? [];
    const key = event.kind === "keyboard.submit" ? "return" : keyboard.keyEquivalent;
    // Defense in depth for helpers recorded before Shift/Option text was
    // classified correctly. Such characters must obey the text policy too.
    if (typeof key === "string" && [...key].length === 1
      && !modifiers.some((modifier: string) => modifier === "cmd" || modifier === "control")) {
      return "[REDACTED]";
    }
    return [...modifiers, key].filter(Boolean).join("+");
  });
  return { eventType: "key_press", application, details: { keys } };
}

export function isStopHotkey(event: HelperEvent | undefined): boolean {
  const modifiers = new Set(event?.keyboard?.modifiers ?? []);
  return event?.kind === "keyboard.shortcut"
    && event.keyboard?.keyCode === 15
    && modifiers.has("cmd")
    && modifiers.has("control")
    && modifiers.has("option");
}

/**
 * Wraps one link of the event chain so that a failure cannot break the chain.
 *
 * Every event is chained onto one promise, and a rejected link rejects every
 * link after it: one failed write used to leave the recorder running while it
 * silently dropped every event that followed, and the service still showed it
 * recording. A write that fails cannot be retried into a destination that is
 * gone or full, so it ends the recording where the service will report it;
 * anything else costs only the event that caused it.
 */
export function recordingStep(onWriteFailure: () => void, onProcessingFailure: () => void = () => {}) {
  return (task: () => Promise<void>) => async (): Promise<void> => {
    try {
      await task();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code) {
        onProcessingFailure();
        console.error("[recorder] skipped an event after a processing failure");
        return;
      }
      console.error(`[recorder] cannot write the recording (${code}): ${(error as Error).message}`);
      onWriteFailure();
    }
  };
}

async function helperJson(binary: string, mode: string, extraArgs: string[] = [], env?: NodeJS.ProcessEnv): Promise<RecorderPermissions> {
  const { stdout } = await execFileAsync(binary, [...extraArgs, mode],
    { timeout: 60_000, ...(env ? { env } : {}) });
  return JSON.parse(stdout.trim());
}

export async function checkPermissions(
  binary: string,
  { screenshots = true, accessibility = true }: { screenshots?: boolean; accessibility?: boolean } = {},
  readPermissions: typeof helperJson = helperJson,
): Promise<RecorderPermissions> {
  let permissions = await readPermissions(binary, "--permissions");
  const missingRequiredPermission = () => (
    !permissions.inputMonitoring
      || (screenshots && !permissions.screenRecording)
      || (accessibility && !permissions.accessibility)
  );
  if (missingRequiredPermission()) {
    const requests: string[] = [];
    // Accessibility also grants event listening. Request it once rather than
    // asking for a redundant Input Monitoring grant alongside it.
    if (!accessibility && !permissions.inputMonitoring) requests.push("--request-input-monitoring");
    if (screenshots && !permissions.screenRecording) requests.push("--request-screen-recording");
    if (accessibility && !permissions.accessibility) requests.push("--request-accessibility");
    if (requests.length) permissions = await readPermissions(binary, "--permissions", requests);
  }
  if (missingRequiredPermission()) {
    const missing: string[] = [];
    if (!permissions.inputMonitoring) missing.push("Input Monitoring");
    if (screenshots && !permissions.screenRecording) missing.push("Screen Recording");
    if (accessibility && !permissions.accessibility) missing.push("Accessibility");
    throw new Error(
      `missing macOS permission: ${missing.join(", ")}. Grant it to the terminal/app running this command in System Settings > Privacy & Security, restart that app, then run again.`,
    );
  }
  return permissions;
}

async function captureScreenshot(file: string, width: number): Promise<string> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await execFileAsync("screencapture", ["-x", "-C", "-D", "1", "-t", "jpg", file], {
    timeout: 30_000,
  });
  await execFileAsync("sips", ["--resampleWidth", String(width), "-s", "formatOptions", "80", file], {
    timeout: 30_000,
  });
  return file;
}

function appendJsonLine(file: string, payload: unknown): void {
  fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function run(
  argv: string[] = process.argv,
): Promise<{ output: string; recordingId: string; events: number } | null> {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return null;
  }
  const windows = process.platform === "win32";
  if (windows && !isWindows11()) throw new Error("Computer History requires Windows 11 build 22000 or later");
  if (!windows && process.platform !== "darwin") throw new Error("Computer History requires macOS or Windows 11");
  if (windows && args.screenshots) throw new Error("Windows 11 Computer History does not capture screenshots; pass --no-screenshots");

  const command = windows
    ? { ...windowsObserverCommand({ parentPid: process.pid }), managed: false, env: undefined as NodeJS.ProcessEnv | undefined }
    : await historyNativeCommand(HELPER_SOURCE);
  if (!windows && command.managed && args.screenshots) {
    throw new Error("Packaged Computer History records without screenshots; pass --no-screenshots");
  }
  const permissions = windows
    ? { inputMonitoring: true, screenRecording: false, accessibility: true, mainDisplayWidth: 0, mainDisplayHeight: 0 }
    : await checkPermissions(command.binary, { screenshots: args.screenshots },
      (binary, mode, extra = []) => helperJson(binary, mode, [...command.args, ...extra], command.env));
  const recordingId = `human:${crypto.randomUUID()}`;
  const contextUrl = normalizedContextUrl(args.contextUrl);
  const output = path.resolve(expandHome(args.out ?? defaultOutput(args, recordingId)));
  const recordingDir = path.dirname(output);
  const screenshotDir = path.join(recordingDir, "screenshots");
  fs.mkdirSync(recordingDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(recordingDir, 0o700);
  if (fs.existsSync(output)) fs.chmodSync(output, 0o600);

  const startedAt = new Date().toISOString();
  appendJsonLine(output, {
    recordType: "human_history_metadata",
    schemaVersion: 1,
    recordingId,
    title: args.title ?? `Human-operated ${windows ? "Windows 11" : "macOS"} workflow`,
    createdAt: startedAt,
    platform: windows ? "Windows 11" : "macOS",
    display: { width: permissions.mainDisplayWidth, height: permissions.mainDisplayHeight },
    captureText: args.captureText,
    captureSearchText: args.captureSearchText,
    allowedApplications: args.allowApps,
    captureScopeApplications: args.onlyApps,
    ...(contextUrl && shouldObserve(loadObservationSettings(args.observationSettings), { browser: true, url: contextUrl })
      ? { contextUrl } : {}),
    privacy: "Text is retained from observed applications when enabled, except in password fields. An explicit allow-app narrows text capture. Excluded applications and sites are skipped; credential patterns are redacted.",
  });

  let sequence = 0;
  const failWrite = () => {
    if (!helper.killed) helper.kill("SIGTERM");
    process.exit(1);
  };
  const health = recorderHealthReporter((line) => {
    const signal = JSON.parse(line.slice("[recorder-health] ".length));
    if (signal.code !== "heartbeat" && signal.code !== "event_recorded") {
      // Retain content-free capture quality beside its events. Current health
      // cannot tell a later reader which historical intervals were incomplete.
      try { appendJsonLine(output, { recordType: "capture_health", ...signal }); }
      catch {
        // Do not try to report a failed write through the same failing sink.
        console.error("[recorder] cannot persist capture health; stopping recording");
        failWrite();
        return;
      }
    }
    console.log(line);
  });
  let snapshotHealthy: boolean | undefined;
  const reportSnapshotHealth = (healthy: boolean) => {
    if (snapshotHealthy === healthy) return;
    snapshotHealthy = healthy;
    health.report(healthy ? "ax_snapshot_ready" : "ax_snapshot_failed");
  };
  let lastPageContextUrl: string | null = null;
  let axBaseline: AxBaseline | null = null;
  let observationEpoch = 0;
  const invalidateObservation = () => { axBaseline = null; observationEpoch += 1; };
  const weChatConsent = new WeChatHistoryConsentStore();
  let observationPolicyVersion: string | null = null;
  const canObserve = (subject: ObservationSubject) => {
    // Exclusions and the separate WeChat consent are keyed by app identity.
    // The native Mac helper uses "unknown" when it cannot resolve that key.
    if (!subject.bundleId || subject.bundleId.trim().toLowerCase() === "unknown") {
      invalidateObservation();
      return false;
    }
    const settings = loadObservationSettings(args.observationSettings);
    const version = JSON.stringify(settings);
    if (version !== observationPolicyVersion) {
      invalidateObservation();
      observationPolicyVersion = version;
    }
    const allowed = shouldObserve(settings, {
      ...subject,
      ...(subject.bundleId && SENSITIVE_MESSAGE_APP_BUNDLE_IDS.has(subject.bundleId.toLowerCase())
        ? { weChatChatAccess: weChatConsent.read().enabled } : {}),
    });
    if (!allowed) invalidateObservation();
    return allowed;
  };
  let pendingKeys: HelperEvent[] = [];
  let pendingKeyTimer: ReturnType<typeof setTimeout> | null = null;
  let processing: Promise<void> = Promise.resolve();
  let stopping = false;
  let finishPromise: Promise<void> | null = null;
  let terminalLines: readline.Interface | null = null;
  let stopFromHotkey: (() => void) | null = null;
  let childClosedResolve!: () => void;
  const childClosed = new Promise<void>((resolve) => {
    childClosedResolve = resolve;
  });

  const appendEvent = async (
    {
      eventType,
      timestamp,
      application = {},
      details = {},
      ax = null,
      subjects,
      previousControlsEpoch,
    }: {
      eventType: string;
      timestamp?: string;
      application?: Application;
      details?: Record<string, unknown>;
      ax?: unknown;
      subjects?: ObservationSubject[];
      previousControlsEpoch?: number;
    },
    screenshot = false,
  ) => {
    const permitted = () => !subjects || subjects.every(canObserve);
    if (!permitted()) return;
    sequence += 1;
    let screenshotPath = null;
    if (args.screenshots && screenshot) {
      screenshotPath = path.join(screenshotDir, `${String(sequence).padStart(4, "0")}-${eventType}.jpg`);
      try {
        await captureScreenshot(screenshotPath, permissions.mainDisplayWidth);
      } catch (error) {
        fs.rmSync(screenshotPath, { force: true });
        screenshotPath = null;
        details = { ...details, screenshotError: (error as Error).message };
      }
    }
    // Settings can change while capture awaits a system process. Never keep
    // the resulting image or event after its application/site was excluded.
    if (!permitted()) {
      if (screenshotPath) fs.rmSync(screenshotPath, { force: true });
      return;
    }
    if (details.previousControlsAtPoint && previousControlsEpoch !== observationEpoch) {
      details = { ...details };
      delete details.previousControlsAtPoint;
    }
    // There are no awaits between computing this delta and committing its
    // baseline. Thus it can only refer to permitted snapshots already on disk.
    const preparedAx = ax ? prepareAuthorizedAxSnapshot(ax, axBaseline) : null;
    const tree = ax && typeof ax === "object" ? ax as Record<string, unknown> : null;
    const attemptedTree = windows && tree && ("mode" in tree || "text" in tree);
    const completeTree = attemptedTree && tree.mode === "fullTree"
      && typeof tree.text === "string" && tree.text.trim().length > 0
      && tree.truncated === false && tree.readFailures === 0;
    if (attemptedTree && !completeTree) reportSnapshotHealth(false);
    if (ax && !preparedAx?.snapshot && eventType === "accessibility_snapshot") {
      axBaseline = preparedAx?.baseline ?? null;
      if (completeTree && axBaseline) reportSnapshotHealth(true);
      return;
    }
    // Every event is written through here, so this is where accessibility
    // text is scrubbed: a new event type cannot forget to.
    appendJsonLine(output, {
      recordType: "human_event",
      sequence,
      timestamp: timestamp ?? new Date().toISOString(),
      eventType,
      application,
      details: scrubAccessibility(details),
      ...(preparedAx?.snapshot ? { ax: preparedAx.snapshot } : {}),
      ...(screenshotPath ? { screenshot: screenshotPath } : {}),
    });
    if (eventType !== "recording_stopped") health.report("event_recorded");
    if (preparedAx) axBaseline = preparedAx.baseline;
    if (completeTree && preparedAx?.snapshot) reportSnapshotHealth(true);
  };

  const flushKeys = async () => {
    if (pendingKeyTimer) clearTimeout(pendingKeyTimer);
    pendingKeyTimer = null;
    if (!pendingKeys.length) return;
    const events = pendingKeys.filter((event) => canObserve(observationSubject(event)));
    pendingKeys = [];
    if (!events.length) return;
    const normalized = normalizeKeyBurst(events, args);
    await appendEvent({ ...normalized, timestamp: events[0].timestamp,
      subjects: events.map(observationSubject) });
  };

  const safely = recordingStep(failWrite, () => health.report("event_processing_error"));

  const scheduleKeyFlush = () => {
    if (pendingKeyTimer) clearTimeout(pendingKeyTimer);
    pendingKeyTimer = setTimeout(() => {
      processing = processing.then(safely(flushKeys));
    }, TEXT_IDLE_MS);
  };

  const ingest = async (event: HelperEvent) => {
    const application = appFrom(event);
    if (event.kind === "session.ended") return;
    if (args.onlyApps.length && !appAllowed(application, args.onlyApps)) {
      invalidateObservation();
      return;
    }
    if (windows) applyWindowsBrowserPrivacy(event,
      args.browserAuthority ? readBrowserAuthority(args.browserAuthority) : null);
    const subjects = [observationSubject(event)];
    if (!canObserve(subjects[0])) {
      pendingKeys = pendingKeys.filter((pending) => canObserve(observationSubject(pending)));
      return;
    }

    // Native caches are not aware of application/site exclusion settings.
    // Admit earlier labels only when their exact observation was already
    // authorized here. Compute before this event's full tree replaces it.
    const candidate = windows ? previousControlsAtPoint(event.mouse?.previousControlsAtPoint, event.timestamp) : null;
    const authorizedPreviousControls = candidate && axBaseline?.observedAt === candidate.observedAt
      && event.ax?.windowKey === axBaseline.windowKey ? candidate : null;
    const previousControlsEpoch = observationEpoch;

    if (event.kind === "session.started") {
      await appendEvent({
        eventType: "recording_started",
        timestamp: event.timestamp,
        application,
        subjects,
        details: { goal: args.title ?? `Human-operated ${windows ? "Windows 11" : "macOS"} workflow` },
        ax: event.ax,
      }, true);
      return;
    }
    // Authorize every full native snapshot before constructing any persisted
    // delta, independently of input burst merging or normalized action types.
    if (event.ax) {
      await appendEvent({
        eventType: "accessibility_snapshot",
        timestamp: event.timestamp,
        application,
        subjects,
        ax: event.ax,
      });
    }

    // The URL now rides on every event's window envelope instead of arriving as
    // its own recorder event, so page context is derived from a change in it.
    const windowUrl = typeof event.window?.url === "string" ? event.window.url : null;
    if (windowUrl && windowUrl !== lastPageContextUrl) {
      lastPageContextUrl = windowUrl;
      await flushKeys();
      await appendEvent({
        eventType: "page_context",
        timestamp: event.timestamp,
        application,
        subjects,
        details: {
          url: windowUrl,
          ...(typeof event.window?.title === "string"
            ? { title: redactSensitive(event.window.title) }
            : {}),
        },
      });
    }

    if (event.kind === "keyboard.text_input") {
      if (isSecureInput(event)) {
        await flushKeys();
        return;
      }
      const inputContext = searchInputContextFromAccessibility(event.keyboard?.target);
      event = { ...event, inputContext };
      const previous = pendingKeys.at(-1);
      if (previous && (appFrom(previous).bundleId !== application.bundleId
        || JSON.stringify(previous.inputContext) !== JSON.stringify(inputContext)
        || JSON.stringify(observationSubject(previous)) !== JSON.stringify(subjects[0]))) {
        await flushKeys();
      }
      pendingKeys.push(event);
      scheduleKeyFlush();
      return;
    }

    if (windows && event.kind === "keyboard.keydown") {
      await flushKeys();
      const inputContext = searchInputContextFromAccessibility(event.keyboard?.target);
      const textAllowed = textAllowedInApplication(application, args.allowApps);
      const action = normalizeWindowsKeyboardAction(event, inputContext,
        args.captureSearchText && textAllowed, args.captureText && textAllowed);
      if (action) await appendEvent({ ...action, timestamp: event.timestamp, application, subjects });
      return;
    }

    if (event.kind === "keyboard.shortcut" || event.kind === "keyboard.submit") {
      await flushKeys();
      // Submitting in a browser starts a navigation; give it a moment so the
      // next captured state is the destination rather than the old page.
      const captureAfterNavigation = event.kind === "keyboard.submit"
        && BROWSER_BUNDLE_IDS.has((application.bundleId ?? "").toLowerCase());
      if (captureAfterNavigation) {
        await new Promise<void>((resolve) => setTimeout(resolve, NAVIGATION_SETTLE_MS));
      }
      await appendEvent({ ...normalizeKeyBurst([event], args), subjects }, captureAfterNavigation);
      return;
    }

    await flushKeys();

    if (event.kind === "window.changed") {
      await appendEvent({
        eventType: "application_changed",
        timestamp: event.timestamp,
        application,
        subjects,
      }, true);
      return;
    }

    if (event.kind === "mouse.click" || event.kind === "mouse.context_menu") {
      const target = event.mouse?.target ?? null;
      await appendEvent({
        eventType: "mouse_click",
        timestamp: event.timestamp,
        application,
        subjects,
        previousControlsEpoch,
        details: {
          button: event.mouse?.button ?? "left",
          clickCount: event.mouse?.clickCount ?? 1,
          ...(event.kind === "mouse.context_menu" ? { contextMenu: true } : {}),
          ...(target ? { accessibility: target } : {}),
          ...(authorizedPreviousControls ? { previousControlsAtPoint: authorizedPreviousControls } : {}),
        },
      }, true);
      return;
    }

    if (event.kind === "mouse.drag") {
      await appendEvent({
        eventType: "mouse_drag",
        timestamp: event.timestamp,
        application,
        subjects,
        details: {
          origin: event.mouse?.origin?.element ?? null,
          destination: event.mouse?.destination?.element ?? null,
        },
      }, true);
      return;
    }

    if (event.kind === "mouse.scroll") {
      await appendEvent({ eventType: "scroll", timestamp: event.timestamp, application, subjects,
        details: { direction: ["up", "down", "left", "right"].includes(event.mouse?.direction)
          ? event.mouse.direction : Number.isFinite(event.mouse?.deltaY) && event.mouse.deltaY !== 0
            ? event.mouse.deltaY > 0 ? "up" : "down" : "none" } });
      return;
    }

    // Selected text is evidence about what the user is reading, so it obeys the
    // same retention rule as typed text rather than being kept unconditionally.
    if (event.kind === "selection.changed") {
      const selectedText = event.selection?.selectedText;
      if (typeof selectedText !== "string" || !selectedText) return;
      if (isSecureInput(event)) return;
      const retain = args.captureText && textAllowedInApplication(application, args.allowApps);
      await appendEvent({
        eventType: "selection_changed",
        timestamp: event.timestamp,
        application,
        subjects,
        details: {
          characterCount: [...selectedText].length,
          ...(retain
            ? { text: redactSensitive(selectedText), redacted: false }
            : { text: "[REDACTED]", redacted: true }),
          ...(event.selection?.target ? { accessibility: event.selection.target } : {}),
        },
      });
    }
  };

  const finish = (reason: string): Promise<void> => {
    if (finishPromise) return finishPromise;
    finishPromise = (async () => {
      stopping = true;
      terminalLines?.close();
      if (pendingKeyTimer) clearTimeout(pendingKeyTimer);
      // Let the Windows supervisor remove its temporary worker and close its
      // child job before falling back to termination if it cannot respond.
      if (windows && helper.stdin && !helper.stdin.destroyed) {
        helper.stdin.end('{"kind":"stop"}\n');
      } else if (!helper.killed) helper.kill("SIGTERM");
      await Promise.race([
        childClosed,
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
      if (!helper.killed && !helperClosed) helper.kill("SIGTERM");
      await processing;
      await flushKeys();
      // Shutdown has no fresh native app/window envelope to authorize a
      // screenshot; keep its control marker without capturing the desktop.
      await appendEvent({
        eventType: "recording_stopped",
        details: { reason },
      });
      console.log(`\nrecording written: ${output}`);
      console.log(`events: ${sequence}`);
    })();
    return finishPromise;
  };

  if (windows) command.args.push("--wechat-consent", defaultWeChatConsentFile());
  const helper = spawn(command.binary, command.args, { stdio: [windows ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true,
    ...(command.env ? { env: command.env } : {}) });
  helper.stdin?.on("error", () => { /* A closed stop pipe is covered by the child-exit handler. */ });
  if (!helper.stdout || !helper.stderr) throw new Error("history observer pipes are unavailable");
  let helperClosed = false;
  helper.once("close", () => { helperClosed = true; childClosedResolve(); });
  const lines = readline.createInterface({ input: helper.stdout });
  let queuedWindowsEvents = 0;
  lines.on("line", (line: string) => {
    if (windows && line.length > 512 * 1024) { health.report("helper_parse_error"); return; }
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        health.report("helper_parse_error");
        return;
      }
      if (event.type === "recorder.diagnostic") {
        const signal = nativeRecorderDiagnostic(event);
        if (signal) processing = processing.then(safely(async () => {
          if (signal.code === "ax_snapshot_failed") snapshotHealthy = false;
          health.report(signal.code, signal);
        }));
        else health.report("helper_parse_error");
        return;
      }
      if (event.type === "recorder.capture_gap") {
        const gap = captureGapRecord(event);
        if (gap) processing = processing.then(safely(async () => {
          appendJsonLine(output, gap);
        }));
        else health.report("helper_parse_error");
        return;
      }
      if (isStopHotkey(event)) {
        stopFromHotkey?.();
        return;
      }
      if (stopping) return;
      if (windows && queuedWindowsEvents >= 64) { health.report("enrichment_backlog"); return; }
      if (windows) queuedWindowsEvents++;
      processing = processing.then(safely(() => ingest(event))).finally(() => {
        if (windows) queuedWindowsEvents--;
      });
    } catch {
      health.report("helper_parse_error");
      console.error("[recorder] ignored malformed helper event");
    }
  });
  helper.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));

  console.log(`[recorder] goal: ${args.title ?? `Human-operated ${windows ? "Windows 11" : "macOS"} workflow`}`);
  console.log(`[recorder] output: ${output}`);
  console.log(windows
    ? "[recorder] recording now; use Memmy to pause or stop recording."
    : "[recorder] recording now; keep the final result visible and press control+option+cmd+r to stop.");
  console.log("[recorder] fallback: return here and press Enter or Ctrl+C.");

  try {
    await new Promise<void>((resolve, reject) => {
      const onSignal = () => finish("user_interrupt").then(resolve, reject);
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      stopFromHotkey = () => finish("stop_hotkey").then(resolve, reject);
      if (process.stdin.isTTY) {
        terminalLines = readline.createInterface({ input: process.stdin, output: process.stdout });
        terminalLines.once("line", () => finish("user_stop").then(resolve, reject));
      }
      helper.once("error", reject);
      helper.once("exit", (code, signal) => {
        if (stopping) return;
        finish(`helper_exit:${code ?? signal ?? "unknown"}`).then(() => {
          if (windows) reject(new Error(WINDOWS_HISTORY_STREAM_DISCONNECT));
          else if (code !== 0) reject(new Error(`history observer exited with ${code ?? signal ?? "unknown"}`));
          else resolve();
        }, reject);
      });
    });
    return { output, recordingId, events: sequence };
  } finally {
    // A short session or Stop must still publish the last successful write.
    health.close();
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    await run();
  } catch (error) {
    console.error(recorderFailureMessage(error));
    process.exitCode = 1;
  }
}
