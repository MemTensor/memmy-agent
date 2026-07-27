import { describe, expect, it, vi } from "vitest";
import {
  buildToolEventFinishPayloads,
  onProgressAcceptsFileEditEvents,
  onProgressAcceptsReasoning,
  onProgressAcceptsToolEvents,
  sanitizeToolEventResult,
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

describe("tool progress result sanitization", () => {
  it("replaces inline images with saved artifact references", () => {
    const sanitized = sanitizeToolEventResult([
      { type: "text", text: "page screenshot" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,secret", detail: "auto" },
        meta: { path: "/tmp/tool-results/screenshot.png" },
      },
    ]);

    expect(sanitized).toEqual({
      result: [
        { type: "text", text: "page screenshot" },
        { type: "text", text: "[image: /tmp/tool-results/screenshot.png]" },
      ],
      files: ["/tmp/tool-results/screenshot.png"],
    });
    expect(JSON.stringify(sanitized)).not.toContain("base64");
  });

  it("keeps the model result separate from the sanitized frontend trace", () => {
    const original = [
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,abc", detail: "auto" },
        meta: { path: "/tmp/screenshot.png" },
      },
    ];

    const [payload] = buildToolEventFinishPayloads({
      toolCalls: [{ id: "call-1", name: "browser_take_screenshot", arguments: {} }],
      toolResults: [original],
      toolEvents: [{ status: "ok" }],
    });

    expect(payload.result).toEqual([
      { type: "text", text: "[image: /tmp/screenshot.png]" },
    ]);
    expect(payload.files).toEqual(["/tmp/screenshot.png"]);
    expect(original[0].image_url.url).toContain("base64,abc");
  });
});
