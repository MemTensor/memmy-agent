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
for (const required of [
  path.join("src", "skills", "pptx", "SKILL.md"),
  path.join("src", "skills", "pptx", "schemas", "SCHEMA-MANIFEST.json"),
  path.join("src", "skills", "xlsx", "SKILL.md"),
]) {
  if (!fs.existsSync(required)) throw new Error(`Missing required skill asset: ${required}`);
}
// Replace document-skill directories as units so removed resources do not
// survive in dist from an earlier build.
for (const skill of ["docx", "pptx", "xlsx"]) {
  fs.rmSync(path.join("dist", "skills", skill), { recursive: true, force: true });
}

for (const source of ["src/templates", "src/skills"]) {
  const destination = path.join("dist", path.relative("src", source));
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (entry) => !entry.endsWith(".ts"),
  });
}

const renderingSource = path.resolve("extra-dependencies/office-rendering");
const renderingDestination = path.resolve("dist/extra-dependencies/office-rendering");
const platformKeys = ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64", "linux-arm64"];
if (!fs.existsSync(renderingSource)) {
  throw new Error(`Missing shared Office rendering directory: ${renderingSource}`);
}
for (const platform of platformKeys) {
  const manifest = path.join(renderingSource, platform, "OFFICE-RENDERING-MANIFEST.json");
  if (!fs.existsSync(manifest)) throw new Error(`Missing Office rendering manifest: ${manifest}`);
  JSON.parse(fs.readFileSync(manifest, "utf8"));
}
const staging = `${renderingDestination}.staging-${process.pid}`;
fs.rmSync(staging, { recursive: true, force: true });
fs.cpSync(renderingSource, staging, { recursive: true, force: true });
fs.rmSync(renderingDestination, { recursive: true, force: true });
fs.mkdirSync(path.dirname(renderingDestination), { recursive: true });
fs.renameSync(staging, renderingDestination);
// A previous build may have left the pre-migration directory behind. It is
// never a release source and must not be copied into dist.
fs.rmSync(path.join("dist", "extra-dependencies", "docx-rendering"), {
  recursive: true,
  force: true,
});
