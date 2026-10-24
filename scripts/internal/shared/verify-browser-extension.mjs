#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const BROWSER_EXTENSION_REQUIRED_FILES = ["manifest.json", "background.js", "browser-history-background.js",
  "history-sensor.js", "history-content.js", "popup.html", "popup.js", "auth.html", "auth.js"];

export function verifyBrowserExtension(source, packaged) {
  const sourceManifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(packaged, "manifest.json"), "utf8"));
  const expectedScripts = ["history-sensor.js", "history-content.js"];
  if (manifest.manifest_version !== 3 || manifest.version !== sourceManifest.version
    || JSON.stringify(manifest.host_permissions) !== JSON.stringify(["http://127.0.0.1/*", "http://*/*", "https://*/*"])
    || JSON.stringify(manifest.permissions) !== JSON.stringify(["tabs", "debugger", "storage", "alarms", "scripting"])
    || manifest.content_scripts?.length !== 1) throw new Error("Packaged browser extension identity or permission scope is invalid");
  const [content] = manifest.content_scripts;
  if (JSON.stringify(content.matches) !== JSON.stringify(["http://*/*", "https://*/*"])
    || JSON.stringify(content.js) !== JSON.stringify(expectedScripts) || content.world !== "ISOLATED"
    || content.all_frames !== true || content.match_about_blank !== false || content.run_at !== "document_start") {
    throw new Error("Packaged browser History scripts must remain isolated and restricted to ordinary HTTP(S) frames");
  }
  const hashes = {};
  for (const name of BROWSER_EXTENSION_REQUIRED_FILES) {
    const expected = fs.readFileSync(path.join(source, name)), actual = fs.readFileSync(path.join(packaged, name));
    if (!expected.equals(actual)) throw new Error(`Packaged browser extension differs from frozen source: ${name}`);
    hashes[name] = createHash("sha256").update(actual).digest("hex");
  }
  const background = fs.readFileSync(path.join(packaged, "background.js"), "utf8");
  if (!background.includes(`const EXTENSION_VERSION = "${manifest.version}";`)
    || !background.includes('importScripts("browser-history-background.js")')) {
    throw new Error("Packaged browser extension worker version or History import is inconsistent");
  }
  return { version: manifest.version, files: hashes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [source, packaged] = process.argv.slice(2);
  if (!source || !packaged) throw new Error("Usage: verify-browser-extension.mjs <source-extension-directory> <packaged-extension-directory>");
  console.log(JSON.stringify(verifyBrowserExtension(source, packaged)));
}
