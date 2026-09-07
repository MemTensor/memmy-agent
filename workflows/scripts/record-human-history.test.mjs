import assert from "node:assert/strict";
import test from "node:test";
import {
  isStopHotkey,
  normalizeKeyBurst,
  normalizeScrollBurst,
  parseArgs,
  searchInputContextFromAccessibility,
} from "./record-human-history.mjs";

const notes = { name: "Notes", bundleId: "com.apple.Notes", pid: 42 };

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
  const events = [..."Notes"].map((characters) => ({
    characters,
    key: characters,
    modifiers: [],
    application: notes,
  }));

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
  const searchEvents = [..."usb hub"].map((characters) => ({
    characters,
    key: characters,
    modifiers: [],
    application: chrome,
    inputContext: searchContext,
  }));
  const ordinaryEvents = [..."private note"].map((characters) => ({
    characters,
    key: characters,
    modifiers: [],
    application: chrome,
  }));
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
  const event = {
    characters: " ",
    key: "space",
    modifiers: ["cmd"],
    application: notes,
  };
  const normalized = normalizeKeyBurst([event], { captureText: true, allowApps: ["com.apple.Notes"] });

  assert.equal(normalized.eventType, "key_press");
  assert.deepEqual(normalized.details.keys, ["cmd+space"]);
});

test("redacts credential-like text even in an allowed application", () => {
  const text = "api_key=super-secret-value";
  const events = [...text].map((characters) => ({
    characters,
    key: characters,
    modifiers: [],
    application: notes,
  }));
  const normalized = normalizeKeyBurst(events, {
    captureText: true,
    allowApps: ["com.apple.Notes"],
  });

  assert.equal(normalized.details.text, "api_key=[REDACTED]");
});

test("recognizes only the dedicated global stop shortcut", () => {
  assert.equal(isStopHotkey({
    type: "key_down",
    keyCode: 15,
    modifiers: ["control", "option", "cmd"],
  }), true);
  assert.equal(isStopHotkey({
    type: "key_down",
    keyCode: 15,
    modifiers: ["cmd"],
  }), false);
});

test("collapses one physical scroll gesture into a semantic burst", () => {
  const normalized = normalizeScrollBurst([
    { deltaX: 0, deltaY: -4, application: notes },
    { deltaX: 1, deltaY: -7, application: notes },
    { deltaX: 0, deltaY: -3, application: notes },
  ]);

  assert.equal(normalized.eventType, "scroll");
  assert.deepEqual(normalized.details, {
    deltaX: 1,
    deltaY: -14,
    direction: "down",
    sampleCount: 3,
  });
});
