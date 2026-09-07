#!/usr/bin/env node
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

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const HELPER_SOURCE = path.join(SCRIPT_DIR, "human-recorder.swift");
const DEFAULT_RECORDINGS_DIR = path.join(ROOT_DIR, "workflows", "recordings");
const TEXT_IDLE_MS = 700;
const SCROLL_IDLE_MS = 550;
const NAVIGATION_SETTLE_MS = 900;

function usage() {
  console.log(`Usage:
  node workflows/scripts/record-human-history.mjs [options]

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

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function parseArgs(argv) {
  const args = { allowApps: [], onlyApps: [], captureText: false, captureSearchText: false, screenshots: true };
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
    else if (key === "--no-screenshots") args.screenshots = false;
    else if (key === "--help" || key === "-h") args.help = true;
    else throw new Error(`unknown argument: ${key}`);
  }
  if (args.captureText && args.allowApps.length === 0) {
    throw new Error("--capture-text requires at least one --allow-app bundle id");
  }
  return args;
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(":", "-");
}

function defaultOutput(args, recordingId) {
  const recordingsDir = path.resolve(expandHome(args.recordingsDir ?? DEFAULT_RECORDINGS_DIR));
  return path.join(recordingsDir, `${timestampForPath()}-${recordingId.slice(0, 8)}`, "events.jsonl");
}

function normalizedContextUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("--context-url must use http or https");
  if (url.username || url.password) throw new Error("--context-url must not contain credentials");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function redactSensitive(value) {
  return String(value ?? "")
    .replace(/\bBearer\s+[a-z0-9._~+/-]{12,}/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[a-z0-9_-]{12,}\b/gi, "[REDACTED]")
    .replace(
      /((?:api[ _-]?key|access[ _-]?token|auth[ _-]?token|password|secret)\s*[:=]\s*)[^\s,]+/gi,
      "$1[REDACTED]",
    );
}

function appAllowed(application, allowedApps) {
  return Boolean(application?.bundleId && allowedApps.includes(application.bundleId));
}

const SEARCH_INPUT_ROLES = new Set(["AXSearchField"]);
const SEARCHABLE_TEXT_INPUT_ROLES = new Set(["AXTextField", "AXComboBox"]);
const SEARCH_INPUT_HINT = /(?:\bsearch\b|\bquery\b|\bfind\b|address and search|搜索|检索|查找)/iu;

export function searchInputContextFromAccessibility(accessibility) {
  if (!accessibility || typeof accessibility !== "object") return null;
  const queue = [accessibility.focused, accessibility].filter(Boolean);
  const seen = new Set();
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

function printableKey(event) {
  const modifiers = new Set(event.modifiers ?? []);
  if (modifiers.has("cmd") || modifiers.has("control") || modifiers.has("option")) return false;
  return typeof event.characters === "string"
    && event.characters.length > 0
    && !/[\u0000-\u001f\u007f]/u.test(event.characters);
}

export function normalizeKeyBurst(events, options) {
  const application = events.at(-1)?.application ?? {};
  const rawText = events.filter(printableKey).map((event) => event.characters).join("");
  const searchInput = events.at(-1)?.inputContext?.purpose === "search_query"
    ? events.at(-1).inputContext
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
    const modifiers = event.modifiers ?? [];
    return [...modifiers, event.key].filter(Boolean).join("+");
  });
  return { eventType: "key_press", application, details: { keys } };
}

export function normalizeScrollBurst(events) {
  const application = events.at(-1)?.application ?? {};
  const deltaX = events.reduce((sum, event) => sum + Number(event.deltaX || 0), 0);
  const deltaY = events.reduce((sum, event) => sum + Number(event.deltaY || 0), 0);
  const dominantDelta = Math.abs(deltaY) >= Math.abs(deltaX) ? deltaY : deltaX;
  const axis = Math.abs(deltaY) >= Math.abs(deltaX) ? "vertical" : "horizontal";
  let direction = "none";
  if (dominantDelta !== 0) {
    if (axis === "vertical") direction = dominantDelta < 0 ? "down" : "up";
    else direction = dominantDelta < 0 ? "right" : "left";
  }
  return {
    eventType: "scroll",
    application,
    details: {
      deltaX: Math.round(deltaX),
      deltaY: Math.round(deltaY),
      direction,
      sampleCount: events.length,
    },
  };
}

export function isStopHotkey(event) {
  const modifiers = new Set(event?.modifiers ?? []);
  return event?.type === "key_down"
    && event.keyCode === 15
    && modifiers.has("cmd")
    && modifiers.has("control")
    && modifiers.has("option");
}

async function ensureHelper() {
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
      `failed to compile the macOS recorder helper (Xcode Command Line Tools required): ${error.message}`,
    );
  }
  return binary;
}

async function helperJson(binary, mode) {
  const { stdout } = await execFileAsync(binary, [mode], { timeout: 60_000 });
  return JSON.parse(stdout.trim());
}

async function checkPermissions(binary, { screenshots = true, accessibility = true } = {}) {
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
    const missing = [];
    if (!permissions.inputMonitoring) missing.push("Input Monitoring");
    if (screenshots && !permissions.screenRecording) missing.push("Screen Recording");
    if (accessibility && !permissions.accessibility) missing.push("Accessibility");
    throw new Error(
      `missing macOS permission: ${missing.join(", ")}. Grant it to the terminal/app running this command in System Settings > Privacy & Security, restart that app, then run again.`,
    );
  }
  return permissions;
}

async function captureScreenshot(file, width) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await execFileAsync("screencapture", ["-x", "-C", "-D", "1", "-t", "jpg", file], {
    timeout: 30_000,
  });
  await execFileAsync("sips", ["--resampleWidth", String(width), "-s", "formatOptions", "80", file], {
    timeout: 30_000,
  });
  return file;
}

function appendJsonLine(file, payload) {
  fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, "utf8");
}

export async function run(argv = process.argv) {
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
  let lastPageContextUrl = null;
  const searchInputContextByApp = new Map();
  let pendingKeys = [];
  let pendingKeyTimer = null;
  let pendingScrolls = [];
  let pendingScrollTimer = null;
  let processing = Promise.resolve();
  let stopping = false;
  let finishPromise = null;
  let child;
  let terminalLines = null;
  let stopFromHotkey = null;
  let childClosedResolve;
  const childClosed = new Promise((resolve) => {
    childClosedResolve = resolve;
  });

  const appendEvent = async ({ eventType, timestamp, application = {}, details = {} }, screenshot = false) => {
    sequence += 1;
    let screenshotPath = null;
    if (args.screenshots && screenshot) {
      screenshotPath = path.join(screenshotDir, `${String(sequence).padStart(4, "0")}-${eventType}.jpg`);
      try {
        await captureScreenshot(screenshotPath, permissions.mainDisplayWidth);
      } catch (error) {
        screenshotPath = null;
        details = { ...details, screenshotError: error.message };
      }
    }
    appendJsonLine(output, {
      recordType: "human_event",
      sequence,
      timestamp: timestamp ?? new Date().toISOString(),
      eventType,
      application,
      details,
      ...(screenshotPath ? { screenshot: screenshotPath } : {}),
    });
  };

  const flushKeys = async () => {
    if (pendingKeyTimer) clearTimeout(pendingKeyTimer);
    pendingKeyTimer = null;
    if (!pendingKeys.length) return;
    const events = pendingKeys;
    pendingKeys = [];
    const bundleId = events.at(-1)?.application?.bundleId;
    const inputContext = bundleId ? searchInputContextByApp.get(bundleId) : null;
    const normalized = normalizeKeyBurst(
      inputContext ? events.map((event) => ({ ...event, inputContext: event.inputContext ?? inputContext })) : events,
      args,
    );
    await appendEvent({ ...normalized, timestamp: events[0].timestamp });
  };

  const scheduleKeyFlush = () => {
    if (pendingKeyTimer) clearTimeout(pendingKeyTimer);
    pendingKeyTimer = setTimeout(() => {
      processing = processing.then(flushKeys);
    }, TEXT_IDLE_MS);
  };

  const flushScrolls = async () => {
    if (pendingScrollTimer) clearTimeout(pendingScrollTimer);
    pendingScrollTimer = null;
    if (!pendingScrolls.length) return;
    const events = pendingScrolls;
    pendingScrolls = [];
    const normalized = normalizeScrollBurst(events);
    await appendEvent({ ...normalized, timestamp: events[0].timestamp }, true);
  };

  const scheduleScrollFlush = () => {
    if (pendingScrollTimer) clearTimeout(pendingScrollTimer);
    pendingScrollTimer = setTimeout(() => {
      processing = processing.then(flushScrolls);
    }, SCROLL_IDLE_MS);
  };

  const ingest = async (event) => {
    if (event.type === "helper_ready") {
      await appendEvent({
        eventType: "recording_started",
        timestamp: event.timestamp,
        application: event.application,
        details: { goal: args.title ?? "Human-operated macOS workflow" },
      }, true);
      return;
    }
    if (args.onlyApps.length && !appAllowed(event.application, args.onlyApps)) return;
    if (event.type === "page_context") {
      if (typeof event.url !== "string" || !event.url) return;
      if (event.url === lastPageContextUrl) return;
      lastPageContextUrl = event.url;
      await flushKeys();
      await flushScrolls();
      await appendEvent({
        eventType: "page_context",
        timestamp: event.timestamp,
        application: event.application,
        details: {
          url: event.url,
          ...(typeof event.title === "string" ? { title: redactSensitive(event.title) } : {}),
        },
      });
      return;
    }
    if (event.type === "key_down") {
      await flushScrolls();
      if (!printableKey(event)) {
        await flushKeys();
        const captureAfterNavigation = event.key === "return"
          && ["com.google.Chrome", "com.apple.Safari"].includes(event.application?.bundleId);
        if (captureAfterNavigation) {
          await new Promise((resolve) => setTimeout(resolve, NAVIGATION_SETTLE_MS));
        }
        await appendEvent(normalizeKeyBurst([event], args), captureAfterNavigation);
      } else {
        const inputContext = searchInputContextByApp.get(event.application?.bundleId);
        if (inputContext) event = { ...event, inputContext };
        const previousApp = pendingKeys.at(-1)?.application?.bundleId;
        if (pendingKeys.length && previousApp !== event.application?.bundleId) await flushKeys();
        pendingKeys.push(event);
        scheduleKeyFlush();
      }
      return;
    }

    await flushKeys();
    if (event.type !== "scroll") await flushScrolls();
    if (event.type === "application_changed") {
      await appendEvent({
        eventType: "application_changed",
        timestamp: event.timestamp,
        application: event.application,
      }, true);
    } else if (event.type === "mouse_click") {
      const bundleId = event.application?.bundleId;
      if (bundleId) {
        const searchInput = searchInputContextFromAccessibility(event.accessibility);
        if (searchInput) searchInputContextByApp.set(bundleId, searchInput);
        else searchInputContextByApp.delete(bundleId);
      }
      await appendEvent({
        eventType: "mouse_click",
        timestamp: event.timestamp,
        application: event.application,
        details: {
          x: Math.round(event.x), y: Math.round(event.y),
          button: event.button, clickCount: event.clickCount,
          ...(event.accessibility ? { accessibility: event.accessibility } : {}),
        },
      }, true);
    } else if (event.type === "scroll") {
      const previousApp = pendingScrolls.at(-1)?.application?.bundleId;
      if (pendingScrolls.length && previousApp !== event.application?.bundleId) await flushScrolls();
      pendingScrolls.push(event);
      scheduleScrollFlush();
    }
  };

  const finish = (reason) => {
    if (finishPromise) return finishPromise;
    finishPromise = (async () => {
      stopping = true;
      terminalLines?.close();
      if (pendingKeyTimer) clearTimeout(pendingKeyTimer);
      if (pendingScrollTimer) clearTimeout(pendingScrollTimer);
      if (child && !child.killed) child.kill("SIGTERM");
      await Promise.race([
        childClosed,
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
      await processing;
      await flushKeys();
      await flushScrolls();
      await appendEvent({
        eventType: "recording_stopped",
        details: { reason },
      }, true);
      console.log(`\nrecording written: ${output}`);
      console.log(`events: ${sequence}`);
    })();
    return finishPromise;
  };

  child = spawn(binary, [], { stdio: ["ignore", "pipe", "pipe"] });
  child.once("close", childClosedResolve);
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const event = JSON.parse(line);
      if (isStopHotkey(event)) {
        stopFromHotkey?.();
        return;
      }
      processing = processing.then(() => ingest(event));
    } catch (error) {
      console.error(`[recorder] ignored malformed helper event: ${error.message}`);
    }
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  console.log(`[recorder] goal: ${args.title ?? "Human-operated macOS workflow"}`);
  console.log(`[recorder] output: ${output}`);
  console.log("[recorder] recording now; keep the final result visible and press control+option+cmd+r to stop.");
  console.log("[recorder] fallback: return here and press Enter or Ctrl+C.");

  await new Promise((resolve, reject) => {
    const onSignal = () => finish("user_interrupt").then(resolve, reject);
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    stopFromHotkey = () => finish("stop_hotkey").then(resolve, reject);
    if (process.stdin.isTTY) {
      terminalLines = readline.createInterface({ input: process.stdin, output: process.stdout });
      terminalLines.once("line", () => finish("user_stop").then(resolve, reject));
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
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
