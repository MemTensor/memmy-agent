import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formats, manifest } from "./manifest.mjs";
import { collectThirdPartyNotices } from "./third-party-notices.mjs";

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
await writeFile(resolve(root, "dist/THIRD-PARTY-NOTICES.txt"), await collectThirdPartyNotices(root));
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
