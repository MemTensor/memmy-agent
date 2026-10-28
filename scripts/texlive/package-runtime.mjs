/** Package an already provisioned, relocatable TeX Live/TinyTeX tree. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageRuntime } from "../../plugins/office/scripts/package-runtime.mjs";
export const packageTexliveRuntime = options => packageRuntime({ ...options, kind: "texlive" });
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i];
    if (flag === "--set-default") args.setDefault = true;
    else if (["--root", "--destination", "--target", "--version", "--tools"].includes(flag)) args[flag.slice(2)] = process.argv[++i];
    else throw new Error(`Unknown flag ${flag}`);
  }
  if (!args.root || !args.destination || !args.target || !args.version || !args.tools) throw new Error("Required: --root --destination --target --version --tools TOOLS.json [--set-default]");
  args.tools = JSON.parse(await readFile(args.tools, "utf8"));
  const manifest = await packageTexliveRuntime(args);
  console.log(JSON.stringify({ target: manifest.target, archive: manifest.archive, files: Object.keys(manifest.files).length }));
}
