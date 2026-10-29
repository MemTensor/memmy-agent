import { describe, expect, it } from "vitest";
import { formatMessage } from "../messages.js";

describe("formatMessage literal values", () => {
  it.each(["$&", "$`", "$'", "\\path\\to\\file", "{name}", "{kind}"])
    ("preserves replacement syntax and token text in %s", (name) => {
      expect(formatMessage("Before {name} After", { name })).toBe(`Before ${name} After`);
    });
  it.each([
    { name: "{kind} {name}", kind: "app tool" },
    { kind: "app tool", name: "{kind} {name}" }
  ])("does not interpret values as further tokens regardless of entry order", (values) => {
    expect(formatMessage("{name} / {kind}", values)).toBe("{kind} {name} / app tool");
  });
  it("replaces repeated original tokens and preserves unknown ones", () => {
    expect(formatMessage("{name}/{missing}/{name}/{missing}", { name: "A" })).toBe("A/{missing}/A/{missing}");
  });
  it("preserves numeric zero, empty strings, and an empty own key", () => {
    expect(formatMessage("{zero}|{empty}|{}", { zero: 0, empty: "", "": "empty key" })).toBe("0||empty key");
  });
  it("keeps explicitly supplied nullish runtime values literal", () => {
    const values = { nullValue: null, undefinedValue: undefined } as unknown as Parameters<typeof formatMessage>[1];
    expect(formatMessage("{nullValue}/{undefinedValue}", values)).toBe("null/undefined");
  });
  it("uses own enumerable values and leaves absent values unchanged", () => {
    const values = Object.assign(Object.create({ name: "inherited" }), { kind: "tool" });
    Object.defineProperty(values, "hidden", { value: "private", enumerable: false });
    expect(formatMessage("{name}/{kind}/{hidden}", values)).toBe("{name}/tool/{hidden}");
    expect(formatMessage("{name}")).toBe("{name}");
  });
});
