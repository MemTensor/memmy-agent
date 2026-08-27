import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mainSourcePath = fileURLToPath(new URL("../src/main/main.ts", import.meta.url));

describe("Windows task notification sound", () => {
  it("keeps the standard notification payload and adds sound only on Windows when enabled", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).toContain('? { ...payload, silent: true }');
    expect(source).toContain(": payload);");
    expect(source).toContain('if (process.platform === "win32" && !payload.silent) {');
    expect(source).toContain("shell.beep();");
    expect(source).not.toContain("toastXml");
  });
});
