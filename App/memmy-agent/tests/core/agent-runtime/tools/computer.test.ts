import { describe, expect, it } from "vitest";
import {
  ComputerTypeTool,
  physicalKeyComboForCharacter,
} from "../../../../src/core/agent-runtime/tools/computer.js";

describe("computer input helper", () => {
  it("steers callers to establish and verify focus", () => {
    const description = new ComputerTypeTool().description.toLowerCase();

    expect(description).toContain("click the target field first");
    expect(description).toContain("verify the typed text");
    expect(description).toContain("physical key events");
  });

  it("maps Spotlight search text to physical key combos", () => {
    expect([..."Notes"].map(physicalKeyComboForCharacter)).toEqual([
      "shift+n",
      "o",
      "t",
      "e",
      "s",
    ]);
    expect(physicalKeyComboForCharacter("\n")).toBe("return");
    expect(physicalKeyComboForCharacter("中")).toBeNull();
  });

  it("types complete URLs with physical key events, including shifted punctuation", () => {
    expect([..."https://www.apple.com/"].map(physicalKeyComboForCharacter)).toEqual([
      "h", "t", "t", "p", "s", "shift+;", "/", "/", "w", "w", "w", ".",
      "a", "p", "p", "l", "e", ".", "c", "o", "m", "/",
    ]);
    expect(physicalKeyComboForCharacter("?")).toBe("shift+/");
    expect(physicalKeyComboForCharacter("_")).toBe("shift+-");
  });
});
