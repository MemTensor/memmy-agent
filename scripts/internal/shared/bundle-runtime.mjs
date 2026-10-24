import { builtinModules } from "node:module";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { build, transform } from "esbuild";
import { includeRuntimePath } from "./runtime-payload.mjs";

// These packages load native binaries, workers, or assets relative to their own files.
const EXTERNAL_PACKAGES = new Set([
  "better-sqlite3", "tiktoken", "sqlite-vec", "@huggingface/transformers",
  "playwright", "playwright-core", "@playwright/mcp", "open-computer-use",
  "pdfjs-dist", "typescript", "html-validate", "@tencent-connect/openclaw-qqbot",
  "ink", "@mistralai/mistralai", "isomorphic-git", "commander", "nunjucks",
  "iconv-lite", "glob", "@discordjs/ws", "thread-stream", "pino",
  "@larksuiteoapi/node-sdk", "@matrix-org/matrix-sdk-crypto-wasm", "open", "botbuilder", "jsonc-parser"
]);
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const packageName = (specifier) => specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
const posix = (value) => value.split(path.sep).join("/");


function inside(root, file) {
  const relative = path.relative(root, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Runtime file escapes its staging directory: ${file}`);
  }
  return relative;
}

function findPackage(name, directory, root) {
  for (let current = directory; ; current = path.dirname(current)) {
    const candidate = path.join(current, "node_modules", ...name.split("/"));
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (current === root || path.dirname(current) === current) return undefined;
  }
}

// Keep entry paths for subprocesses and dynamic imports, but share bundled dependencies.
export async function bundleRuntime({ source, destination, packageDirectory, kind, target = {} }) {
  source = await realpath(source);
  destination = path.resolve(destination);
  const separation = path.relative(source, destination);
  if (!separation || (!separation.startsWith(`..${path.sep}`) && separation !== ".." && !path.isAbsolute(separation))) {
    throw new Error("Runtime destination must be outside the staging directory.");
  }
  const packageRoot = path.join(source, packageDirectory);
  inside(source, packageRoot);
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const codeRoot = path.join(packageRoot, "dist");
  const outputRoot = path.join(destination, packageDirectory, "dist");
  const entryPoints = [];
  const assets = [];
  const externalRoots = new Set();
  const moduleUrls = new Map();
  const externalPaths = new Map();
  const copyOptions = { ...target, prune: true };

  const collect = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = posix(path.relative(packageRoot, file));
      if (!includeRuntimePath(relative, copyOptions) || entry.name === "node_modules" || entry.name === "vendor" || entry.name === "package-lock.json") continue;
      if (entry.isDirectory()) await collect(file);
      else if (entry.isFile()) {
        const code = path.relative(codeRoot, file);
        // Skills and integration templates contain programs emitted as data, not server modules.
        if (file.endsWith(".js") && !code.startsWith("..") && !/(?:^|\/)(?:skills|viewer|templates)(?:\/|$)/u.test(posix(code))) {
          const entry = posix(code);
          if (kind === "agent" ? entry === "runtime-main.js" || /^tools\/(?:computer-history\/mac\/(?:record-human-history|summarize-history)|computer-use\/extract-workflow-candidate)\.js$/u.test(entry)
            : ["src/server/index.js", "src/cli/index.js"].includes(entry)) entryPoints.push({ in: file, out: kind === "agent" && entry === "runtime-main.js" ? "main" : entry.slice(0, -3) });
        }
        else if (!file.endsWith(".map") && !/\.d\.[cm]?ts$/u.test(file)) assets.push(file);
      }
    }
  };
  // Runtime assets live here; src, vendor tarballs and build projects are not shipped.
  for (const directory of ["dist", ...(kind === "memory" ? ["embedding-models", "adapters"] : [])]) {
    const directoryPath = path.join(packageRoot, directory);
    if (existsSync(directoryPath)) await collect(directoryPath);
  }
  if (!entryPoints.length) throw new Error(`No compiled ${kind} runtime entrypoints in ${codeRoot}.`);

  // These modules are resolved by strings passed to workers or child processes.
  const dynamicPackages = kind === "agent" ? ["isomorphic-git", "@playwright/mcp", "open-computer-use"] : [];
  for (const name of dynamicPackages) {
    const directory = findPackage(name, packageRoot, source);
    if (!directory) throw new Error(`Missing dynamic runtime dependency: ${name}`);
    externalRoots.add(directory);
  }

  const result = await build({
    entryPoints, outdir: outputRoot, outbase: codeRoot, entryNames: "[dir]/[name]",
    chunkNames: "_chunks/[name]-[hash]", bundle: true, splitting: true,
    platform: "node", target: "node22", format: "esm", keepNames: true,
    write: false, metafile: true, logLevel: "silent", charset: "utf8",
    banner: { js: 'import { createRequire as __memmyCreateRequire } from "node:module"; import { fileURLToPath as __memmyFileURLToPath } from "node:url"; const require = __memmyCreateRequire(import.meta.url);' },
    plugins: [{ name: "runtime-layout", setup(builder) {
      builder.onResolve({ filter: /^[^./]|^@/ }, async (args) => {
        if (args.pluginData?.runtimeResolved || BUILTINS.has(args.path) || !EXTERNAL_PACKAGES.has(packageName(args.path))) return;
        const resolved = await builder.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { runtimeResolved: true } });
        if (resolved.errors.length) return { errors: resolved.errors };
        const directory = findPackage(packageName(args.path), args.resolveDir, source);
        if (!directory) throw new Error(`Cannot locate external runtime dependency: ${args.path}`);
        inside(source, resolved.path);
        externalPaths.set(resolved.path, { directory, relocated: path.join(destination, path.relative(source, resolved.path)) });
        return { path: resolved.path, external: true };
      });
      builder.onLoad({ filter: /\.[cm]?js$/ }, async (args) => {
        if (!args.path.startsWith(`${packageRoot}${path.sep}`) || path.relative(packageRoot, args.path).split(path.sep).includes("node_modules")) return;
        const contents = await readFile(args.path, "utf8");
        if (!contents.includes("import.meta.url")) return { contents, loader: "js", resolveDir: path.dirname(args.path) };
        const marker = `memmy-module:${posix(path.relative(source, args.path))}`;
        moduleUrls.set(marker, path.join(destination, path.relative(source, args.path)));
        const transformed = await transform(contents, { loader: "js", target: "node22", define: { "import.meta.url": JSON.stringify(marker) } });
        return { contents: transformed.code, loader: "js", resolveDir: path.dirname(args.path) };
      });
    } }]
  });

  for (const file of result.outputFiles) {
    let contents = file.text;
    for (const [marker, original] of moduleUrls) {
      const relative = posix(path.relative(path.dirname(file.path), original)).split("/").map(encodeURIComponent).join("/");
      contents = contents.replaceAll(JSON.stringify(marker), `new URL(${JSON.stringify(relative)}, import.meta.url).href`);
    }
    for (const [original, { relocated }] of externalPaths) {
      let relative = posix(path.relative(path.dirname(file.path), relocated));
      if (!relative.startsWith(".")) relative = `./${relative}`;
      relative = relative.split("/").map(encodeURIComponent).join("/");
      // esbuild shares its CJS require helper between chunks; resolve from the caller.
      contents = contents.replaceAll(`__require(${JSON.stringify(original)})`, `__require(__memmyFileURLToPath(new URL(${JSON.stringify(relative)}, import.meta.url)))`);
      contents = contents.replaceAll(JSON.stringify(original), JSON.stringify(relative));
    }
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, contents);
  }
  if (kind === "memory" && existsSync(path.join(packageRoot, "memory-runtime.json"))) assets.push(path.join(packageRoot, "memory-runtime.json"));
  for (const file of assets) {
    const output = path.join(destination, inside(source, file));
    await mkdir(path.dirname(output), { recursive: true });
    await copyFile(file, output);
  }
  // This is a launchable runtime, not the original SDK/development npm package.
  const runtimeManifest = Object.fromEntries(["name", "version", "type", "bin", "engines", "license"].filter((key) => manifest[key] !== undefined).map((key) => [key, manifest[key]]));
  await writeFile(path.join(destination, packageDirectory, "package.json"), `${JSON.stringify({ ...runtimeManifest, private: true }, null, 2)}\n`);

  const copied = new Set();
  const copyPackage = async (directory) => {
    inside(source, await realpath(directory));
    if (copied.has(directory)) return;
    copied.add(directory);
    const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    await cp(directory, path.join(destination, inside(source, directory)), {
      recursive: true, dereference: true,
      filter: (file) => {
        const relative = path.relative(directory, file);
        return !relative.split(path.sep).includes("node_modules") && includeRuntimePath(path.relative(source, file), copyOptions);
      }
    });
    const optional = { ...manifest.optionalDependencies, ...manifest.peerDependencies };
    for (const name of new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(optional)])) {
      const dependency = findPackage(name, directory, source);
      if (dependency) await copyPackage(dependency);
      else if (!Object.hasOwn(optional, name)) throw new Error(`Missing runtime dependency ${name} required by ${manifest.name}.`);
    }
  };
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports) {
      const external = externalPaths.get(imported.path);
      if (external) externalRoots.add(external.directory);
    }
  }
  for (const directory of externalRoots) await copyPackage(directory);
  // Keep installed optional modules referenced from bundled code (e.g. ws native accelerators).
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports) {
      if (!imported.external || BUILTINS.has(imported.path) || path.isAbsolute(imported.path)) continue;
      const directory = findPackage(packageName(imported.path), packageRoot, source);
      if (directory) await copyPackage(directory);
    }
  }
  return { modules: Object.keys(result.metafile.inputs).length, bundles: result.outputFiles.length, externalPackages: copied.size };
}
