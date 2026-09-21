#!/usr/bin/env node
import { lstatSync, statSync } from "node:fs";
import path from "node:path";

// Read-only staging guard. Run before an installer/archive is built; never
// remove source or silently discard an unexpected runtime payload here.
if (process.argv.length !== 3) throw new Error("Usage: check-office-slim-assets.mjs AGENT_RUNTIME_ROOT");
const root = path.resolve(process.argv[2]);
let hasDist = false;
try {
  hasDist = statSync(path.join(root, "dist")).isDirectory();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (!hasDist) throw new Error(`Runtime dist directory is missing: ${root}`);

const forbidden = [
  "dist/skills/docx", "dist/skills/pptx", "dist/skills/xlsx",
  "dist/extra-dependencies/office-rendering", "dist/extra-dependencies/docx-rendering",
];
const present = forbidden.filter((relative) => {
  try {
    lstatSync(path.join(root, relative));
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return false;
  }
});
if (present.length) throw new Error(`Office assets must be absent from the slim runtime: ${present.join(", ")}`);
console.log("Office slim runtime asset boundary passed");
