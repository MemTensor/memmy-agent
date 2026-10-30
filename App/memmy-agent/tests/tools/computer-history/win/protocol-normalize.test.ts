import { describe, expect, it } from "vitest";
import { NativeStreamReader, parseNativeEvent, type NativeSnapshotEvent } from "../../../../src/tools/computer-history/win/protocol.js";
import { SnapshotNormalizer } from "../../../../src/tools/computer-history/win/normalize.js";
import { authorizedRule, compileWindowsPolicy, parseNativePolicy } from "../../../../src/tools/computer-history/win/policy.js";
import { context, envelope, executable, full, policyInput, root, stats, text } from "./fixtures.js";

const policy = parseNativePolicy(policyInput);
const snapshot = (input: unknown) => parseNativeEvent(input) as NativeSnapshotEvent;
describe("Windows protocol boundary", () => {
  it("frames split UTF-8 without losing Unicode or uint64 identity", () => {
    const bytes = Buffer.from(JSON.stringify(full()) + "\n");
    const reader = new NativeStreamReader();
    const events = [...bytes].flatMap((byte) => reader.feed(Buffer.from([byte])));
    reader.end();
    expect(events).toHaveLength(1);
    expect((events[0] as NativeSnapshotEvent).context?.hwnd).toBe(context.hwnd);
    expect(JSON.stringify(events)).toContain("演示");
  });
  it.each([
    { ...full(), context: { ...context, hwnd: Number(context.hwnd) } },
    { ...full(), extra: "provider text" },
    { ...full(), sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...full(), context: { ...context, generation: "1" } },
  ])("rejects invalid protocol shape", (event) => expect(() => parseNativeEvent(event)).toThrow("windows_protocol_invalid"));
  it("rejects gaps, different sessions, reverse clocks, invalid UTF8 and unfinished frames", () => {
    for (const second of [{ ...full(), sequence: 3 }, { ...full(), sequence: 2, sessionId: "b".repeat(32) }, { ...full(), sequence: 2, monotonicMs: 0 }]) {
      const reader = new NativeStreamReader(); reader.feed(Buffer.from(JSON.stringify(full()) + "\n"));
      expect(() => reader.feed(Buffer.from(JSON.stringify(second) + "\n"))).toThrow("windows_protocol_invalid");
    }
    expect(() => new NativeStreamReader().feed(Buffer.from([0xff, 10]))).toThrow("windows_protocol_invalid");
    expect(() => new NativeStreamReader(8).feed(Buffer.alloc(9))).toThrow("line_too_large");
    const reader = new NativeStreamReader(); reader.feed(Buffer.from("{")); expect(() => reader.end()).toThrow("incomplete_line");
  });
});
describe("Windows authorization and tree reconstruction", () => {
  it("normalizes observed hooks only with authorized non-sensitive focus", () => {
    const focused = { ...text, focused: true };
    const event = full([root, focused]);
    const actions = [
      { type: "mouse_click", button: "left", x: 100, y: 200 },
      { type: "key_press", key: "Control+C" },
      { type: "text_input", pressCount: 1, redacted: true, unit: "key_press" },
      { type: "scroll", direction: "down", delta: -120 },
    ].map((action) => ({ ...action, injected: true, timestamp: event.timestamp }));
    const parsed = snapshot({ ...event, snapshot: { ...event.snapshot, focusKey: focused.key, actions, actionOverflow: true } });
    const events = new SnapshotNormalizer().normalizeEvents(parsed, policy, "r");
    expect(events.map((item) => item.eventType)).toEqual(["mouse_click", "key_press", "text_input", "scroll", "accessibility_snapshot"]);
    expect(events[2]?.details).toMatchObject({ pressCount: 1, unit: "key_press", injected: true, source: "low_level_hook" });
    expect(events[4]?.details?.actionOverflow).toBe(true);
    for (const focus of [null, { ...focused, password: true, name: undefined, redaction: "password" },
      { ...focused, password: null, name: undefined, redaction: "unknown_password" },
      { ...focused, automationId: "private", name: undefined, redaction: "sensitive_id" }]) {
      const input = full(focus ? [root, focus] : [root]);
      const blocked = snapshot({ ...input, snapshot: { ...input.snapshot, focusKey: focus?.key ?? null, actions: [actions[1]] } });
      expect(() => new SnapshotNormalizer().normalizeEvents(blocked, policy, "r")).toThrow("snapshot_invalid");
    }
  });
  it.each(["Q", "Control+Alt+Q", "Control+Q", "arbitrary typed text", "Alt+Control+C"])("rejects printable or unknown key labels: %s", (key) => {
    const event = full();
    expect(() => parseNativeEvent({ ...event, snapshot: { ...event.snapshot, actions: [{ type: "key_press", key, timestamp: event.timestamp, injected: false }] } })).toThrow();
  });
  it("rejects stale action timestamps even on a valid authorized snapshot", () => {
    const event = full();
    const input = snapshot({ ...event, snapshot: { ...event.snapshot, actions: [{ type: "mouse_click", button: "left", x: 1, y: 1,
      injected: false, timestamp: "2026-10-02T00:58:00.000Z" }] } });
    expect(() => new SnapshotNormalizer().normalizeEvents(input, policy, "r")).toThrow();
  });
  it("binds persistent rules to new instances and makes denial/browser exclusions win", () => {
    const compiled = compileWindowsPolicy([{ executable }], [{ ...context }]);
    expect(authorizedRule(compiled, context)).not.toBeNull();
    expect(authorizedRule(compiled, { ...context, processStart: "134000000000000002" })).toBeNull();
    expect(authorizedRule(parseNativePolicy({ ...policyInput, deny: { pids: [123] } }), context)).toBeNull();
    const browser = "C:\\Apps\\chrome.exe";
    expect(authorizedRule(parseNativePolicy({ version: 1, applications: [{ pid: 123, executable: browser }] }), { ...context, executable: browser })).toBeNull();
    expect(() => compileWindowsPolicy([{ executable }], [{ ...context, executable: "C:\\Other.exe" }])).toThrow("policy_invalid");
  });
  it("reconstructs a delta, retains hierarchy and discards old content", () => {
    const normalizer = new SnapshotNormalizer(); normalizer.normalize(snapshot(full()), policy, "revision");
    const newer = { ...text, key: "0000000000000003", name: "Approved release 219" };
    const delta = snapshot({ ...envelope(2), kind: "snapshot", context, trigger: { kinds: ["sample"], count: 1 },
      snapshot: { status: "ok", reason: null, mode: "delta", added: [newer], removed: [text.key], unchangedCount: 1,
        focusKey: null, truncated: false, truncation: [], stats: stats(), elapsedMs: 3 } });
    const event = normalizer.normalize(delta, policy, "revision");
    expect(event?.application?.id).toMatch(/^windows:/u);
    expect(event?.application?.bundleId).toBeUndefined();
    expect(event?.accessibility?.nodes.map((node) => node.name)).toEqual([root.name, newer.name]);
    expect(() => new SnapshotNormalizer().normalize(delta, policy, "revision")).toThrow("snapshot_invalid");
    expect(() => normalizer.normalize({ ...delta, context: { ...context, generation: 2 } }, policy, "revision")).toThrow("snapshot_invalid");
  });
  it.each([
    [{ ...text, password: true }], [{ ...text, password: null }], [{ ...text, automationId: "PRIVATE" }],
    [{ ...text, controlType: "Edit", value: "ordinary input" }],
    [{ ...text, controlType: "Edit", automationId: "search", value: "query", focused: false }],
    [{ ...text, text: "unapproved document" }], [{ ...text, redaction: "password" }],
    [text, { ...text }], [{ ...text, parentKey: "0000000000000099" }],
    [{ ...text, controlType: "Edit", redaction: "edit_control", name: undefined }, { ...text, key: "0000000000000003", parentKey: text.key, depth: 2 }],
  ].map((children) => [children]))("fails closed on privacy or hierarchy violations", (children) => {
    expect(() => new SnapshotNormalizer().normalize(snapshot(full([root, ...children])), policy, "revision")).toThrow("snapshot_invalid");
  });
  it("accepts an explicitly authorized focused search and scrubs credentials", () => {
    const search = { ...text, controlType: "Edit", automationId: "search", focused: true, name: "Search", value: "api_key=secretvalue search terms" };
    const normalized = new SnapshotNormalizer().normalize(snapshot(full([root, search])), policy, "revision");
    expect(normalized?.accessibility?.nodes[1]?.value).toContain("[REDACTED]");
    expect(JSON.stringify(normalized)).not.toContain("secretvalue");
  });
  it("rejects unauthorized contexts and invalidates the baseline on partial/blocked captures", () => {
    const normalizer = new SnapshotNormalizer();
    expect(() => normalizer.normalize(snapshot({ ...full(), context: { ...context, pid: 124 } }), policy, "r")).toThrow("not_authorized");
    const partial = full(); partial.snapshot.truncated = true; (partial.snapshot.truncation as string[]).push("max_nodes");
    normalizer.normalize(snapshot(partial), policy, "r");
    const { nodes: _nodes, ...body } = full().snapshot;
    expect(_nodes).toHaveLength(2);
    const delta = snapshot({ ...full(), snapshot: { ...body, mode: "delta", added: [], removed: [], unchangedCount: 2 } });
    expect(() => normalizer.normalize(delta, policy, "r")).toThrow();
  });
});
