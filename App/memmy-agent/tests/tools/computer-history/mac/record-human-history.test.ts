import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  isStopHotkey,
  normalizeKeyBurst,
  parseArgs,
  searchInputContextFromAccessibility,
  appFrom,
  isSecureInput,
  recordingStep,
  scrubAccessibility,
  scrubAxSnapshot,
  shouldObserve,
} from "../../../../src/tools/computer-history/mac/record-human-history.js";
import type {
  ObservationBehavior,
  ObservationRule,
  ObservationSettings,
} from "../../../../src/tools/computer-history/mac/observation-settings.js";

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

test("allows observed text capture without a second app allowlist", () => {
  const args = parseArgs(["node", "recorder", "--capture-text"]);
  assert.equal(args.captureText, true);
  assert.deepEqual(args.allowApps, []);
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
  assert.equal(searchInputContextFromAccessibility({
    role: "AXTextField", subrole: "AXSecureTextField", description: "Search password",
  }), null);
  assert.equal(searchInputContextFromAccessibility({
    role: "AXGroup", children: [{ role: "AXSearchField", description: "Search elsewhere" }],
  }), null);
  assert.equal(searchInputContextFromAccessibility({
    role: "AXSearchField", focused: { role: "AXTextField", description: "Customer ID" },
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

test("retains ordinary text in observed applications when no text allowlist is supplied", () => {
  const notesText = [..."project note"].map((character) => textInput(character));
  const chat = { name: "DingTalk", bundleId: "com.alibaba.DingTalkMac", pid: 44 };
  const chatText = [..."明天下午讨论"].map((character) => textInput(character, chat));
  const options = { captureText: true, allowApps: [] };
  assert.deepEqual(normalizeKeyBurst(notesText, options).details, {
    text: "project note", characterCount: 12, redacted: false,
  });
  assert.deepEqual(normalizeKeyBurst(chatText, options).details, {
    text: "明天下午讨论", characterCount: 6, redacted: false,
  });
  assert.deepEqual(normalizeKeyBurst(chatText, { captureText: true, allowApps: ["com.apple.Notes"] }).details, {
    text: "[REDACTED]", characterCount: 6, redacted: true,
  });
});

test("withholds typed characters only when the target is a password field", () => {
  for (const target of [
    { role: "AXSecureTextField" },
    { role: "AXTextField", subrole: "AXSecureTextField" },
    { role: "AXSecureTextField", focused: { role: "AXTextField" } },
    { role: "ControlType.Edit", isPassword: true },
  ]) {
    const event = textInput("hunter2", notes, { keyboard: { text: "hunter2", target } });
    assert.equal(normalizeKeyBurst([event], { captureText: true, allowApps: [] }).details.text, "[REDACTED]");
  }
  // Apps such as WeChat do not report their focused input; that is not a password field.
  for (const target of [{ role: "AXUnknown" }, undefined]) {
    const event = textInput("你好", notes, { keyboard: { text: "你好", target } });
    assert.deepEqual(normalizeKeyBurst([event], { captureText: true, allowApps: [] }).details, {
      text: "你好", characterCount: 2, redacted: false,
    });
  }
  assert.equal(isSecureInput(textInput("x", notes, {
    keyboard: { text: "x", target: { role: "AXTextField", subrole: "AXSecureTextField" } },
  })), true);
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

test("legacy Shift/Option text cannot bypass retention by masquerading as shortcuts", () => {
  for (const secureInput of [false, true]) {
    for (const [key, modifiers] of [["A", ["shift"]], ["!", ["shift"]], ["é", ["option"]]] as const) {
      const event = shortcut(key, [...modifiers]);
      event.app.secureInput = secureInput;
      assert.deepEqual(normalizeKeyBurst([event], {
        captureText: false, allowApps: [],
      }).details.keys, ["[REDACTED]"]);
    }
  }
  assert.deepEqual(normalizeKeyBurst([shortcut("C", ["cmd", "shift"])], {
    captureText: false, allowApps: [],
  }).details.keys, ["cmd+shift+C"]);
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

// The capture path now asks the shared policy directly. These cases stay as a
// check that it does, rather than keeping a copy of its own.
const policy = (
  defaultApp: ObservationBehavior,
  defaultUrl: ObservationBehavior,
  rules: ObservationRule[] = [],
): ObservationSettings => ({
  memory: { syncEnabled: false },
  observation: { defaultApplicationBehavior: defaultApp, defaultURLBehavior: defaultUrl, rules },
});

test("records browser windows by the user's application and website rules alone", () => {
  const everything = policy("observe", "observe", [
    { scope: "app", bundleID: "com.google.Chrome", behavior: "observe" },
  ]);
  assert.equal(shouldObserve(everything, { bundleId: "com.google.Chrome", url: "https://example.com/" }), true);
  const withoutChrome = policy("observe", "observe", [
    { scope: "app", bundleID: "com.google.Chrome", behavior: "do_not_observe" },
  ]);
  assert.equal(shouldObserve(withoutChrome, { bundleId: "com.google.Chrome", url: "https://example.com/" }), false);
});

test("never records the login window or the screen saver, whatever the rules say", () => {
  // A locked Mac used to produce a summary of the lock screen for every
  // window of the night.
  const everything = policy("observe", "observe", [
    { scope: "app", bundleID: "com.apple.loginwindow", behavior: "observe" },
  ]);
  assert.equal(shouldObserve(everything, { bundleId: "com.apple.loginwindow" }), false);
  assert.equal(shouldObserve(everything, { bundleId: "com.apple.ScreenSaver.Engine" }), false);
  assert.equal(shouldObserve(null, { bundleId: "com.apple.loginwindow" }), false);
  assert.equal(shouldObserve(everything, { bundleId: "com.apple.Notes" }), true);
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

// ---- What reaches disk ----

test("keeps what a window says, including what is in its text areas", () => {
  // Withholding every text area's value emptied the summaries: a text area is
  // as often a terminal, a transcript or a document as a draft.
  const scrubbed = scrubAccessibility({
    role: "AXTextArea",
    title: "国蝻分部",
    value: "说不定可以吗",
    focused: { role: "AXStaticText", value: "Mom: see you at 7" },
  }) as Record<string, any>;
  assert.equal(scrubbed.value, "说不定可以吗");
  assert.equal(scrubbed.focused.value, "Mom: see you at 7");
});

test("withholds a password field and masks credentials anywhere", () => {
  const scrubbed = scrubAccessibility({
    role: "AXTextField",
    subrole: "AXSecureTextField",
    value: "hunter2",
    descendants: [
      { role: "AXButton", title: "Bearer abcdefghijklmnop1234" },
      { role: "AXTextField", value: "demo-secret-value-123" },
    ],
  }) as Record<string, any>;
  assert.equal(scrubbed.value, "[REDACTED]");
  assert.equal(scrubbed.descendants, undefined);
  assert.equal((scrubAccessibility({ role: "AXSecureTextField", value: "role-only secret" }) as any).value, "[REDACTED]");
  assert.equal((scrubAccessibility({ role: "ControlType.Edit", isPassword: true, value: "provider secret" }) as any).value, "[REDACTED]");
  const provider = scrubAccessibility({ role: "ControlType.Edit", isPassword: true,
    title: "password in name", description: "password in description", identifier: "password in id",
    value: "provider secret", focused: { role: "AXTextField", value: "password in child" } });
  assert.doesNotMatch(JSON.stringify(provider), /password in|provider secret/);
});

test("removes Dock window and application labels from nested accessibility payloads", () => {
  const privateWindow = {
    role: "AXDockItem", subrole: "AXMinimizedWindowDockItem",
    title: "微博 – 随时随地发现新鲜事", value: "https://weibo.com/",
    ancestors: [{ role: "AXApplication", title: "Dock" }],
  };
  assert.deepEqual(scrubAccessibility({
    accessibility: privateWindow,
    origin: { element: { ...privateWindow, role: "AXUnknown" } },
    destination: { element: { role: "AXDockItem", subrole: "AXApplicationDockItem", title: "钉钉" } },
    allowed: { role: "AXButton", title: "Save" },
  }), {
    accessibility: { role: "AXUnknown" },
    origin: { element: { role: "AXUnknown" } },
    destination: { element: { role: "AXUnknown" } },
    allowed: { role: "AXButton", title: "Save" },
  });
});

test("removes Dock titles from full and delta window snapshots", () => {
  const snapshot = scrubAxSnapshot({ mode: "fullTree", text: [
    "AXStaticText||Allowed document|||",
    "AXDockItem|AXMinimizedWindowDockItem|微博 – 随时随地发现新鲜事||https://weibo.com/|",
    "+ AXDockItem|AXApplicationDockItem|钉钉|||",
    "- AXUnknown|AXMinimizedWindowDockItem|Private account|||",
  ].join("\n") }) as { text: string };
  assert.equal(snapshot.text, [
    "AXStaticText||Allowed document|||", "AXUnknown|||||",
    "+ AXUnknown|||||", "- AXUnknown|||||",
  ].join("\n"));
});

test("keeps allowed window snapshots readable, full or diff, masking credentials", () => {
  const full = scrubAxSnapshot({
    mode: "fullTree",
    focused: { role: "AXTextField", value: "api_key=focused-secret-value" },
    text: [
      "AXStaticText||Inbox|||",
      "AXTextArea||Body|||the plan for Friday",
      "AXTextField|AXSecureTextField|Password|||hunter2",
      "AXSecureTextField||Password|||role-only secret",
      "AXSecureTextField||password in title|password in description|password in id|hunter2",
      "AXStaticText||||| token: demo-secret-value-123",
    ].join("\n"),
  }) as { text: string; focused: { value: string } };
  assert.match(full.text, /the plan for Friday/);
  assert.doesNotMatch(full.text, /hunter2|role-only secret|password in|demo-secret-value/);
  assert.equal(full.focused.value, "api_key=[REDACTED]");
  assert.doesNotMatch(JSON.stringify(full), /focused-secret-value/);
  const diff = scrubAxSnapshot({
    mode: "diffFromPrevious",
    text: ["- AXTextField||Search|||old query", "+ AXTextField||Search|||new query"].join("\n"),
  }) as { text: string };
  assert.match(diff.text, /^- AXTextField\|\|Search\|\|\|old query$/m);
  assert.match(diff.text, /^\+ AXTextField\|\|Search\|\|\|new query$/m);
});

// ---- The event chain ----

test("one failed event no longer stops every event after it", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const fatal = vi.fn();
  const step = recordingStep(fatal);
  const written: number[] = [];
  let chain: Promise<void> = Promise.resolve();
  for (const n of [1, 2, 3, 4]) {
    chain = chain.then(step(async () => {
      if (n === 2) throw new TypeError("a malformed helper event");
      written.push(n);
    }));
  }
  await chain;
  assert.deepEqual(written, [1, 3, 4]);
  assert.equal(fatal.mock.calls.length, 0);

  // A write that fails cannot be retried, so it ends the recording visibly.
  const failure = Object.assign(new Error("no such directory"), { code: "ENOENT" });
  await step(async () => { throw failure; })();
  assert.equal(fatal.mock.calls.length, 1);
  errors.mockRestore();
});
