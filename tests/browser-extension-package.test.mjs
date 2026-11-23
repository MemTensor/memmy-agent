import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { verifyBrowserExtension } from "../scripts/internal/shared/verify-browser-extension.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "App/shell/desktop/extensions/memmy-browser");
const temporary = [];
function fixture() {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-extension-package-"));
  temporary.push(destination); fs.cpSync(source, destination, { recursive: true }); return destination;
}
afterEach(() => { for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe("packaged browser extension provenance", () => {
  it("records the frozen version and hashes of new History assets", () => {
    const result = verifyBrowserExtension(source, fixture());
    expect(result.version).toBe("1.0.12");
    for (const file of ["browser-history-background.js", "history-sensor.js", "history-content.js"])
      expect(result.files[file]).toMatch(/^[a-f0-9]{64}$/u);
  });
  it.each(["missing", "outdated"])("refuses a %s History sensor", condition => {
    const destination = fixture(), file = path.join(destination, "history-sensor.js");
    if (condition === "missing") fs.unlinkSync(file); else fs.appendFileSync(file, "\n// stale asset\n");
    expect(() => verifyBrowserExtension(source, destination)).toThrow();
  });
  it("refuses page-world capture or new privileged permissions", () => {
    const destination = fixture(), file = path.join(destination, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest.content_scripts[0].world = "MAIN"; fs.writeFileSync(file, JSON.stringify(manifest));
    expect(() => verifyBrowserExtension(source, destination)).toThrow(/isolated/u);
    manifest.content_scripts[0].world = "ISOLATED"; manifest.permissions.push("cookies"); fs.writeFileSync(file, JSON.stringify(manifest));
    expect(() => verifyBrowserExtension(source, destination)).toThrow(/permission scope/u);
  });
  it("guards both Mac and Windows final resource folders", () => {
    for (const file of ["scripts/internal/mac/build-dmg.sh", "scripts/internal/win/build-nsis.sh"])
      expect(fs.readFileSync(path.join(root, file), "utf8")).toContain("verify-browser-extension.mjs");
  });
});
