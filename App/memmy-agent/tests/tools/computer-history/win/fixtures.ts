export const executable = "C:\\Apps\\Fixture.exe";
export const context = { pid: 123, executable, hwnd: "18446744073709551615", processStart: "134000000000000001",
  generation: 1, dpi: 96, bounds: { left: 0, top: 0, right: 800, bottom: 600 }, minimized: false };
export const policyInput = { version: 1, applications: [{ pid: 123, executable, processStart: context.processStart,
  hwnd: context.hwnd, searchFields: [{ controlType: "Edit", automationId: "search" }],
  documentRegions: [{ controlType: "Document", automationId: "body" }], sensitiveAutomationIds: ["private"] }] };
export const root = { key: "0000000000000001", parentKey: null, runtimeId: "1", controlType: "Window", automationId: "root",
  depth: 0, focused: false, providerOffscreen: false, password: false, name: "演示 Window" };
export const text = { ...root, key: "0000000000000002", parentKey: root.key, runtimeId: "2", controlType: "Text", depth: 1,
  automationId: "message", name: "Review release 218" };
export function stats(emitted = 2) { return { visited: emitted, emitted, redacted: 0, foreignSkipped: 0, missingProperties: 0, workerElapsedMs: 2 }; }
export const counters = { triggers: { accepted: 1, coalesced: 0, dropped: 0, discarded: 0, ignoredBackground: 0, ignoredPaused: 0 },
  queries: { started: 1, ok: 1, blocked: 0, unavailable: 0, timedOut: 0, cancelled: 0, truncated: 0, contextChanged: 0, policyChanged: 0, unchanged: 0, suppressedRepeats: 0 },
  control: { pauses: 0, resumes: 0, rejected: 0 }, hooks: { callbacks: 1, callbackMaxMs: 0.01 }, events: 1 };
export function envelope(sequence = 1) { return { protocol: "memmy.windows.computer-history", version: 1, platform: "windows",
  sessionId: "a".repeat(32), sequence, monotonicMs: sequence, timestamp: "2026-10-02T01:00:00.000Z" }; }
export function full(nodes: unknown[] = [root, text]) { return { ...envelope(), kind: "snapshot", context,
  trigger: { kinds: ["sample"], count: 1 }, snapshot: { status: "ok", reason: null, mode: "full", nodes,
    focusKey: null, truncated: false, truncation: [], stats: stats(nodes.length), elapsedMs: 3 } }; }
