#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
const memoryRoot = resolve(scriptDirectory, "../../..");
const input = resolve(process.argv[2] ?? join(memoryRoot, "dist", "release-input"));
const output = resolve(process.argv[3] ?? join(memoryRoot, "dist", "release"));
const pkg = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(join(memoryRoot, "package.json"), "utf8")));
const version = process.argv[4] ?? pkg.version;
const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-arm64", "windows-x64"];

await mkdir(output, { recursive: true });
const discovered = await filesRecursively(input);
const assets = {};
const checksums = [];
for (const source of discovered) {
  const name = basename(source);
  if (!name.endsWith(".tar.gz")) continue;
  const destination = join(output, name);
  await copyFile(source, destination);
  const sha256 = await sha256File(destination);
  checksums.push({ name, sha256 });
  const match = name.match(new RegExp(`^memmy-memory-runtime-${escapeRegExp(version)}-(darwin|linux|windows)-(arm64|x64)\\.tar\\.gz$`));
  if (match) {
    const target = `${match[1]}-${match[2]}`;
    assets[target] = { name, sha256, size: (await stat(destination)).size };
  }
}
for (const target of targets) {
  if (!assets[target]) throw new Error(`release is missing runtime target ${target}`);
}
for (const installer of ["install.sh", "install.ps1"]) {
  const source = join(memoryRoot, "installers", installer);
  if (!existsSync(source)) throw new Error(`release installer is missing: ${installer}`);
  const destination = join(output, installer);
  await copyFile(source, destination);
  checksums.push({ name: installer, sha256: await sha256File(destination) });
}
await writeFile(join(output, "memory-release.json"), `${JSON.stringify({ version, protocolVersion: 1, assets }, null, 2)}\n`);
checksums.push({ name: "memory-release.json", sha256: await sha256File(join(output, "memory-release.json")) });
checksums.sort((left, right) => left.name.localeCompare(right.name));
await writeFile(join(output, "SHA256SUMS"), `${checksums.map((item) => `${item.sha256}  ${item.name}`).join("\n")}\n`);

async function filesRecursively(root) {
  if (!existsSync(root)) return [];
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await filesRecursively(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolveHash, rejectHash) => {
    const inputStream = createReadStream(path);
    inputStream.on("data", (chunk) => hash.update(chunk));
    inputStream.on("end", resolveHash);
    inputStream.on("error", rejectHash);
  });
  return hash.digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
