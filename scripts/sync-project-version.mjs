import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const rootManifestPath = join(root, "package.json");
const rootManifest = await readJson(rootManifestPath);
const version = rootManifest.version;

if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid project version in ${rootManifestPath}`);
}

const derivedManifests = [
  "Memory/package.json",
  "Memory/src/cli/npm/package.json",
  "App/memmy-agent/package.json",
  "App/shell/desktop/package.json",
];

const staleFiles = [];
for (const relativePath of derivedManifests) {
  await updateJson(relativePath, (json) => {
    json.version = version;
  });
}

await updateJson("package-lock.json", (json) => {
  json.version = version;
  json.packages[""].version = version;
  json.packages.Memory.version = version;
  json.packages["App/shell/desktop"].version = version;
});

await updateJson("App/memmy-agent/package-lock.json", (json) => {
  json.version = version;
  json.packages[""].version = version;
});

if (staleFiles.length > 0) {
  throw new Error(`Derived version metadata is stale: ${staleFiles.join(", ")}`);
}

console.log(`${checkOnly ? "Verified" : "Synchronized"} project version ${version}`);

async function updateJson(relativePath, update) {
  const absolutePath = join(root, relativePath);
  const currentText = await readFile(absolutePath, "utf8");
  const json = JSON.parse(currentText);
  update(json);
  const nextText = `${JSON.stringify(json, null, 2)}\n`;
  if (nextText === currentText) return;
  if (checkOnly) {
    staleFiles.push(relativePath);
    return;
  }
  await writeFile(absolutePath, nextText, "utf8");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
