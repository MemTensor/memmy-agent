import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeMailtoUrl } from "../src/main/mailto-url.js";

const mainSourcePath = fileURLToPath(new URL("../src/main/main.ts", import.meta.url));

describe("desktop mailto URLs", () => {
  it("normalizes only mailto URLs", () => {
    expect(normalizeMailtoUrl(" mailto:a@example.com ")).toBe("mailto:a@example.com");
    expect(() => normalizeMailtoUrl("https://example.com")).toThrow("rejected non-mailto url");
    expect(() => normalizeMailtoUrl("mailto:a@example.com\nBcc:x@example.com")).toThrow("rejected mailto url with control characters");
    expect(() => normalizeMailtoUrl("file:///tmp/a")).toThrow("rejected non-mailto url");
    expect(() => normalizeMailtoUrl("javascript:alert(1)")).toThrow("rejected non-mailto url");
  });

  it("keeps mailto opening separate from existing http external links", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).toContain('ipcMain.handle("memmy:openExternal"');
    expect(source).toContain("await openExternalUrl(url);");
    expect(source).toContain("function normalizeHttpUrl(rawUrl: string): string");
    expect(source).toContain("targetWindow.webContents.setWindowOpenHandler(({ url }) => {");
    expect(source).toContain("void openExternalUrl(url);");
    expect(source).toContain("void openExternalUrl(command.url).catch");
    expect(source).toContain('ipcMain.handle("memmy:openMailto"');
    expect(source).toContain('ipcMain.removeHandler("memmy:openMailto"');
  });
});
