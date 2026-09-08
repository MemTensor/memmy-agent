import assert from "node:assert/strict";
import test from "node:test";
import {
  isStopHotkey,
  normalizeKeyBurst,
  parseArgs,
  searchInputContextFromAccessibility,
  appFrom,
  isSecureInput,
} from "./record-human-history.mjs";

const notes = { name: "Notes", bundleId: "com.apple.Notes", pid: 42 };

// Recorder-shaped envelope: app identity lives on `app`, keystrokes on `keyboard`.
function textInput(text, application = notes, extra = {}) {
  return {
    kind: "keyboard.text_input",
    app: { name: application.name, bundleIdentifier: application.bundleId, secureInput: false },
    keyboard: { text, target: { role: "AXTextField" } },
    ...extra,
  };
}

function shortcut(keyEquivalent, modifiers, application = notes, keyCode) {
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
