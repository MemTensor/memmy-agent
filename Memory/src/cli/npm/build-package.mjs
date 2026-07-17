import { chmod, cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(scriptDirectory, "..");
const monorepoRoot = join(cliRoot, "..", "..", "..");
const projectRoot = await pathExists(join(monorepoRoot, "Memory", "src", "cli", "npm", "package.json"))
  ? monorepoRoot
  : cliRoot;
const packageOutput = join(projectRoot, "dist", "memmy-memory-npm");
const templateManifestPath = join(scriptDirectory, "package.json");
const templateReadmePath = join(scriptDirectory, "README.md");
const templateBinPath = join(scriptDirectory, "bin");
const templateScriptsPath = join(scriptDirectory, "scripts");

await rm(packageOutput, { recursive: true, force: true });
await mkdir(packageOutput, { recursive: true });

const packageManifest = JSON.parse(await readFile(templateManifestPath, "utf8"));

await writeFile(join(packageOutput, "package.json"), `${JSON.stringify(packageManifest, null, 2)}\n`, "utf8");
await cp(templateReadmePath, join(packageOutput, "README.md"));
await cp(templateBinPath, join(packageOutput, "bin"), { recursive: true });
await cp(templateScriptsPath, join(packageOutput, "scripts"), { recursive: true });
await removeJunkFiles(packageOutput);
await chmod(join(packageOutput, "bin", "memmy-memory.js"), 0o755);
await chmod(join(packageOutput, "scripts", "postinstall.js"), 0o755);
await chmod(join(packageOutput, "scripts", "prepublish-check.js"), 0o755);

console.log(`Prepared npm package at ${packageOutput}`);
console.log("Run: npm pack ./dist/memmy-memory-npm");

async function removeJunkFiles(root) {
  const entries = await import("node:fs/promises").then((fs) => fs.readdir(root, { withFileTypes: true }));
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.name === ".DS_Store") {
      await rm(path, { force: true });
      continue;
    }
    if (entry.isDirectory()) {
      await removeJunkFiles(path);
    }
  }
}

async function pathExists(path) {
  try {
    await import("node:fs/promises").then((fs) => fs.access(path));
    return true;
  } catch {
    return false;
  }
}
