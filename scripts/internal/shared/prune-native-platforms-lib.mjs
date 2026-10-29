import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const platforms = new Set(["darwin", "linux", "win32"]);
const architectures = new Set(["arm64", "x64"]);
const nativePackagePattern = /^node-pty-(darwin|linux|win32)-(arm64|x64)$/u;
const sqlitePackagePattern = /^sqlite-vec-(darwin|linux|windows)-(arm64|x64)$/u;
const prebuildPattern = /^(darwin|linux|win32)-(arm64|x64)$/u;

/** Prune only known dependency native layouts for other platforms or CPUs. */
export async function pruneNativePlatforms({ platform, arch, runtimeRoot }) {
  if (!platforms.has(platform) || !architectures.has(arch)) {
    throw new Error("Unsupported native target platform or architecture");
  }
  if (typeof runtimeRoot !== "string" || !isAbsolute(runtimeRoot)) {
    throw new Error("Native runtime root must be an absolute path");
  }
  await requireDirectory(resolve(runtimeRoot));
  const root = await realpath(runtimeRoot);
  const groups = [];
  for (const component of ["memory", "memmy-agent"]) {
    const componentRoot = join(root, component);
    if (!await entryOrMissing(componentRoot)) continue;
    await requireDirectory(componentRoot);
    const nodeModules = join(componentRoot, "node_modules");
    if (await entryOrMissing(nodeModules)) await discoverNodeModules(nodeModules, groups);
  }
  if (groups.length === 0) throw new Error("No known packaged native target found");

  const removed = [];
  // Validate every scope before deleting anything, including a later nested scope.
  for (const group of groups) {
    if (group.kind === "node-pty") {
      const targetName = `node-pty-${platform}-${arch}`;
      const target = join(group.scope, targetName);
      await requirePackage(root, target, `@lydell/${targetName}`);
      const payload = join(target, "prebuilds", `${platform}-${arch}`);
      const files = platform === "win32"
        ? ["conpty.node", "conpty_console_list.node", "conpty/conpty.dll", "conpty/OpenConsole.exe"]
        : platform === "darwin" ? ["pty.node", "spawn-helper"] : ["pty.node"];
      for (const file of files) await validateNativeFile(root, join(payload, file), platform, arch);
      for (const name of group.packages) {
        if (name === targetName) continue;
        const incompatible = join(group.scope, name);
        await requirePackage(root, incompatible, `@lydell/${name}`);
        removed.push(incompatible);
      }
    } else if (group.kind === "sqlite-vec") {
      const targetName = `sqlite-vec-${platform === "win32" ? "windows" : platform}-${arch}`;
      const target = join(group.scope, targetName);
      await requirePackage(root, target, targetName);
      const extension = platform === "darwin" ? "dylib" : platform === "win32" ? "dll" : "so";
      await validateNativeFile(root, join(target, `vec0.${extension}`), platform, arch);
      for (const name of group.packages) {
        if (name === targetName) continue;
        const incompatible = join(group.scope, name);
        await requirePackage(root, incompatible, name);
        removed.push(incompatible);
      }
    } else if (group.kind === "tree-sitter-bash") {
      await requirePackage(root, group.path, group.kind);
      await planPrebuilds(root, join(group.path, "prebuilds"), "tree-sitter-bash.node", platform, arch, removed);
    } else if (group.kind === "pi-tui") {
      await requirePackage(root, group.path, "@earendil-works/pi-tui");
      for (const nativePlatform of ["darwin", "win32"]) {
        const nativeRoot = join(group.path, "native", nativePlatform);
        if (nativePlatform === platform) {
          await planPrebuilds(root, join(nativeRoot, "prebuilds"),
            platform === "darwin" ? "darwin-modifiers.node" : "win32-console-mode.node", platform, arch, removed);
        } else if (await entryOrMissing(nativeRoot)) removed.push(nativeRoot);
      }
    }
  }
  for (const path of removed) {
    await requirePhysicalPath(root, path);
    await requirePhysicalTree(path);
  }
  for (const path of removed) {
    await requirePhysicalPath(root, path);
    await rm(path, { recursive: true, force: false });
  }
  return { platform, arch, removedPackages: removed.map(path => relative(root, path)) };
}

async function discoverNodeModules(nodeModules, groups) {
  await requireDirectory(nodeModules);
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(nodeModules, entry.name);
    if (entry.name === "@lydell") {
      await requireDirectory(path);
      const names = (await readdir(path)).filter(name => nativePackagePattern.test(name));
      if (names.length) groups.push({ kind: "node-pty", scope: path, packages: names });
    }
    if (entry.name === "tree-sitter-bash") groups.push({ kind: "tree-sitter-bash", path });
    // npm package links are never followed. A nested node_modules link is rejected.
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("@")) {
      for (const scoped of await readdir(path, { withFileTypes: true })) {
        if (entry.name === "@earendil-works" && scoped.name === "pi-tui") {
          groups.push({ kind: "pi-tui", path: join(path, scoped.name) });
        }
        if (scoped.isDirectory()) await discoverNested(join(path, scoped.name), groups);
      }
    } else await discoverNested(path, groups);
  }
  const sqliteNames = (await readdir(nodeModules)).filter(name => sqlitePackagePattern.test(name));
  if (sqliteNames.length) groups.push({ kind: "sqlite-vec", scope: nodeModules, packages: sqliteNames });
}

async function planPrebuilds(root, prebuilds, filename, platform, arch, removed) {
  await requirePhysicalPath(root, prebuilds);
  await requireDirectory(prebuilds);
  const targetName = `${platform}-${arch}`;
  await validateNativeFile(root, join(prebuilds, targetName, filename), platform, arch);
  for (const name of await readdir(prebuilds)) {
    if (prebuildPattern.test(name) && name !== targetName) removed.push(join(prebuilds, name));
  }
}

async function requirePackage(root, path, name) {
  await requirePhysicalPath(root, path);
  await requireDirectory(path);
  const manifestPath = join(path, "package.json");
  await requirePhysicalPath(root, manifestPath);
  if (!(await lstat(manifestPath)).isFile()) throw new Error(`Missing native package manifest: ${path}`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.name !== name) throw new Error(`Wrong native package identity: ${path}`);
}

async function discoverNested(packageRoot, groups) {
  const nested = join(packageRoot, "node_modules");
  if (await entryOrMissing(nested)) await discoverNodeModules(nested, groups);
}

async function validateNativeFile(root, path, platform, arch) {
  await requirePhysicalPath(root, path);
  const stat = await lstat(path);
  if (!stat.isFile()) throw new Error(`Missing native payload: ${path}`);
  const bytes = await readFile(path);
  let valid = false;
  if (platform === "darwin" && bytes.length >= 32) {
    const expected = arch === "arm64" ? 0x0100000c : 0x01000007;
    if (bytes.readUInt32LE(0) === 0xfeedfacf) valid = bytes.readUInt32LE(4) === expected;
    else if (bytes.readUInt32BE(0) === 0xcafebabe || bytes.readUInt32BE(0) === 0xcafebabf) {
      const width = bytes.readUInt32BE(0) === 0xcafebabf ? 32 : 20;
      const count = bytes.readUInt32BE(4);
      if (count <= 32 && bytes.length >= 8 + width * count) {
        for (let index = 0; index < count; index++) {
          if (bytes.readUInt32BE(8 + width * index) === expected) valid = true;
        }
      }
    }
  } else if (platform === "win32" && bytes.length >= 64 && bytes.toString("ascii", 0, 2) === "MZ") {
    const pe = bytes.readUInt32LE(0x3c);
    valid = pe <= bytes.length - 6 && bytes.readUInt32LE(pe) === 0x00004550
      && bytes.readUInt16LE(pe + 4) === (arch === "arm64" ? 0xaa64 : 0x8664);
  } else if (platform === "linux" && bytes.length >= 64) {
    valid = bytes.toString("hex", 0, 4) === "7f454c46" && bytes[4] === 2 && bytes[5] === 1
      && bytes.readUInt16LE(18) === (arch === "arm64" ? 183 : 62);
  }
  if (!valid) throw new Error(`Wrong native payload for ${platform}-${arch}: ${path}`);
}

async function requirePhysicalPath(root, path) {
  const suffix = relative(root, path);
  if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error("Native path escapes the packaged runtime");
  }
  let current = root;
  for (const part of suffix.split(sep)) {
    current = join(current, part);
    const entry = await entryOrMissing(current);
    if (!entry) throw new Error(`Missing native path: ${current}`);
    if (entry.isSymbolicLink()) throw new Error(`Refusing native symbolic link: ${current}`);
  }
}

async function requirePhysicalTree(path) {
  await requireDirectory(path);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing native symbolic link: ${child}`);
    if (entry.isDirectory()) await requirePhysicalTree(child);
  }
}

async function requireDirectory(path) {
  const entry = await entryOrMissing(path);
  if (entry?.isSymbolicLink()) throw new Error(`Refusing native symbolic link: ${path}`);
  if (!entry?.isDirectory()) throw new Error(`Missing native directory: ${path}`);
}

async function entryOrMissing(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
