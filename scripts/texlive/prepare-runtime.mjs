/** Build a relocatable review runtime from a provisioned TeX Live/TinyTeX installation.
 * Provision packages in CI before this step; no installation scripts run on user machines.
 */
import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
export async function prepareTexliveRuntime({ source, destination, bin, extra }) {
  source = resolve(source); destination = resolve(destination);
  if (destination === source || destination.startsWith(source + "/")) throw new Error("Destination must be outside the source TeX distribution");
  await mkdir(destination, { recursive: false });
  for (const name of ["texmf-dist", "texmf-var", "texmf-config", "LICENSE.CTAN", "LICENSE.TL", "release-texlive.txt"]) {
    await cp(join(source, name), join(destination, name), { recursive: true, dereference: true,
      filter: file => !/(?:^|[\\/])(?:tex4ht)(?:[\\/]|$)/.test(file) });
  }
  if (extra) await cp(resolve(extra), join(destination, "texmf-local"), { recursive: true, dereference: true });
  const windows = bin.split(/[\\/]/).at(-1) === "windows", suffix = windows ? ".exe" : "";
  const tools = {};
  for (const tool of ["xelatex", "kpsewhich", "xdvipdfmx"]) {
    const relative = `${bin}/${tool}${suffix}`;
    await cp(join(source, relative), join(destination, relative), { dereference: true });
    if (tool !== "xdvipdfmx") tools[tool] = relative;
  }
  // TeX Live Windows also needs its adjacent DLLs; retain all, rather than guess loader dependencies.
  if (windows) await cp(join(source, bin), join(destination, bin), { recursive: true, dereference: true });
  await writeFile(join(destination, "texmf.cnf"), "TEXMFLOCAL = $SELFAUTOPARENT/texmf-local\nTEXMFHOME = $SELFAUTOPARENT/texmf-empty\n");
  // Rebuild search databases after filtering and adding macro packages.
  for (const tree of ["texmf-dist", "texmf-var", "texmf-config", ...(extra ? ["texmf-local"] : [])]) {
    const lines = ["% ls-R -- filename database for kpathsea; do not change this line."];
    async function scan(directory, relative = ".") {
      const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"));
      lines.push("", relative + ":", ...entries.map(entry => entry.name));
      for (const entry of entries) if (entry.isDirectory()) await scan(join(directory, entry.name), relative + "/" + entry.name);
    }
    await scan(join(destination, tree));
    await writeFile(join(destination, tree, "ls-R"), lines.join("\n") + "\n");
  }
  await writeFile(join(destination, "tools.json"), JSON.stringify(tools, null, 2) + "\n");
  return tools;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    if (!["--source", "--destination", "--bin", "--extra"].includes(key)) throw new Error(`Unknown flag ${key}`);
    args[key.slice(2)] = process.argv[i + 1];
  }
  if (!args.source || !args.destination || !args.bin) throw new Error("Required: --source --destination --bin [--extra]");
  console.log(JSON.stringify(await prepareTexliveRuntime(args)));
}
