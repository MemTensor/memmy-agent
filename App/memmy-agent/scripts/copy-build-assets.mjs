import fs from "node:fs";
import path from "node:path";

// Keep Office source available for future work, but do not ship or advertise
// its built-in skills in the v1.1.6 Computer Use candidate.
const excludedOfficeSkills = ["docx", "pptx", "xlsx"];
const excludedSkillRoots = new Set(excludedOfficeSkills.map((skill) => path.resolve("src", "skills", skill)));

const staleDirectories = [
  "dist/skills/goal",
  "dist/skills/memory",
  "dist/skills/my",
  // Computer History moved under src/tools/.
  "dist/core/agent-runtime/computer-history",
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
    filter: (entry) => !excludedSkillRoots.has(path.resolve(entry))
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
