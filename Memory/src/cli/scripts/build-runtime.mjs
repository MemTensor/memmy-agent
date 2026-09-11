#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const memoryRoot = resolve(scriptDir, "../../..");
const repositoryRoot = resolve(memoryRoot, "..");
const options = parseOptions(process.argv.slice(2));
const manifest = JSON.parse(await readFile(join(memoryRoot, "package.json"), "utf8"));
const version = options.version ?? manifest.version;
const target = options.target ?? hostTarget();
const [platform, arch] = validateTarget(target);
const outputRoot = resolve(options.output ?? join(memoryRoot, "dist", "releases"));
const assetName = `memmy-memory-runtime-${version}-${target}.tar.gz`;
const temporaryRoot = await mkdtemp(join(tmpdir(), "memmy-memory-runtime-"));
const runtimeRoot = join(temporaryRoot, "runtime");

try {
  if (!options.skipBuild) run("npm", ["run", "build", "--workspace", "@memmy/memory"], repositoryRoot);
  await mkdir(join(runtimeRoot, "dist"), { recursive: true });
  await cp(join(memoryRoot, "dist", "src"), join(runtimeRoot, "dist", "src"), { recursive: true });
  await cp(join(memoryRoot, "dist", "viewer"), join(runtimeRoot, "dist", "viewer"), { recursive: true });
  await cp(join(memoryRoot, "adapters"), join(runtimeRoot, "adapters"), { recursive: true });

  const runtimePackage = {
    name: "memmy-memory-runtime",
    version,
    private: true,
    type: "module",
    engines: manifest.engines,
    dependencies: manifest.dependencies
  };
  await writeJson(join(runtimeRoot, "package.json"), runtimePackage);
  run("npm", ["install", "--package-lock-only", "--ignore-scripts", `--os=${npmPlatform(platform)}`, `--cpu=${arch}`], runtimeRoot);
  run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund", `--os=${npmPlatform(platform)}`, `--cpu=${arch}`], runtimeRoot);

  if (process.env.MEMMY_MEMORY_SKIP_EMBEDDING_MODEL !== "1") {
    run("node", [join(repositoryRoot, "scripts", "internal", "shared", "prepare-embedding-model.mjs"), join(runtimeRoot, "embedding-models")], repositoryRoot);
    await verifyEmbeddingModel(runtimeRoot);
  }
  await verifyRuntimeDependencies(runtimeRoot, target);
  await writeJson(join(runtimeRoot, "memory-runtime.json"), {
    name: "memmy-memory-runtime",
    version,
    protocolVersion: 1,
    target,
    entrypoint: "dist/src/server/index.js",
    viewer: "dist/viewer/index.html",
    includesEmbeddingModel: process.env.MEMMY_MEMORY_SKIP_EMBEDDING_MODEL !== "1",
    builtAt: new Date().toISOString()
  });

  await mkdir(outputRoot, { recursive: true });
  const assetPath = join(outputRoot, assetName);
  run("tar", ["-czf", assetPath, "-C", runtimeRoot, "."], repositoryRoot);
  const descriptor = { name: assetName, sha256: await sha256File(assetPath), size: (await stat(assetPath)).size };
  await updateReleaseManifest(outputRoot, version, target, descriptor);
  process.stdout.write(`${assetPath}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function parseOptions(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--skip-build") parsed.skipBuild = true;
    else if (token === "--target") parsed.target = argv[++index];
    else if (token === "--version") parsed.version = argv[++index];
    else if (token === "--output") parsed.output = argv[++index];
    else throw new Error(`unknown option: ${token}`);
  }
  return parsed;
}

function hostTarget() {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  return `${platform}-${process.arch}`;
}

function validateTarget(target) {
  const match = target?.match(/^(darwin|linux|windows)-(arm64|x64)$/);
  if (!match) throw new Error(`unsupported Memory runtime target: ${target}`);
  return [match[1], match[2]];
}

function npmPlatform(platform) {
  return platform === "windows" ? "win32" : platform;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env, shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

async function verifyRuntimeDependencies(root, target) {
  const entrypoint = join(root, "dist", "src", "server", "index.js");
  const viewer = join(root, "dist", "viewer", "index.html");
  if (!existsSync(entrypoint) || !existsSync(viewer)) throw new Error("compiled Memory service or Viewer is missing");
  const nativeFiles = await findFiles(join(root, "node_modules", "better-sqlite3"), (name) => name === "better_sqlite3.node");
  if (nativeFiles.length === 0) throw new Error(`better-sqlite3 native module is missing for ${target}`);
  const sqliteVecPackage = join(root, "node_modules", `sqlite-vec-${target}`);
  if (!existsSync(sqliteVecPackage)) throw new Error(`sqlite-vec native package is missing for ${target}`);
}

async function verifyEmbeddingModel(root) {
  const model = process.env.MEMMY_EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2";
  for (const file of ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"]) {
    if (!existsSync(join(root, "embedding-models", model, file))) throw new Error(`embedding model asset is missing: ${file}`);
  }
}

async function findFiles(root, predicate) {
  if (!existsSync(root)) return [];
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await findFiles(path, predicate));
    else if (predicate(entry.name)) result.push(path);
  }
  return result;
}

async function updateReleaseManifest(outputRoot, version, target, descriptor) {
  const path = join(outputRoot, "memory-release.json");
  let release = { version, protocolVersion: 1, assets: {} };
  if (existsSync(path)) {
    const current = JSON.parse(await readFile(path, "utf8"));
    if (current.version !== version) throw new Error(`release manifest already contains version ${current.version}`);
    release = current;
  }
  release.assets[target] = descriptor;
  const temporary = `${path}.${process.pid}.tmp`;
  await writeJson(temporary, release);
  await rename(temporary, path);
  const checksums = Object.values(release.assets)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((asset) => `${asset.sha256}  ${asset.name}`)
    .join("\n");
  await writeFile(join(outputRoot, "SHA256SUMS"), `${checksums}\n`, "utf8");
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolveHash, rejectHash) => {
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", resolveHash);
    input.on("error", rejectHash);
  });
  return hash.digest("hex");
}
