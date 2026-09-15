// Explicitly record one human-operated macOS workflow as a small, local JSONL
// event stream. This is a demo recorder, not a background activity monitor.

import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { redactSensitive } from "./redaction.js";
import {
  BROWSER_BUNDLE_IDS,
  DEFAULT_OBSERVATION_SETTINGS,
  evaluateObservation,
  parseObservationSettings,
  type ObservationSettings,
  type ObservationSubject,
} from "./observation-settings.js";

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
// The build copies the Swift source beside the compiled module, so the helper
// is found the same way from `src/` under test and from `dist/` when shipped.
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
  --capture-text          retain text only in explicitly allowed applications
  --allow-app <bundle-id> application allowed to retain text; repeatable
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
    else if (key === "--no-screenshots") args.screenshots = false;
    else if (key === "--help" || key === "-h") args.help = true;
    else throw new Error(`unknown argument: ${key}`);
  }
  if (args.captureText && args.allowApps.length === 0) {
    throw new Error("--capture-text requires at least one --allow-app bundle id");
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
  return event?.app?.secureInput === true;
}

const SEARCH_INPUT_ROLES = new Set(["AXSearchField"]);
const SEARCHABLE_TEXT_INPUT_ROLES = new Set(["AXTextField", "AXComboBox"]);
const SEARCH_INPUT_HINT = /(?:\bsearch\b|\bquery\b|\bfind\b|address and search|搜索|检索|查找)/iu;

export function searchInputContextFromAccessibility(accessibility: any): SearchInputContext | null {
  if (!accessibility || typeof accessibility !== "object") return null;
  // Only the current target (or its explicitly focused element) grants text
  // retention. A search field elsewhere in a window is not evidence of focus.
  const node = accessibility.focused ?? accessibility;
  if (!node || typeof node !== "object") return null;
  const role = typeof node.role === "string" ? node.role : "";
  const subrole = typeof node.subrole === "string" ? node.subrole : "";
  if (role === "AXSecureTextField" || subrole === "AXSecureTextField") return null;
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
function keepsFieldValue(subrole: string): boolean {
  return subrole !== "AXSecureTextField";
}

/**
 * Scrubs an accessibility payload before it is written: a password field's
 * value is withheld, and every string has credential patterns masked.
 */
export function scrubAccessibility(value: unknown): unknown {
  if (typeof value === "string") return redactSensitive(value);
  if (Array.isArray(value)) return value.map((item) => scrubAccessibility(item));
  if (!value || typeof value !== "object") return value;
  const node = value as Record<string, unknown>;
  const subrole = typeof node.subrole === "string" ? node.subrole : "";
  const keep = keepsFieldValue(subrole);
  const scrubbed: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(node)) {
    scrubbed[key] = key === "value" && !keep && typeof field === "string" && field
      ? REDACTED
      : scrubAccessibility(field);
  }
  return scrubbed;
}

// A window snapshot line is `role|subrole|title|description|identifier|value`,
// prefixed with `+ ` or `- ` when the snapshot is a diff.
function scrubTreeLine(line: string): string {
  const prefix = /^[+-] /u.test(line) ? line.slice(0, 2) : "";
  const parts = line.slice(prefix.length).split("|");
  const [role = "", subrole = ""] = parts;
  if (keepsFieldValue(subrole)) {
    return prefix + redactSensitive(parts.join("|"));
  }
  if (parts.length === 6 && !parts[5]) return prefix + redactSensitive(parts.join("|"));
  // A `|` inside any field shifts the value to the right, so when the line does
  // not split cleanly keep only the role and drop the rest rather than guess.
  const labels = parts.length === 6 ? parts.slice(0, 5) : [role, subrole, "", "", ""];
  return prefix + [...labels.map(redactSensitive), REDACTED].join("|");
}

/** Scrubs a window snapshot, full or diff, line by line. */
export function scrubAxSnapshot(ax: unknown): unknown {
  if (!ax || typeof ax !== "object") return ax;
  const snapshot = ax as Record<string, unknown>;
  if (typeof snapshot.text !== "string") return scrubAccessibility(ax);
  return {
    ...snapshot,
    text: snapshot.text.split("\n").map((line) => scrubTreeLine(line)).join("\n"),
  };
}

interface AxBaseline {
  windowKey: string;
  lines: string[];
}

function prepareAuthorizedAxSnapshot(ax: unknown, previous: AxBaseline | null): {
  snapshot: Record<string, unknown> | null;
  baseline: AxBaseline | null;
} {
  const current = scrubAxSnapshot(ax) as Record<string, unknown> | null;
  // Only complete native observations can establish permission to store text.
  // Legacy/unknown diffs may contain removed text from an excluded interval.
  if (current?.mode !== "fullTree" || typeof current.text !== "string") {
    return { snapshot: null, baseline: null };
  }
  const lines = current.text.split("\n");
  const baseline = typeof current.windowKey === "string"
    ? { windowKey: current.windowKey, lines } : null;
  if (!baseline || previous?.windowKey !== baseline.windowKey) return { snapshot: current, baseline };
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
    return { observation: {
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
    privateBrowsing: event.window?.privateBrowsing === true,
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
  const retainText = (options.captureText && appAllowed(application, options.allowApps))
    || (options.captureSearchText && searchInput);
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
export function recordingStep(onWriteFailure: () => void) {
  return (task: () => Promise<void>) => async (): Promise<void> => {
    try {
      await task();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code) {
        console.error(`[recorder] skipped an event: ${(error as Error).message}`);
        return;
      }
      console.error(`[recorder] cannot write the recording (${code}): ${(error as Error).message}`);
      onWriteFailure();
    }
  };
}

async function ensureHelper(): Promise<string> {
  const source = fs.readFileSync(HELPER_SOURCE, "utf8");
  const hash = crypto.createHash("sha256").update(source).digest("hex").slice(0, 12);
  const helperDir = path.join(os.homedir(), ".memmy", "tools", "human-history-recorder");
  const binary = path.join(helperDir, `human-recorder-${hash}`);
  if (fs.existsSync(binary)) return binary;
  fs.mkdirSync(helperDir, { recursive: true });
  try {
    await execFileAsync("swiftc", ["-O", "-o", binary, HELPER_SOURCE], { timeout: 120_000 });
  } catch (error) {
    throw new Error(
      `failed to compile the macOS recorder helper (Xcode Command Line Tools required): ${(error as Error).message}`,
    );
  }
  return binary;
}

async function helperJson(binary: string, mode: string, extraArgs: string[] = []): Promise<RecorderPermissions> {
  const { stdout } = await execFileAsync(binary, [mode, ...extraArgs], { timeout: 60_000 });
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
    if (!permissions.inputMonitoring) requests.push("--request-input-monitoring");
    if (screenshots && !permissions.screenRecording) requests.push("--request-screen-recording");
    if (accessibility && !permissions.accessibility) requests.push("--request-accessibility");
    permissions = await readPermissions(binary, "--permissions", requests);
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
  fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, "utf8");
}

export async function run(
  argv: string[] = process.argv,
): Promise<{ output: string; recordingId: string; events: number } | null> {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return null;
  }
  if (process.platform !== "darwin") throw new Error("the human history recorder currently supports macOS only");

  const binary = await ensureHelper();
  const permissions = await checkPermissions(binary, { screenshots: args.screenshots });
  const recordingId = `human:${crypto.randomUUID()}`;
  const contextUrl = normalizedContextUrl(args.contextUrl);
  const output = path.resolve(expandHome(args.out ?? defaultOutput(args, recordingId)));
  const recordingDir = path.dirname(output);
  const screenshotDir = path.join(recordingDir, "screenshots");
  fs.mkdirSync(recordingDir, { recursive: true });

  const startedAt = new Date().toISOString();
  appendJsonLine(output, {
    recordType: "human_history_metadata",
    schemaVersion: 1,
    recordingId,
    title: args.title ?? "Human-operated macOS workflow",
    createdAt: startedAt,
    platform: "macOS",
    display: { width: permissions.mainDisplayWidth, height: permissions.mainDisplayHeight },
    captureText: args.captureText,
    captureSearchText: args.captureSearchText,
    allowedApplications: args.allowApps,
    captureScopeApplications: args.onlyApps,
    ...(contextUrl ? { contextUrl } : {}),
    privacy: "Search/address-field text is retained only when explicitly enabled; other text is retained only for allowed bundle ids. Common credential patterns are redacted.",
  });

  let sequence = 0;
  let lastPageContextUrl: string | null = null;
  let axBaseline: AxBaseline | null = null;
  let observationPolicyVersion: string | null = null;
  const canObserve = (subject: ObservationSubject) => {
    const settings = loadObservationSettings(args.observationSettings);
    const version = JSON.stringify(settings);
    if (version !== observationPolicyVersion) {
      axBaseline = null;
      observationPolicyVersion = version;
    }
    const allowed = shouldObserve(settings, subject);
    if (!allowed) axBaseline = null;
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
    }: {
      eventType: string;
      timestamp?: string;
      application?: Application;
      details?: Record<string, unknown>;
      ax?: unknown;
      subjects?: ObservationSubject[];
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
    // There are no awaits between computing this delta and committing its
    // baseline. Thus it can only refer to permitted snapshots already on disk.
    const preparedAx = ax ? prepareAuthorizedAxSnapshot(ax, axBaseline) : null;
    if (ax && !preparedAx?.snapshot && eventType === "accessibility_snapshot") {
      axBaseline = preparedAx?.baseline ?? null;
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
    if (preparedAx) axBaseline = preparedAx.baseline;
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

  const safely = recordingStep(() => {
    if (!helper.killed) helper.kill("SIGTERM");
    process.exit(1);
  });

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
      axBaseline = null;
      return;
    }
    const subjects = [observationSubject(event)];
    if (!canObserve(subjects[0])) {
      pendingKeys = pendingKeys.filter((pending) => canObserve(observationSubject(pending)));
      return;
    }

    if (event.kind === "session.started") {
      await appendEvent({
        eventType: "recording_started",
        timestamp: event.timestamp,
        application,
        subjects,
        details: { goal: args.title ?? "Human-operated macOS workflow" },
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
      if (isSecureInput(event)) return;
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

    if (event.kind === "keyboard.shortcut" || event.kind === "keyboard.submit") {
      await flushKeys();
      // Submitting in a browser starts a navigation; give it a moment so the
      // next captured state is the destination rather than the old page.
      const captureAfterNavigation = event.kind === "keyboard.submit"
        && BROWSER_BUNDLE_IDS.has(application.bundleId ?? "");
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
        details: {
          button: event.mouse?.button ?? "left",
          clickCount: event.mouse?.clickCount ?? 1,
          ...(event.kind === "mouse.context_menu" ? { contextMenu: true } : {}),
          ...(target ? { accessibility: target } : {}),
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

    // Selected text is evidence about what the user is reading, so it obeys the
    // same retention rule as typed text rather than being kept unconditionally.
    if (event.kind === "selection.changed") {
      const selectedText = event.selection?.selectedText;
      if (typeof selectedText !== "string" || !selectedText) return;
      const retain = args.captureText && appAllowed(application, args.allowApps);
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
      // Only ever called from handlers registered after the helper starts.
      if (!helper.killed) helper.kill("SIGTERM");
      await Promise.race([
        childClosed,
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
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

  const helper = spawn(binary, [], { stdio: ["ignore", "pipe", "pipe"] });
  helper.once("close", childClosedResolve);
  const lines = readline.createInterface({ input: helper.stdout });
  lines.on("line", (line: string) => {
    try {
      const event = JSON.parse(line);
      if (isStopHotkey(event)) {
        stopFromHotkey?.();
        return;
      }
      processing = processing.then(safely(() => ingest(event)));
    } catch (error) {
      console.error(`[recorder] ignored malformed helper event: ${(error as Error).message}`);
    }
  });
  helper.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));

  console.log(`[recorder] goal: ${args.title ?? "Human-operated macOS workflow"}`);
  console.log(`[recorder] output: ${output}`);
  console.log("[recorder] recording now; keep the final result visible and press control+option+cmd+r to stop.");
  console.log("[recorder] fallback: return here and press Enter or Ctrl+C.");

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
      finish(`helper_exit:${code ?? signal ?? "unknown"}`).then(resolve, reject);
    });
  });
  return { output, recordingId, events: sequence };
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    await run();
  } catch (error) {
    console.error(`human history recording failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
