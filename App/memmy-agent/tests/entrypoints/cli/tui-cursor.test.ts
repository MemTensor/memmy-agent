import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveComposerCursorPosition } from "../../../src/entrypoints/cli/tui-cursor.js";

describe("TUI composer cursor", () => {
  it("keeps the fullscreen correction wired into the live composer", () => {
    const tuiSource = readFileSync(
      new URL("../../../src/entrypoints/cli/tui.tsx", import.meta.url),
      "utf8",
    );

    expect(tuiSource).toMatch(
      /resolveComposerCursorPosition\(\{\s*cursorCells,\s*layout,\s*rowWidth,\s*terminalRows:\s*rows\s*\}\)/,
    );
    expect(tuiSource).toMatch(/<ComposerInput[\s\S]*?rows=\{rows\}[\s\S]*?\/>/);
  });

  it("uses the measured text row when the output is shorter than the terminal", () => {
    expect(
      resolveComposerCursorPosition({
        cursorCells: 8,
        layout: { outputHeight: 29, x: 2, y: 20 },
        rowWidth: 78,
        terminalRows: 30,
      }),
    ).toEqual({ x: 10, y: 20 });
  });

  it("compensates for Ink fullscreen output omitting its trailing newline", () => {
    expect(
      resolveComposerCursorPosition({
        cursorCells: 8,
        layout: { outputHeight: 30, x: 2, y: 20 },
        rowWidth: 78,
        terminalRows: 30,
      }),
    ).toEqual({ x: 10, y: 21 });
  });

  it("keeps the fullscreen compensation when the input wraps", () => {
    expect(
      resolveComposerCursorPosition({
        cursorCells: 84,
        layout: { outputHeight: 42, x: 2, y: 35 },
        rowWidth: 78,
        terminalRows: 30,
      }),
    ).toEqual({ x: 8, y: 37 });
  });
});
