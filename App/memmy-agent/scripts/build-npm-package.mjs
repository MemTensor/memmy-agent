/* global console */
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { npmInvocation } from "../../../scripts/internal/shared/npm-invocation.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const agentRoot = resolve(scriptRoot, "..");
const repoRoot = resolve(agentRoot, "../..");
const outputRoot = join(agentRoot, "npm-packages", "memmy-agent");
const vendorRoot = join(outputRoot, "vendor");
const sourceManifest = JSON.parse(await readFile(join(agentRoot, "package.json"), "utf8"));
const packageName = "@memtensor/memmy-agent";

const localDependencies = new Map([
  ["@memmy/local-api-contracts", "App/backend/local-api-contracts"],
  ["@memmy/migrations", "Migrations"],
  ["@memmy/knowledge", "Knowledge"],
]);

await rm(outputRoot, { recursive: true, force: true });
await rm(join(agentRoot, "dist", "memmy-agent-npm"), { recursive: true, force: true });
await mkdir(vendorRoot, { recursive: true });

const vendorPackages = {};
for (const [dependencyName, packagePath] of localDependencies) {
  const packageRoot = join(repoRoot, packagePath);
  const tarball = await pack(packageRoot, vendorRoot);
  vendorPackages[dependencyName] = `file:vendor/${tarball}`;
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
