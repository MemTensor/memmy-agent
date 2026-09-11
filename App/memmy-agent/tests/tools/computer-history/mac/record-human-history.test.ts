import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isStopHotkey,
  normalizeKeyBurst,
  parseArgs,
  searchInputContextFromAccessibility,
  appFrom,
  isSecureInput,
  shouldObserve,
} from "../../../../src/tools/computer-history/mac/record-human-history.js";

const notes = { name: "Notes", bundleId: "com.apple.Notes", pid: 42 };

// Recorder-shaped envelope: app identity lives on `app`, keystrokes on `keyboard`.
function textInput(text: string, application = notes, extra: Record<string, unknown> = {}) {
  return {
    kind: "keyboard.text_input",
    app: { name: application.name, bundleIdentifier: application.bundleId, secureInput: false },
    keyboard: { text, target: { role: "AXTextField" } },
    ...extra,
  };
}

function shortcut(keyEquivalent: string, modifiers: string[], application = notes, keyCode?: number) {
  return {
    kind: "keyboard.shortcut",
    app: { name: application.name, bundleIdentifier: application.bundleId, secureInput: false },
    keyboard: { keyEquivalent, modifiers, ...(keyCode === undefined ? {} : { keyCode }) },
  };
}

test("requires an explicit app allowlist before retaining text", () => {
  assert.throws(
    () => parseArgs(["node", "recorder", "--capture-text"]),
    /requires at least one --allow-app/,
  );
});

test("accepts an explicit starting URL as recording context", () => {
  const args = parseArgs([
    "node",
    "recorder",
    "--context-url",
    "https://www.apple.com.cn/shop/buy-iphone/iphone-17-pro",
  ]);
  assert.equal(args.contextUrl, "https://www.apple.com.cn/shop/buy-iphone/iphone-17-pro");
});

test("allows scoped search-text capture without enabling app-wide text capture", () => {
  const args = parseArgs(["node", "recorder", "--capture-search-text"]);

  assert.equal(args.captureSearchText, true);
  assert.equal(args.captureText, false);
  assert.deepEqual(args.allowApps, []);
});

test("recognizes semantic search fields but not ordinary or secure text fields", () => {
  assert.deepEqual(searchInputContextFromAccessibility({
    role: "AXStaticText",
    focused: { role: "AXTextField", subrole: "AXSearchField", description: "Search Amazon" },
  }), {
    purpose: "search_query",
    role: "AXSearchField",
    label: "Search Amazon",
  });
  assert.equal(searchInputContextFromAccessibility({
    role: "AXTextField",
    description: "Shipping address",
  }), null);
  assert.equal(searchInputContextFromAccessibility({
    role: "AXSecureTextField",
    description: "Password",
  }), null);
});

test("retains text only for an explicitly allowed application", () => {
  const events = [..."Notes"].map((character) => textInput(character));

  assert.deepEqual(normalizeKeyBurst(events, {
    captureText: true,
    allowApps: ["com.apple.Notes"],
  }).details, {
    text: "Notes",
    characterCount: 5,
    redacted: false,
  });

  assert.deepEqual(normalizeKeyBurst(events, {
    captureText: false,
    allowApps: [],
  }).details, {
    text: "[REDACTED]",
    characterCount: 5,
    redacted: true,
  });
});

test("retains recognized search terms while ordinary browser text stays redacted", () => {
  const chrome = { name: "Google Chrome", bundleId: "com.google.Chrome", pid: 43 };
  const searchContext = { purpose: "search_query", role: "AXTextField", label: "Search Amazon" };
  const searchEvents = [..."usb hub"].map((character) =>
    textInput(character, chrome, { inputContext: searchContext }));
  const ordinaryEvents = [..."private note"].map((character) => textInput(character, chrome));
  const options = { captureText: false, captureSearchText: true, allowApps: [] };

  assert.deepEqual(normalizeKeyBurst(searchEvents, options).details, {
    text: "usb hub",
    characterCount: 7,
    redacted: false,
    textPurpose: "search_query",
    input: searchContext,
  });
  assert.deepEqual(normalizeKeyBurst(ordinaryEvents, options).details, {
    text: "[REDACTED]",
    characterCount: 12,
    redacted: true,
  });
});

test("records shortcuts as semantic key presses", () => {
  const normalized = normalizeKeyBurst(
    [shortcut("space", ["cmd"])],
    { captureText: true, allowApps: ["com.apple.Notes"] },
  );

  assert.equal(normalized.eventType, "key_press");
  assert.deepEqual(normalized.details.keys, ["cmd+space"]);
});

test("redacts credential-like text even in an allowed application", () => {
  const text = "api_key=super-secret-value";
  const events = [...text].map((character) => textInput(character));
  const normalized = normalizeKeyBurst(events, {
    captureText: true,
    allowApps: ["com.apple.Notes"],
  });

  assert.equal(normalized.details.text, "api_key=[REDACTED]");
});

test("recognizes only the dedicated global stop shortcut", () => {
  assert.equal(isStopHotkey(shortcut("r", ["control", "option", "cmd"], notes, 15)), true);
  assert.equal(isStopHotkey(shortcut("r", ["cmd"], notes, 15)), false);
  // A plain text keystroke must never stop the recording.
  assert.equal(isStopHotkey(textInput("r")), false);
});

test("treats a submit as a semantic return key press", () => {
  const submit = {
    kind: "keyboard.submit",
    app: { name: "Google Chrome", bundleIdentifier: "com.google.Chrome", secureInput: false },
    keyboard: { target: { role: "AXTextField" } },
  };
  const normalized = normalizeKeyBurst([submit], { captureText: false, allowApps: [] });

  assert.equal(normalized.eventType, "key_press");
  assert.deepEqual(normalized.details.keys, ["return"]);
  assert.deepEqual(normalized.application, { name: "Google Chrome", bundleId: "com.google.Chrome" });
});

test("maps the recorder envelope onto the history application shape", () => {
  assert.deepEqual(appFrom(textInput("a")), { name: "Notes", bundleId: "com.apple.Notes" });
  assert.deepEqual(appFrom({}), {});
});

test("reports secure input so keystroke text can be suppressed", () => {
  assert.equal(isSecureInput(textInput("a")), false);
  assert.equal(isSecureInput({ app: { secureInput: true } }), true);
});

// This table mirrors observation-settings.test.ts: the capture path and the
// agent tools must agree on what the policy means.
const policy = (defaultApp: string, defaultUrl: string, rules: Array<Record<string, string>> = []) => ({
  defaultApplicationBehavior: defaultApp,
  defaultURLBehavior: defaultUrl,
  rules,
});

test("records nothing until an application is allowed", () => {
  assert.equal(shouldObserve(policy("do_not_observe", "observe"), { bundleId: "com.apple.Notes" }), false);
  assert.equal(shouldObserve(
    policy("do_not_observe", "observe", [{ scope: "app", bundleID: "com.apple.Notes", behavior: "observe" }]),
    { bundleId: "com.apple.Notes" },
  ), true);
});

test("judges a record without a usable URL by its application alone", () => {
  const settings = policy("observe", "do_not_observe");
  assert.equal(shouldObserve(settings, { bundleId: "com.apple.Notes" }), true);
  assert.equal(shouldObserve(settings, { bundleId: "com.google.Chrome", url: "https://example.com/a" }), false);
});

test("lets a block rule win over an allow rule inside the same axis", () => {
  const settings = policy("observe", "observe", [
    { scope: "url", urlDomain: "example.com", behavior: "observe" },
    { scope: "url", urlDomain: "example.com", behavior: "do_not_observe" },
  ]);
  assert.equal(shouldObserve(settings, { bundleId: "c", url: "https://example.com/a" }), false);
});

test("matches subdomains but not lookalike domains", () => {
  const settings = policy("observe", "observe", [
    { scope: "url", urlDomain: "bank.com", behavior: "do_not_observe" },
  ]);
  assert.equal(shouldObserve(settings, { bundleId: "c", url: "https://secure.bank.com/x" }), false);
  assert.equal(shouldObserve(settings, { bundleId: "c", url: "https://notbank.com/x" }), true);
});

test("keeps the two axes independent", () => {
  const settings = policy("do_not_observe", "observe", [
    { scope: "url", urlDomain: "example.com", behavior: "observe" },
  ]);
  // Allowing the site cannot rescue a disallowed application.
  assert.equal(shouldObserve(settings, { bundleId: "com.google.Chrome", url: "https://example.com/a" }), false);
});
