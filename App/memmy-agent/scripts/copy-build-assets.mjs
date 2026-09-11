import fs from "node:fs";
import path from "node:path";

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
];

for (const target of staleDirectories) fs.rmSync(target, { recursive: true, force: true });
for (const target of staleFiles) fs.rmSync(target, { force: true });

// src/tools holds what Computer History runs besides compiled TypeScript: the
// Swift helpers and the replay script. They are found beside the compiled
// modules at runtime, so they have to be copied there.
for (const source of ["src/templates", "src/skills", "src/tools"]) {
  const destination = path.join("dist", path.relative("src", source));
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (entry) => !entry.endsWith(".ts") && path.basename(entry) !== ".gitkeep",
  });
}
