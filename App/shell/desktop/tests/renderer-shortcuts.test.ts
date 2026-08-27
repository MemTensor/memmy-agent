/** Renderer shortcuts tests. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shouldBlockRendererReloadShortcut } from "../src/main/renderer-shortcuts.js";

const mainSourcePath = fileURLToPath(new URL("../src/main/main.ts", import.meta.url));

describe("desktop renderer shortcuts", () => {
  it("blocks renderer reload shortcuts", () => {
    expect(shouldBlockRendererReloadShortcut({ type: "keyDown", key: "r", code: "KeyR", meta: true })).toBe(true);
    expect(shouldBlockRendererReloadShortcut({ type: "keyDown", key: "R", code: "KeyR", control: true })).toBe(true);
    expect(shouldBlockRendererReloadShortcut({ type: "keyDown", key: "R", code: "KeyR", meta: true, control: true, shift: true })).toBe(true);
  });

  it("leaves unrelated keyboard input alone", () => {
    expect(shouldBlockRendererReloadShortcut({ type: "keyUp", key: "r", code: "KeyR", meta: true })).toBe(false);
    expect(shouldBlockRendererReloadShortcut({ type: "keyDown", key: "r", code: "KeyR" })).toBe(false);
    expect(shouldBlockRendererReloadShortcut({ type: "keyDown", key: "r", code: "KeyR", meta: true, alt: true })).toBe(false);
    expect(shouldBlockRendererReloadShortcut({ type: "keyDown", key: "t", code: "KeyT", meta: true })).toBe(false);
  });

  it("attaches shortcut guards to every renderer window", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).toContain("attachRendererShortcutGuards(targetMainWindow);");
    expect(source).toContain("attachRendererShortcutGuards(petWindow);");
    expect(source).toContain('targetWindow.webContents.on("before-input-event"');
    expect(source).toContain("shouldBlockRendererReloadShortcut(input)");
  });
});
