import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formats, manifest } from "./manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "../../App/memmy-agent/src/skills");
await rm(resolve(root, "dist"), { recursive: true, force: true });
await mkdir(resolve(root, "dist/runtime"), { recursive: true });
await build({ entryPoints: [resolve(root, "src/main.mjs")], outfile: resolve(root, "dist/runtime/main.cjs"),
  bundle: true, platform: "node", format: "cjs", target: "node22", logLevel: "warning" });
await build({ entryPoints: [resolve(root, "src/execute.mjs")], outfile: resolve(root, "dist/runtime/execute.cjs"),
  bundle: true, platform: "node", format: "cjs", target: "node22", logLevel: "warning" });
await writeFile(resolve(root, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
await cp(resolve(root, "plugin.json"), resolve(root, "dist/plugin.json"));
const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
const notices = ["Third-party libraries bundled in Memmy Office.\n"];
for (const [directory, metadata] of Object.entries(lock.packages ?? {})) {
  if (!directory.startsWith("node_modules/") || metadata.dev) continue;
  const packageRoot = resolve(root, directory);
  const info = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  notices.push(`\n--- ${info.name}@${info.version} (${typeof info.license === "string" ? info.license : "see license"}) ---\n`);
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENSE-MIT.txt", "LICENCE", "license", "license.md"]) {
    const content = await readFile(resolve(packageRoot, name), "utf8").catch(error => { if (error.code !== "ENOENT") throw error; return null; });
    if (content) { notices.push(content); break; }
  }
}
await writeFile(resolve(root, "dist/THIRD-PARTY-NOTICES.txt"), notices.join("\n"));
for (const format of formats) {
  const dest = resolve(root, `dist/skills/office-${format}`);
  await cp(resolve(source, format), dest, { recursive: true });
  const upstream = await readFile(resolve(source, format, "SKILL.md"), "utf8");
  await mkdir(resolve(dest, "references"), { recursive: true });
  await writeFile(resolve(dest, "references/upstream-skill.md"), upstream);
  const guide = await readFile(resolve(root, "skills/workflow.md"), "utf8");
  await writeFile(resolve(dest, "SKILL.md"), `---\nname: office-${format}\ndescription: Use the installed Office plugin to create, read, edit, validate, render, and deliver ${format.toUpperCase()} files.\n---\n\n# Office ${format.toUpperCase()}\n\n${guide}\n\nFormat-specific requirements: [original guide](references/upstream-skill.md). Sibling scripts and references are retained for format knowledge; the plugin capabilities own execution and delivery.\n`);
}
console.log(`Built Office ${manifest.version}`);
