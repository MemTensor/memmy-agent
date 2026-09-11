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

interface ObservationRule {
  scope?: string;
  behavior?: string;
  bundleID?: string;
  urlDomain?: string;
}

interface RecorderObservationSettings {
  defaultApplicationBehavior: string;
  defaultURLBehavior: string;
  rules: ObservationRule[];
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
const BROWSER_BUNDLE_IDS = new Set(["com.google.Chrome", "com.apple.Safari"]);
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

Press control+option+cmd+r while the result remains visible to stop and capture the final screen.
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

function redactSensitive(value: unknown): string {
  return String(value ?? "")
    .replace(/\bBearer\s+[a-z0-9._~+/-]{12,}/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[a-z0-9_-]{12,}\b/gi, "[REDACTED]")
    .replace(
      /((?:api[ _-]?key|access[ _-]?token|auth[ _-]?token|password|secret)\s*[:=]\s*)[^\s,]+/gi,
      "$1[REDACTED]",
    );
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
  const queue: any[] = [accessibility.focused, accessibility].filter(Boolean);
  const seen = new Set<object>();
  let visited = 0;
  while (queue.length && visited < 64) {
    const node = queue.shift();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    visited += 1;
    const role = typeof node.role === "string" ? node.role : "";
    const subrole = typeof node.subrole === "string" ? node.subrole : "";
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
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) queue.push(...value);
      else if (value && typeof value === "object") queue.push(value);
    }
  }
  return null;
}

// The recorder now classifies keystrokes itself, so the consumer no longer has
// to infer printability from modifiers: a keyboard.text_input event is text by
// construction, and secure-input windows never produce one.
// Mirrors ./observation-settings.ts. The recorder was a standalone script
// outside the TypeScript build, so it could not import the policy and carried
// its own copy; the tables in the two test files are kept identical. Now that
// both compile together, the copy can be replaced with an import.
function loadObservationSettings(file: string | undefined): RecorderObservationSettings | null {
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const observation = parsed?.observation;
    if (!observation) return null;
    return {
      defaultApplicationBehavior: observation.defaultApplicationBehavior ?? "do_not_observe",
      defaultURLBehavior: observation.defaultURLBehavior ?? "observe",
      rules: Array.isArray(observation.rules) ? observation.rules : [],
    };
  } catch {
    // The service writes and validates this file before spawning the recorder,
    // so reaching here means it went missing mid-run. Fall back to the same
    // defaults the service would have written rather than silently recording
    // nothing, which looks identical to a broken recorder.
    return { defaultApplicationBehavior: "observe", defaultURLBehavior: "observe", rules: [] };
  }
}

function hostFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.trim().toLowerCase().replace(/^\.+|\.+$/g, "") || null;
  } catch {
    return null;
  }
}

function domainMatches(host: string, domain: unknown): boolean {
  const normalized = String(domain ?? "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!normalized) return false;
  return host === normalized || host.endsWith(`.${normalized}`);
}

// A block rule always wins inside its own axis.
function resolveAxis(matching: ObservationRule[], fallback: string): string {
  if (matching.some((rule) => rule.behavior === "do_not_observe")) return "do_not_observe";
  if (matching.some((rule) => rule.behavior === "observe")) return "observe";
  return fallback;
}

export function shouldObserve(
  settings: RecorderObservationSettings | null,
  subject: { bundleId?: string; url?: string | null },
): boolean {
  if (!settings) return true;
  const appRules = settings.rules.filter(
    (rule: ObservationRule) => rule.scope === "app" && subject.bundleId && rule.bundleID === subject.bundleId,
  );
  if (resolveAxis(appRules, settings.defaultApplicationBehavior) === "do_not_observe") return false;

  const host = subject.url ? hostFromUrl(subject.url) : null;
  if (!host) return true;
  const urlRules = settings.rules.filter(
    (rule: ObservationRule) => rule.scope === "url" && domainMatches(host, rule.urlDomain),
  );
  return resolveAxis(urlRules, settings.defaultURLBehavior) !== "do_not_observe";
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
  const searchInput: SearchInputContext | null = events.at(-1)?.inputContext?.purpose === "search_query"
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

async function helperJson(binary: string, mode: string): Promise<RecorderPermissions> {
  const { stdout } = await execFileAsync(binary, [mode], { timeout: 60_000 });
  return JSON.parse(stdout.trim());
}

async function checkPermissions(
  binary: string,
  { screenshots = true, accessibility = true }: { screenshots?: boolean; accessibility?: boolean } = {},
): Promise<RecorderPermissions> {
  let permissions = await helperJson(binary, "--permissions");
  const missingRequiredPermission = () => (
    !permissions.inputMonitoring
      || (screenshots && !permissions.screenRecording)
      || (accessibility && !permissions.accessibility)
  );
  if (missingRequiredPermission()) {
    permissions = await helperJson(binary, "--request-permissions");
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
  const searchInputContextByApp = new Map<string, SearchInputContext>();
  const observationSettings = loadObservationSettings(args.observationSettings);
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
    }: {
      eventType: string;
      timestamp?: string;
      application?: Application;
      details?: Record<string, unknown>;
      ax?: unknown;
    },
    screenshot = false,
  ) => {
    sequence += 1;
    let screenshotPath = null;
    if (args.screenshots && screenshot) {
      screenshotPath = path.join(screenshotDir, `${String(sequence).padStart(4, "0")}-${eventType}.jpg`);
      try {
        await captureScreenshot(screenshotPath, permissions.mainDisplayWidth);
      } catch (error) {
        screenshotPath = null;
        details = { ...details, screenshotError: (error as Error).message };
      }
    }
    appendJsonLine(output, {
      recordType: "human_event",
      sequence,
      timestamp: timestamp ?? new Date().toISOString(),
      eventType,
      application,
      details,
      ...(ax ? { ax } : {}),
      ...(screenshotPath ? { screenshot: screenshotPath } : {}),
    });
  };

  const flushKeys = async () => {
    if (pendingKeyTimer) clearTimeout(pendingKeyTimer);
    pendingKeyTimer = null;
    if (!pendingKeys.length) return;
    const events = pendingKeys;
    pendingKeys = [];
    const bundleId = appFrom(events.at(-1)).bundleId;
    const inputContext = bundleId ? searchInputContextByApp.get(bundleId) : null;
    const normalized = normalizeKeyBurst(
      inputContext ? events.map((event) => ({ ...event, inputContext: event.inputContext ?? inputContext })) : events,
      args,
    );
    const ax = events.at(-1)?.ax ?? null;
    await appendEvent({ ...normalized, timestamp: events[0].timestamp, ax });
  };

  const scheduleKeyFlush = () => {
    if (pendingKeyTimer) clearTimeout(pendingKeyTimer);
    pendingKeyTimer = setTimeout(() => {
      processing = processing.then(flushKeys);
    }, TEXT_IDLE_MS);
  };

  const ingest = async (event: HelperEvent) => {
    const application = appFrom(event);
    // Window state travels with the action it belongs to so the summarizer can
    // read what was on screen without re-deriving it from neighbouring events.
    const axState = event.ax ? { ax: event.ax } : {};
    if (event.kind === "session.started") {
      await appendEvent({
        eventType: "recording_started",
        timestamp: event.timestamp,
        application,
        details: { goal: args.title ?? "Human-operated macOS workflow" },
      }, true);
      return;
    }
    if (event.kind === "session.ended") return;
    if (args.onlyApps.length && !appAllowed(application, args.onlyApps)) return;
    if (!shouldObserve(observationSettings, {
      bundleId: application.bundleId,
      url: typeof event.window?.url === "string" ? event.window.url : null,
    })) return;

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
        details: {
          url: windowUrl,
          ...(typeof event.window?.title === "string"
            ? { title: redactSensitive(event.window.title) }
            : {}),
        },
      });
    }

    if (event.kind === "keyboard.text_input") {
      const inputContext = application.bundleId ? searchInputContextByApp.get(application.bundleId) : undefined;
      if (inputContext) event = { ...event, inputContext };
      const previousApp = pendingKeys.at(-1) ? appFrom(pendingKeys.at(-1)).bundleId : undefined;
      if (pendingKeys.length && previousApp !== application.bundleId) await flushKeys();
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
      await appendEvent(normalizeKeyBurst([event], args), captureAfterNavigation);
      return;
    }

    await flushKeys();

    if (event.kind === "window.changed") {
      await appendEvent({
        eventType: "application_changed",
        timestamp: event.timestamp,
        application,
        ...axState,
      }, true);
      return;
    }

    if (event.kind === "mouse.click" || event.kind === "mouse.context_menu") {
      const target = event.mouse?.target ?? null;
      if (application.bundleId) {
        const searchInput = searchInputContextFromAccessibility(target);
        if (searchInput) searchInputContextByApp.set(application.bundleId, searchInput);
        else searchInputContextByApp.delete(application.bundleId);
      }
      await appendEvent({
        eventType: "mouse_click",
        timestamp: event.timestamp,
        application,
        details: {
          button: event.mouse?.button ?? "left",
          clickCount: event.mouse?.clickCount ?? 1,
          ...(event.kind === "mouse.context_menu" ? { contextMenu: true } : {}),
          ...(target ? { accessibility: target } : {}),
        },
        ...axState,
      }, true);
      return;
    }

    if (event.kind === "mouse.drag") {
      await appendEvent({
        eventType: "mouse_drag",
        timestamp: event.timestamp,
        application,
        details: {
          origin: event.mouse?.origin?.element ?? null,
          destination: event.mouse?.destination?.element ?? null,
        },
        ...axState,
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
        details: {
          characterCount: [...selectedText].length,
          ...(retain
            ? { text: redactSensitive(selectedText), redacted: false }
            : { text: "[REDACTED]", redacted: true }),
          ...(event.selection?.target ? { accessibility: event.selection.target } : {}),
        },
        ...axState,
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
      await appendEvent({
        eventType: "recording_stopped",
        details: { reason },
      }, true);
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
      processing = processing.then(() => ingest(event));
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
