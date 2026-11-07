import { describe, expect, it } from "vitest";
import { nativeTaskEvent } from "../../../src/tools/computer-recordings/windows-driver.js";
import { parseNativeEvent } from "../../../src/tools/computer-history/win/protocol.js";
import { full } from "../computer-history/win/fixtures.js";

describe("independent task recording protocol", () => {
  it("preserves QPC as decimal strings beyond JS integer precision", () => {
    const event = { ...full(), protocol: "memmy.windows.task-recording", monotonicMs: 1,
      task: { qpcOrigin: "9007199254740993000", qpcFrequency: "10000000", qpc: "9007199254741003000", actionQpc: [], unsupportedActions: 0 } };
    expect(nativeTaskEvent(event).clock.qpcOrigin).toBe("9007199254740993000");
    expect(() => parseNativeEvent(event)).toThrow("windows_protocol_invalid");
    expect(parseNativeEvent(full()).version).toBe(1);
  });
  it("refuses mismatched clocks, missing input timestamps, and input after the enclosing event", () => {
    const baseline = { ...full(), protocol: "memmy.windows.task-recording", monotonicMs: 1,
      task: { qpcOrigin: "10000", qpcFrequency: "10000000", qpc: "20000", actionQpc: [], unsupportedActions: 0 } };
    expect(() => nativeTaskEvent({ ...baseline, monotonicMs: 100 })).toThrow("task_clock_invalid");
    expect(() => nativeTaskEvent({ ...baseline, task: { ...baseline.task, actionQpc: ["21000"] } })).toThrow("task_action_clock_invalid");
    expect(() => nativeTaskEvent({ ...baseline, task: { ...baseline.task, qpcFrequency: "0" } })).toThrow();
  });
});
