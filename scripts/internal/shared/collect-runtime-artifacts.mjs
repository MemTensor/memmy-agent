import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const [inputPath, outputPath, selection = "both"] = process.argv.slice(2);
if (!inputPath || !outputPath || !["both", "memory"].includes(selection)) {
  throw new Error("Usage: collect-runtime-artifacts.mjs <input-directory> <output-directory> [both|memory]");
}
const [input, output] = [inputPath, outputPath].map((value) => resolve(value));
if (!input || !output || input === output) throw new Error("Usage: collect-runtime-artifacts.mjs <input-directory> <output-directory>");
const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-arm64", "windows-x64"];
const manifest = { sourceCommit: process.env.GITHUB_SHA ?? null, nodeVersion: process.versions.node, nodeAbi: process.versions.modules, runtimes: {} };
const checksums = [];
await mkdir(output, { recursive: true });
for (const kind of selection === "memory" ? ["memory"] : ["agent", "memory"]) {
  const packageFile = kind === "agent" ? "App/memmy-agent/package.json" : "Memory/package.json";
  const version = JSON.parse(await readFile(join(repo, packageFile))).version;
  const assets = {};
  for (const target of targets) {
    const root = join(input, `runtimes-${target}`);
    const metadataFile = kind === "agent" ? `agent-release-${target}.json` : "memory-release.json";
    const metadata = JSON.parse(await readFile(join(root, metadataFile)));
    const asset = metadata.assets?.[target];
    const name = `memmy-${kind}-runtime-${version}-${target}.${kind === "agent" ? "tgz" : "tar.gz"}`;
    if (metadata.version !== version || asset?.name !== name) throw new Error(`Invalid ${kind} release metadata for ${target}`);
    const file = join(root, name);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    const sha256 = hash.digest("hex");
    const size = (await stat(file)).size;
    if (asset.sha256 !== sha256 || asset.size !== size) throw new Error(`Checksum or size mismatch: ${name}`);
    await cp(file, join(output, name));
    assets[target] = { name, sha256, size };
    checksums.push(`${sha256}  ${name}`);
  }
  manifest.runtimes[kind] = { version, assets };
}
await writeFile(join(output, "runtime-artifacts.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(join(output, "SHA256SUMS"), `${checksums.sort().join("\n")}\n`);
console.log(`Collected ${checksums.length} verified runtime archives at ${output}`);
