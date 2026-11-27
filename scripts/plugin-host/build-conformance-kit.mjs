import { publishedHostRelease } from "./published-release.mjs";
import { build } from "esbuild";
import JSZip from "jszip";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, rm, cp, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const output = path.resolve(process.argv[2] || path.join(root, ".tmp", "plugin-host-conformance"));
const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const sourceChanges = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
const dirty = Boolean(sourceChanges);
if (dirty && process.env.CI === "true") throw new Error(`CI Host artifacts require a clean source checkout:\n${sourceChanges}`);
await rm(output, { recursive: true, force: true }); await mkdir(path.join(output, "runtime"), { recursive: true });
await build({ absWorkingDir: root,
  entryPoints: ["App/backend/src/tests/support/plugin-host-harness.ts"], outfile: path.join(output, "runtime", "host-kit.mjs"),
  platform: "node", target: "node22", format: "esm", bundle: true,
  external: ["better-sqlite3", "sqlite-vec", "pngjs"],
  banner: { js: "import { createRequire as __hostRequire } from 'node:module'; const require = __hostRequire(import.meta.url);" }
});
for (const rel of ["App/backend/src/infrastructure/app-state-store/migrations", "App/backend/src/infrastructure/agent-source-store/migrations", "App/backend/src/infrastructure/idempotency-store/migrations"]) {
  // Bundled modules share import.meta.url; preserve their three relative locations.
  const name = rel.split("/").at(-2);
  const destination = name === "app-state-store" ? path.join(output, "runtime", "migrations") : path.join(output, name, "migrations");
  await cp(path.join(root, rel), destination, { recursive: true });
}
await cp(path.join(root, "App/memmy-agent/src/skills/skill-creator"), path.join(output, "runtime/skills/skill-creator"), { recursive: true });
const require = createRequire(path.join(root, "App/memmy-agent/package.json"));
const copied = new Set();
async function copyDependency(name, resolver = require) {
  if (copied.has(name)) return;
  let source;
  try { source = path.dirname(resolver.resolve(`${name}/package.json`)); }
  catch {
    try {
      source = path.dirname(resolver.resolve(name));
      while (JSON.parse(await readFile(path.join(source, "package.json"), "utf8").catch(() => "{}")).name !== name) {
        const parent = path.dirname(source); if (parent === source) throw new Error(`Package root not found: ${name}`); source = parent;
      }
    } catch { throw new Error(`Missing runtime dependency for Host conformance: ${name}`); }
  }
  copied.add(name);
  const manifest = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
  await cp(source, path.join(output, "node_modules", name), { recursive: true,
    filter: file => !file.includes(`${path.sep}node_modules${path.sep}`) || !path.relative(source, file).split(path.sep).includes("node_modules") });
  const nested = createRequire(path.join(source, "package.json"));
  for (const dependency of Object.keys(manifest.dependencies || {})) await copyDependency(dependency, nested);
  for (const dependency of Object.keys(manifest.optionalDependencies || {})) {
    try { nested.resolve(dependency); } catch { continue; }
    await copyDependency(dependency, nested);
  }
}
for (const dependency of ["pngjs", "better-sqlite3", "sqlite-vec"]) await copyDependency(dependency);
await writeFile(path.join(output, "host-kit.mjs"), 'export * from "./runtime/host-kit.mjs";\n');
const kit = await import(pathToFileURL(path.join(output, "host-kit.mjs")).href);
const release = process.env.MEMMY_HOST_RELEASE_TAG
  ? await publishedHostRelease(process.env.GITHUB_REPOSITORY, process.env.MEMMY_HOST_RELEASE_TAG, sourceCommit, version) : null;
if (release && dirty) throw new Error("Published Host artifacts must come from a clean source checkout");
const descriptor = { schema: "memmy.plugin-host-release/v1", version, sourceCommit, dirty,
  capabilities: [...kit.PLUGIN_HOST_CAPABILITIES], release, nodeMajor: 22, platform: process.platform, arch: process.arch };
await writeFile(path.join(output, "host-release.json"), JSON.stringify(descriptor, null, 2) + "\n");
await writeFile(path.join(output, "package.json"), JSON.stringify({ private: true, type: "module" }));
const zip = new JSZip();
async function add(directory, prefix = "") {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const file = path.join(directory, entry.name), name = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symlink in Host conformance kit: ${name}`);
    if (entry.isDirectory()) await add(file, name + "/");
    else zip.file(name, await readFile(file), { date: new Date("1980-01-01T00:00:00Z") });
  }
}
await add(output);
for (const entry of Object.values(zip.files)) entry.date = new Date("1980-01-01T00:00:00Z");
const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
const archive = path.join(path.dirname(output), `plugin-host-conformance-${version}.zip`);
await writeFile(archive, bytes);
await writeFile(archive + ".sha256", createHash("sha256").update(bytes).digest("hex") + "\n");
console.log(JSON.stringify({ archive, bytes: bytes.length, descriptor, sha256: createHash("sha256").update(bytes).digest("hex") }));
