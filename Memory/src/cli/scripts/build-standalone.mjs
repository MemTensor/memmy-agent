#!/usr/bin/env node
// Turns a runtime bundle produced by build-runtime.mjs into the single-file
// executable that ships to end users. `pkg` embeds its own Node binary, so the
// native modules inside the bundle must match that Node ABI rather than the ABI
// of whatever Node built the bundle.
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// `pkg` ships prebuilt Node binaries; these two constants must describe the same
// release, because better-sqlite3 prebuilds are keyed by Node's ABI version.
const PKG_NODE_RANGE = "node22";
const PKG_NODE_VERSION = "22.23.2";

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const memoryRoot = resolve(scriptDir, "../../..");
const options = parseOptions(process.argv.slice(2));
const manifest = JSON.parse(await readFile(join(memoryRoot, "package.json"), "utf8"));
const version = options.version ?? manifest.version;
const target = options.target ?? process.env.MEMMY_MEMORY_TARGET ?? hostTarget();
const [platform, arch] = validateTarget(target);
const runtimeRoot = resolve(options.runtime ?? join(memoryRoot, "dist", "releases"));
const outputRoot = resolve(options.output ?? join(memoryRoot, "dist", "binaries"));
const runtimeAsset = join(runtimeRoot, `memmy-memory-runtime-${version}-${target}.tar.gz`);
if (!existsSync(runtimeAsset)) throw new Error(`runtime bundle is missing: ${runtimeAsset}`);

const binaryName = platform === "windows" ? "memmy-memory.exe" : "memmy-memory";
const assetName = `memmy-memory-${version}-${releaseTarget(platform)}-${arch}.tar.gz`;
const temporaryRoot = await mkdtemp(join(tmpdir(), "memmy-memory-standalone-"));
const stageRoot = join(temporaryRoot, "stage");

try {
  await mkdir(stageRoot, { recursive: true });
  run("tar", ["-xzf", runtimeAsset, "-C", stageRoot]);
  await alignNativeModulesToPkgRuntime(stageRoot);
  await writeJson(join(stageRoot, "pkg.json"), pkgConfig());

  // Bytecode compilation runs the target platform's Node binary, which a single
  // build host cannot do for the other three targets. `--no-bytecode` keeps every
  // target buildable here and produces the same snapshot layout for all of them.
  const output = join(temporaryRoot, binaryName);
  run("node", [require.resolve("@yao-pkg/pkg/lib-es5/bin.js"), "--config", "pkg.json", "--target", pkgTarget(), "--no-bytecode", "--public", "--public-packages", "*", "--output", output, "dist/src/server/index.js"], stageRoot);
  if (!existsSync(output)) throw new Error(`pkg did not produce ${binaryName}`);

  await mkdir(outputRoot, { recursive: true });
  const assetPath = join(outputRoot, assetName);
  await rm(assetPath, { force: true });
  run("tar", ["-czf", assetPath, "-C", temporaryRoot, binaryName]);
  process.stdout.write(`${assetPath} (${(await stat(assetPath)).size} bytes, sha256=${await sha256File(assetPath)})\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

// better-sqlite3 links against Node's V8 ABI, and the bundle carries whichever
// prebuild matched the build host. Swap it for the one `pkg`'s Node can load.
// onnxruntime-node and sharp use N-API, so only their platform slice matters.
async function alignNativeModulesToPkgRuntime(root) {
  const betterSqlite3 = join(root, "node_modules", "better-sqlite3");
  await rm(join(betterSqlite3, "build", "Release"), { recursive: true, force: true });
  run("node", [require.resolve("prebuild-install/bin.js", { paths: [betterSqlite3] }), "--runtime=node", `--target=${PKG_NODE_VERSION}`, `--platform=${npmPlatform(platform)}`, `--arch=${arch}`], betterSqlite3);
  if (!existsSync(join(betterSqlite3, "build", "Release", "better_sqlite3.node"))) {
    throw new Error(`better-sqlite3 has no Node ${PKG_NODE_VERSION} prebuild for ${target}`);
  }

  const onnxBin = join(root, "node_modules", "onnxruntime-node", "bin", "napi-v3");
  for (const entry of await readdir(onnxBin)) {
    if (entry !== npmPlatform(platform)) await rm(join(onnxBin, entry), { recursive: true, force: true });
  }
  for (const entry of await readdir(join(onnxBin, npmPlatform(platform)))) {
    if (entry !== arch) await rm(join(onnxBin, npmPlatform(platform), entry), { recursive: true, force: true });
  }
}

// `scripts` are parsed and snapshotted as code; `assets` are copied verbatim.
// Native binaries and model files must be assets or `pkg` tries to parse them.
function pkgConfig() {
  return {
    name: "memmy-memory",
    version,
    bin: "dist/src/server/index.js",
    pkg: {
      scripts: ["dist/src/**/*.js"],
      assets: [
        "dist/viewer/**/*",
        "embedding-models/**/*",
        "adapters/**/*",
        "memory-runtime.json",
        "node_modules/@huggingface/transformers/**/*",
        "node_modules/onnxruntime-node/**/*",
        "node_modules/onnxruntime-common/**/*",
        "node_modules/better-sqlite3/**/*",
        "node_modules/sqlite-vec/**/*",
        `node_modules/sqlite-vec-${target}/**/*`,
        "node_modules/tiktoken/**/*",
        "node_modules/sharp/**/*",
        "node_modules/@img/**/*"
      ]
    }
  };
}

function pkgTarget() {
  const pkgPlatform = platform === "darwin" ? "macos" : platform === "windows" ? "win" : platform;
  return `${PKG_NODE_RANGE}-${pkgPlatform}-${arch}`;
}

// Release archives use `macos` where the build pipeline uses `darwin`.
function releaseTarget(value) {
  return value === "darwin" ? "macos" : value;
}

function parseOptions(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--target") parsed.target = argv[++index];
    else if (token === "--version") parsed.version = argv[++index];
    else if (token === "--runtime") parsed.runtime = argv[++index];
    else if (token === "--output") parsed.output = argv[++index];
    else throw new Error(`unknown option: ${token}`);
  }
  return parsed;
}

function hostTarget() {
  const value = process.platform === "win32" ? "windows" : process.platform;
  return `${value}-${process.arch}`;
}

function validateTarget(value) {
  const match = value?.match(/^(darwin|linux|windows)-(arm64|x64)$/);
  if (!match) throw new Error(`unsupported Memory standalone target: ${value}`);
  return [match[1], match[2]];
}

function npmPlatform(value) {
  return value === "windows" ? "win32" : value;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env, shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
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
