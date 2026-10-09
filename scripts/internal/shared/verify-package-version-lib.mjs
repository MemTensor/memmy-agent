import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function verifyPackageVersion({ repoRoot = defaultRepoRoot, expected, runtimeRoot }) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(expected ?? "")) {
    throw new Error("Expected package version must use semantic version syntax");
  }

  const failures = [];
  const sourceManifests = [
    "package.json",
    "App/memmy-agent/package.json",
    "App/shell/desktop/package.json",
  ];
  for (const relativePath of sourceManifests) {
    checkJsonVersion(join(repoRoot, relativePath), expected, failures, relativePath);
  }
  const memoryPackage = readJson(join(repoRoot, "Memory/package.json"), failures, "Memory/package.json");
  const memoryVersion = memoryPackage?.version;
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(memoryVersion ?? "")) {
    failures.push("Memory/package.json version must use semantic version syntax");
  }
  checkJsonVersion(join(repoRoot, "Memory/src/cli/npm/package.json"), memoryVersion, failures, "Memory CLI package");

  const rootLock = readJson(join(repoRoot, "package-lock.json"), failures, "package-lock.json");
  checkValue(rootLock?.version, expected, failures, "package-lock.json.version");
  checkValue(rootLock?.packages?.[""]?.version, expected, failures, "package-lock.json packages['']");
  checkValue(rootLock?.packages?.Memory?.version, memoryVersion, failures, "package-lock.json packages.Memory");
  checkValue(
    rootLock?.packages?.["App/shell/desktop"]?.version,
    expected,
    failures,
    "package-lock.json desktop workspace",
  );

  const agentLockPath = join(repoRoot, "App/memmy-agent/package-lock.json");
  const agentLock = readJson(agentLockPath, failures, "App/memmy-agent/package-lock.json");
  checkValue(agentLock?.version, expected, failures, "agent package-lock version");
  checkValue(agentLock?.packages?.[""]?.version, expected, failures, "agent package-lock root");

  const generatedVersionPath = join(repoRoot, "App/backend/src/project-version.ts");
  if (!existsSync(generatedVersionPath)) {
    failures.push("App/backend/src/project-version.ts is missing");
  } else {
    const match = /MEMMY_VERSION\s*=\s*"([^"]+)"/u.exec(readFileSync(generatedVersionPath, "utf8"));
    checkValue(match?.[1], expected, failures, "backend generated version");
  }

  if (runtimeRoot) {
    const runtime = resolve(runtimeRoot);
    for (const [component, componentVersion] of [["memory", memoryVersion], ["memmy-agent", expected]]) {
      const prefix = `staged ${component}`;
      checkJsonVersion(join(runtime, component, "package.json"), componentVersion, failures, `${prefix} package`);
      const lock = readJson(join(runtime, component, "package-lock.json"), failures, `${prefix} lock`);
      checkValue(lock?.version, componentVersion, failures, `${prefix} lock version`);
      checkValue(lock?.packages?.[""]?.version, componentVersion, failures, `${prefix} lock root`);
    }
  }

  if (failures.length) {
    throw new Error(`Package version verification failed:\n- ${failures.join("\n- ")}`);
  }
  return expected;
}

export function parsePackageVersionArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("Usage: verify-package-version.mjs --expected <version> [--runtime-root <path>]");
    }
    const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!new Set(["expected", "runtimeRoot", "repoRoot"]).has(key) || parsed[key]) {
      throw new Error(`Unknown or duplicate option: ${flag}`);
    }
    parsed[key] = value;
  }
  if (!parsed.expected) throw new Error("--expected is required");
  return parsed;
}

function checkJsonVersion(path, expected, failures, label) {
  const json = readJson(path, failures, label);
  checkValue(json?.version, expected, failures, `${label} version`);
}

function readJson(path, failures, label) {
  if (!existsSync(path)) {
    failures.push(`${label} is missing`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    failures.push(`${label} is not valid JSON`);
    return null;
  }
}

function checkValue(actual, expected, failures, label) {
  if (actual !== expected) failures.push(`${label} does not match the requested version`);
}
