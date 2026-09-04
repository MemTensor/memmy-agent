import {
  lstat,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const supportedPlatforms = new Set(["darwin", "linux", "win32"]);
const supportedArchitectures = new Set(["arm64", "x64"]);
const runtimeComponents = ["memory", "memmy-agent"];

/**
 * Removes only platform-incompatible native files and packaging-only production residue.
 * Every destructive path is derived beneath the supplied runtime root after all safety
 * prerequisites have passed.
 */
export const prunePackagedRuntime = async ({ platform, arch, runtimeRoot }) => {
  validateOptions({ platform, arch, runtimeRoot });
  const normalizedRuntimeRoot = resolve(runtimeRoot);
  const onnxRuntimeRoot = join(
    normalizedRuntimeRoot,
    "memory",
    "node_modules",
    "onnxruntime-node",
    "bin",
    "napi-v3",
  );
  const requiredOnnxRuntimeRoot = join(onnxRuntimeRoot, platform, arch);
  await requireDirectory(requiredOnnxRuntimeRoot, "required onnxruntime-node target directory");
  if (platform === "win32") {
    await requireFile(
      join(requiredOnnxRuntimeRoot, "onnxruntime_binding.node"),
      "required onnxruntime-node Windows binding",
    );
    await requireFile(
      join(requiredOnnxRuntimeRoot, "onnxruntime.dll"),
      "required onnxruntime-node Windows DLL",
    );
  }

  const agentNodeModules = join(normalizedRuntimeRoot, "memmy-agent", "node_modules");
  const optionalPeerToolchain = await resolveOptionalPeerToolchainTargets(agentNodeModules);
  if (optionalPeerToolchain.paths.length > 0) {
    await requireOptionalVitestPeer(join(agentNodeModules, "html-validate", "package.json"));
    await requireExclusiveOptionalPeerDependencyPaths({
      packageLockPath: join(normalizedRuntimeRoot, "memmy-agent", "package-lock.json"),
      targetPackageKeys: optionalPeerToolchain.packageKeys,
    });
  }

  const categories = {
    incompatibleOnnxRuntime: createCategoryResult(),
    thirdPartySourceMaps: createCategoryResult(),
    optionalPeerToolchain: createCategoryResult(),
  };

  await pruneIncompatibleOnnxRuntime({
    onnxRuntimeRoot,
    platform,
    arch,
    result: categories.incompatibleOnnxRuntime,
  });
  for (const component of runtimeComponents) {
    await pruneThirdPartySourceMaps(
      join(normalizedRuntimeRoot, component, "node_modules"),
      categories.thirdPartySourceMaps,
    );
  }
  for (const targetPath of optionalPeerToolchain.paths) {
    await removeMeasured(targetPath, categories.optionalPeerToolchain);
  }

  const totals = Object.values(categories).reduce(
    (result, category) => ({
      removedFiles: result.removedFiles + category.removedFiles,
      removedBytes: result.removedBytes + category.removedBytes,
      removedDirectories: result.removedDirectories + category.removedDirectories,
    }),
    createCategoryResult(),
  );

  return {
    platform,
    arch,
    runtimeRoot: normalizedRuntimeRoot,
    ...totals,
    categories,
  };
};

const validateOptions = ({ platform, arch, runtimeRoot }) => {
  if (!supportedPlatforms.has(platform)) {
    throw new Error(`Unsupported packaged runtime platform: ${platform ?? "<missing>"}`);
  }
  if (!supportedArchitectures.has(arch)) {
    throw new Error(`Unsupported packaged runtime architecture: ${arch ?? "<missing>"}`);
  }
  if (typeof runtimeRoot !== "string" || runtimeRoot.trim() === "" || !isAbsolute(runtimeRoot)) {
    throw new Error("Packaged runtime root must be a non-empty absolute path");
  }
};

const requireDirectory = async (path, description) => {
  const entry = await lstat(path).catch(() => null);
  if (!entry?.isDirectory()) {
    throw new Error(`Missing ${description}: ${path}`);
  }
};

const requireFile = async (path, description) => {
  const entry = await lstat(path).catch(() => null);
  if (!entry?.isFile()) {
    throw new Error(`Missing ${description}: ${path}`);
  }
};

const requireOptionalVitestPeer = async (packageJsonPath) => {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot verify html-validate optional Vitest peer: ${error}`);
  }
  if (
    typeof manifest?.peerDependencies?.vitest !== "string"
    || manifest?.peerDependenciesMeta?.vitest?.optional !== true
  ) {
    throw new Error("html-validate does not declare an optional Vitest peer");
  }
};

const resolveOptionalPeerToolchainTargets = async (nodeModulesRoot) => {
  const paths = [];
  const packageKeys = [];
  for (const packageName of ["vitest", "vite", "rolldown"]) {
    if (await pushExistingTarget(paths, join(nodeModulesRoot, packageName))) {
      packageKeys.push(`node_modules/${packageName}`);
    }
  }
  const vitestScope = join(nodeModulesRoot, "@vitest");
  if (await pushExistingTarget(paths, vitestScope)) {
    for (const entry of await readDirectoryOrEmpty(vitestScope)) {
      if (entry.isDirectory()) packageKeys.push(`node_modules/@vitest/${entry.name}`);
    }
  }

  const rolldownScope = join(nodeModulesRoot, "@rolldown");
  for (const entry of await readDirectoryOrEmpty(rolldownScope)) {
    if (entry.name.startsWith("binding-")) {
      if (await pushExistingTarget(paths, join(rolldownScope, entry.name))) {
        packageKeys.push(`node_modules/@rolldown/${entry.name}`);
      }
    }
  }

  const binariesRoot = join(nodeModulesRoot, ".bin");
  for (const entry of await readDirectoryOrEmpty(binariesRoot)) {
    if (/^(?:rolldown|vite|vitest)(?:\..+)?$/u.test(entry.name)) {
      paths.push(join(binariesRoot, entry.name));
    }
  }
  return { paths, packageKeys };
};

const pushExistingTarget = async (targets, targetPath) => {
  if (await lstat(targetPath).catch(() => null)) {
    targets.push(targetPath);
    return true;
  }
  return false;
};

const requireExclusiveOptionalPeerDependencyPaths = async ({ packageLockPath, targetPackageKeys }) => {
  let lock;
  try {
    lock = JSON.parse(await readFile(packageLockPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot verify optional-peer dependency paths: ${error}`);
  }
  const packages = lock?.packages;
  if (!packages || typeof packages !== "object" || !packages[""]) {
    throw new Error("Cannot verify optional-peer dependency paths: package-lock.json has no package graph");
  }

  const targetSet = new Set(targetPackageKeys);
  const visited = new Set();
  const approvedTargets = new Set();
  const queue = [];
  for (const dependencyName of dependencyNames(packages[""])) {
    const packageKey = resolveLockDependency(packages, "", dependencyName);
    if (packageKey) queue.push({ packageKey, approved: false, path: ["<runtime>", dependencyName] });
  }

  while (queue.length > 0) {
    const current = queue.shift();
    const visitKey = `${current.packageKey}|${current.approved}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);

    if (targetSet.has(current.packageKey)) {
      if (!current.approved) {
        throw new Error(`Cannot prune optional-peer toolchain: production dependency path reaches ${packageNameFromKey(current.packageKey)}: ${current.path.join(" -> ")}`);
      }
      approvedTargets.add(current.packageKey);
    }

    const manifest = packages[current.packageKey];
    if (!manifest || typeof manifest !== "object") continue;
    for (const dependencyName of dependencyNames(manifest)) {
      const childKey = resolveLockDependency(packages, current.packageKey, dependencyName);
      if (childKey) {
        queue.push({
          packageKey: childKey,
          approved: current.approved,
          path: [...current.path, dependencyName],
        });
      }
    }
    for (const dependencyName of optionalPeerDependencyNames(manifest)) {
      const childKey = resolveLockDependency(packages, current.packageKey, dependencyName);
      if (!childKey) continue;
      const approved = current.approved
        || (packageNameFromKey(current.packageKey) === "html-validate" && dependencyName === "vitest");
      queue.push({ packageKey: childKey, approved, path: [...current.path, `${dependencyName} (optional peer)`] });
    }
    for (const dependencyName of requiredPeerDependencyNames(manifest)) {
      const childKey = resolveLockDependency(packages, current.packageKey, dependencyName);
      if (childKey) {
        queue.push({
          packageKey: childKey,
          approved: current.approved,
          path: [...current.path, `${dependencyName} (required peer)`],
        });
      }
    }
  }

  for (const targetPackageKey of targetSet) {
    if (!packages[targetPackageKey]) {
      throw new Error(`Cannot verify optional-peer dependency path for installed package: ${targetPackageKey}`);
    }
    if (!approvedTargets.has(targetPackageKey)) {
      throw new Error(`Cannot verify that ${packageNameFromKey(targetPackageKey)} is reachable only through html-validate's optional Vitest peer`);
    }
  }
};

const dependencyNames = (manifest) => [
  ...Object.keys(manifest?.dependencies ?? {}),
  ...Object.keys(manifest?.optionalDependencies ?? {}),
];

const optionalPeerDependencyNames = (manifest) => Object.keys(manifest?.peerDependencies ?? {})
  .filter((name) => manifest?.peerDependenciesMeta?.[name]?.optional === true);

const requiredPeerDependencyNames = (manifest) => Object.keys(manifest?.peerDependencies ?? {})
  .filter((name) => manifest?.peerDependenciesMeta?.[name]?.optional !== true);

const resolveLockDependency = (packages, parentKey, dependencyName) => {
  let ancestor = parentKey;
  while (true) {
    const candidate = ancestor
      ? `${ancestor}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    if (packages[candidate]) return candidate;
    const marker = ancestor.lastIndexOf("/node_modules/");
    if (marker < 0) {
      if (!ancestor) return null;
      ancestor = "";
    } else {
      ancestor = ancestor.slice(0, marker);
    }
  }
};

const packageNameFromKey = (packageKey) => {
  const marker = packageKey.lastIndexOf("/node_modules/");
  const relative = marker >= 0 ? packageKey.slice(marker + "/node_modules/".length) : packageKey.slice("node_modules/".length);
  const parts = relative.split("/");
  return parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
};

const pruneIncompatibleOnnxRuntime = async ({ onnxRuntimeRoot, platform, arch, result }) => {
  for (const platformEntry of await readDirectoryOrEmpty(onnxRuntimeRoot)) {
    if (!platformEntry.isDirectory()) continue;
    const platformPath = join(onnxRuntimeRoot, platformEntry.name);
    if (platformEntry.name !== platform) {
      await removeMeasured(platformPath, result);
      continue;
    }

    for (const archEntry of await readDirectoryOrEmpty(platformPath)) {
      if (archEntry.isDirectory() && archEntry.name !== arch) {
        await removeMeasured(join(platformPath, archEntry.name), result);
      }
    }
  }
};

const pruneThirdPartySourceMaps = async (nodeModulesRoot, result) => {
  const nodeModulesEntry = await lstat(nodeModulesRoot).catch(() => null);
  if (!nodeModulesEntry?.isDirectory()) return;

  const visit = async (directory, relativeParts = []) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      const nextRelativeParts = [...relativeParts, entry.name];
      if (entry.isDirectory()) {
        await visit(entryPath, nextRelativeParts);
      } else if (entry.name.toLowerCase().endsWith(".map") && !isFirstPartyPackagePath(nextRelativeParts)) {
        await removeMeasured(entryPath, result);
      }
    }
  };
  await visit(nodeModulesRoot);
};

const isFirstPartyPackagePath = (relativeParts) => {
  const nestedNodeModules = relativeParts.lastIndexOf("node_modules");
  const ownerStart = nestedNodeModules + 1;
  return relativeParts[ownerStart] === "@memmy" && Boolean(relativeParts[ownerStart + 1]);
};

const removeMeasured = async (targetPath, result) => {
  const measurement = await measurePath(targetPath);
  if (!measurement) return;
  await rm(targetPath, { recursive: true, force: true });
  result.removedFiles += measurement.removedFiles;
  result.removedBytes += measurement.removedBytes;
  result.removedDirectories += measurement.removedDirectories;
};

const measurePath = async (targetPath) => {
  const entry = await lstat(targetPath).catch(() => null);
  if (!entry) return null;
  if (!entry.isDirectory()) {
    return { removedFiles: 1, removedBytes: entry.size, removedDirectories: 0 };
  }

  const result = { removedFiles: 0, removedBytes: 0, removedDirectories: 1 };
  for (const child of await readdir(targetPath)) {
    const measurement = await measurePath(join(targetPath, child));
    if (!measurement) continue;
    result.removedFiles += measurement.removedFiles;
    result.removedBytes += measurement.removedBytes;
    result.removedDirectories += measurement.removedDirectories;
  }
  return result;
};

const readDirectoryOrEmpty = async (path) => {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
};

const createCategoryResult = () => ({
  removedFiles: 0,
  removedBytes: 0,
  removedDirectories: 0,
});
