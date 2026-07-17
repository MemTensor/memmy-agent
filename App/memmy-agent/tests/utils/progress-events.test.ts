import { describe, expect, it, vi } from "vitest";
import {
  onProgressAcceptsFileEditEvents,
  onProgressAcceptsReasoning,
  onProgressAcceptsToolEvents,
  withProgressCapabilities,
} from "../../src/utils/progress-events.js";

describe("progress event capabilities", () => {
  it("does not infer structured support from callback arity", () => {
    const zeroArg = vi.fn();
    const twoArg = (_content: string, _opts?: Record<string, any>) => {};

    expect(onProgressAcceptsToolEvents(zeroArg)).toBe(false);
    expect(onProgressAcceptsFileEditEvents(twoArg)).toBe(false);
    expect(onProgressAcceptsReasoning(twoArg)).toBe(false);
  });

  it("uses explicit capability markers", () => {
    const callback = withProgressCapabilities(vi.fn(), {
      toolEvents: true,
      fileEditEvents: true,
      reasoning: true,
    });

    expect(onProgressAcceptsToolEvents(callback)).toBe(true);
    expect(onProgressAcceptsFileEditEvents(callback)).toBe(true);
    expect(onProgressAcceptsReasoning(callback)).toBe(true);
  });
});
