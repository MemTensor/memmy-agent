import fs from "node:fs";
import path from "node:path";

const staleDirectories = ["dist/skills/goal", "dist/skills/memory", "dist/skills/my"];
const staleFiles = [
  "dist/core/agent-runtime/tools/self.js",
  "dist/core/agent-runtime/tools/self.js.map",
  "dist/core/agent-runtime/tools/self.d.ts",
  "dist/core/agent-runtime/tools/runtime-state.js",
  "dist/core/agent-runtime/tools/runtime-state.js.map",
  "dist/core/agent-runtime/tools/runtime-state.d.ts",
];

for (const target of staleDirectories) fs.rmSync(target, { recursive: true, force: true });
for (const target of staleFiles) fs.rmSync(target, { force: true });

for (const source of ["src/templates", "src/skills"]) {
  const destination = path.join("dist", path.relative("src", source));
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (entry) => !entry.endsWith(".ts"),
  });
}
