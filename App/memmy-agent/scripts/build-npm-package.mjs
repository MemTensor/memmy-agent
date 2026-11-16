/* global console */
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { npmInvocation } from "../../../scripts/internal/shared/npm-invocation.mjs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { vendoredManifest } from "./vendor-manifest.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const agentRoot = resolve(scriptRoot, "..");
const repoRoot = resolve(agentRoot, "../..");
const outputRoot = join(agentRoot, "npm-packages", "memmy-agent");
const vendorRoot = join(outputRoot, "vendor");
const sourceManifest = JSON.parse(await readFile(join(agentRoot, "package.json"), "utf8"));
const packageName = "@memtensor/memmy-agent";

const localDependencies = new Map([
  // local-api-contracts re-exports the scan ordering from this workspace-only package.
  ["@memmy/agent-source-core", "Memory/AgentSourceCore"],
  ["@memmy/local-api-contracts", "App/backend/local-api-contracts"],
  ["@memmy/migrations", "Migrations"],
  ["@memmy/knowledge", "Knowledge"],
]);

await rm(outputRoot, { recursive: true, force: true });
await rm(join(agentRoot, "dist", "memmy-agent-npm"), { recursive: true, force: true });
await mkdir(vendorRoot, { recursive: true });

const localVersions = new Map();
for (const [dependencyName, packagePath] of localDependencies) {
  localVersions.set(dependencyName, (await readManifest(join(repoRoot, packagePath))).version);
}

const vendorPackages = {};
const stagingRoot = await mkdtemp(join(tmpdir(), "memmy-agent-vendor-"));
try {
  for (const [dependencyName, packagePath] of localDependencies) {
    const packageRoot = await vendorSource(join(repoRoot, packagePath));
    const tarball = await pack(packageRoot, vendorRoot);
    vendorPackages[dependencyName] = `file:vendor/${tarball}`;
  }
} finally {
  // Windows may briefly lock freshly written files (antivirus/indexer), so retry on EBUSY/EPERM.
  await rm(stagingRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

const packageManifest = {
  name: packageName,
  version: sourceManifest.version,
  description: sourceManifest.description,
  type: "module",
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      default: "./dist/index.js",
    },
  },
  bin: { memmy: "./dist/main.js" },
  publishConfig: { access: "public" },
  files: ["dist/**/*", ".env.example", "README.md", "vendor/*.tgz"],
  engines: sourceManifest.engines,
  dependencies: {
    ...sourceManifest.dependencies,
    ...vendorPackages,
  },
};

await writeFile(join(outputRoot, "package.json"), `${JSON.stringify(packageManifest, null, 2)}\n`);
await cp(join(agentRoot, "dist"), join(outputRoot, "dist"), { recursive: true });
await chmod(join(outputRoot, "dist", "main.js"), 0o755);
await cp(join(agentRoot, ".env.example"), join(outputRoot, ".env.example"));
await cp(join(agentRoot, "README.md"), join(outputRoot, "README.md"));

for (const file of ["dist/main.js", "dist/index.js", ".env.example", "README.md"]) {
  if (!(await exists(join(outputRoot, file)))) throw new Error(`npm package is missing ${file}`);
}
if (Object.values(packageManifest.dependencies).some((value) => value.startsWith("file:../") || value.startsWith("file:../../"))) {
  throw new Error("npm package contains a dependency outside its own archive");
}

console.log(`Prepared ${packageName}@${sourceManifest.version} at ${outputRoot}`);

async function readManifest(packageRoot) {
  return JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
}

// Packs the checkout as is, or a copy whose manifest no longer points outside the tarball.
async function vendorSource(packageRoot) {
  const manifest = await readManifest(packageRoot);
  const vendored = vendoredManifest(manifest, localVersions);
  if (vendored === manifest) return packageRoot;
  const staged = await mkdtemp(join(stagingRoot, "package-"));
  await cp(packageRoot, staged, { recursive: true, filter: (file) => basename(file) !== "node_modules" });
  await writeFile(join(staged, "package.json"), `${JSON.stringify(vendored, null, 2)}\n`);
  return staged;
}

async function pack(packageRoot, destination) {
  const result = await run("npm", ["pack", packageRoot, "--pack-destination", destination, "--ignore-scripts", "--json"], repoRoot);
  const metadata = JSON.parse(result.stdout).at(-1);
  if (!metadata?.filename) throw new Error(`npm pack did not return a filename for ${packageRoot}`);
  return metadata.filename;
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, cwd) {
  if (command === "npm") ({ command, args } = npmInvocation(args));
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise({ stdout });
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}
