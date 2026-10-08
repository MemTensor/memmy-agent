import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveExternalBrowserExtensionDirectory } from "../src/main/external-browser-extension-directory.js";

it("locates a valid packaged extension on either desktop platform", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-ext-dir-"));
  try {
    const extension = path.join(root, "browser-extension");
    fs.mkdirSync(extension);
    fs.writeFileSync(path.join(extension, "manifest.json"), JSON.stringify({ manifest_version: 3 }));
    fs.writeFileSync(path.join(extension, "background.js"), "");
    expect(resolveExternalBrowserExtensionDirectory(root)).toBe(extension);
    fs.rmSync(path.join(extension, "background.js"));
    expect(resolveExternalBrowserExtensionDirectory(root)).not.toBe(extension);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
