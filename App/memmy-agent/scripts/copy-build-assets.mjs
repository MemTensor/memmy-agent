import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeBrowserHistorySensor } from "./generate-browser-history-sensor.mjs";

// Both desktop packages ship the same passive sensor as the Agent's History source.
await writeBrowserHistorySensor();

// Keep source resources for plugins/office, which packages them independently.
// Default App builds must not ship or advertise these built-in format skills.
const excludedOfficeSkills = ["docx", "pdf", "pptx", "xlsx"];
const excludedSkillRoots = new Set(excludedOfficeSkills.map((skill) => path.resolve("src", "skills", skill)));
const nativeSourceRoot = path.resolve("src/tools/computer-history/win/native");

const staleDirectories = [
  "dist/skills/goal",
  "dist/skills/memory",
  "dist/skills/my",
  // Computer History moved under src/tools/.
  "dist/core/agent-runtime/computer-history",
  "dist/tools/computer-history/win/native",
];
const compiled = (stem) => [`${stem}.js`, `${stem}.js.map`, `${stem}.d.ts`];
const staleFiles = [
  ...compiled("dist/core/agent-runtime/tools/self"),
  ...compiled("dist/core/agent-runtime/tools/runtime-state"),
  // Computer History and Computer Use moved under src/tools/.
  ...compiled("dist/entrypoints/frontend-bridge/computer-history-api"),
  ...compiled("dist/core/agent-runtime/tools/computer-history"),
  ...compiled("dist/core/agent-runtime/tools/computer-history-settings"),
  ...compiled("dist/core/agent-runtime/tools/computer"),
  // TypeScript does not delete outputs of removed sources on incremental builds.
  ...compiled("dist/tools/computer-use/computer"),
  // Replay from a History was removed; the build copies assets but never
  // deletes one that is gone from src/.
  "dist/tools/computer-use/replay-cua.sh",
];

for (const target of staleDirectories) fs.rmSync(target, { recursive: true, force: true });
for (const target of staleFiles) fs.rmSync(target, { force: true });
// Remove earlier Office-enabled outputs as well as excluding fresh copies.
for (const skill of excludedOfficeSkills) {
  fs.rmSync(path.join("dist", "skills", skill), { recursive: true, force: true });
}

// src/tools holds what Computer History runs besides compiled TypeScript: the
// Swift helpers. They are found beside the compiled
// modules at runtime, so they have to be copied there.
for (const source of ["src/templates", "src/skills", "src/tools"]) {
  const destination = path.join("dist", path.relative("src", source));
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (entry) => !excludedSkillRoots.has(path.resolve(entry)) && path.resolve(entry) !== nativeSourceRoot
      && !entry.endsWith(".ts") && path.basename(entry) !== ".gitkeep",
  });
}

// Both current and pre-migration renderers can survive an incremental build.
for (const renderer of ["office-rendering", "docx-rendering"]) {
  fs.rmSync(path.join("dist", "extra-dependencies", renderer), {
    recursive: true,
    force: true,
  });
}

// Windows npm build produces the same recorder that NSIS builds from source.
// Other hosts may explicitly cross-build; a normal Mac build never requires Go.
if ((process.env.MEMMY_BUILD_TARGET_PLATFORM ?? process.platform) === "win32") {
  const arch = process.env.MEMMY_BUILD_TARGET_ARCH || process.arch;
  const directory = arch === "x64" ? "amd64" : arch;
  execFileSync(process.execPath, [
    fileURLToPath(new URL("../../../scripts/internal/win/build-memmy-computer-history.mjs", import.meta.url)),
    path.resolve("dist/native-computer-history/windows", directory, "memmy-computer-history.exe"), arch,
  ], { stdio: "inherit" });
}
