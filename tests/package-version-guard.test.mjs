import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { verifyPackageVersion } from "../scripts/internal/shared/verify-package-version-lib.mjs";

const roots = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("package version guard", () => {
  it("accepts aligned source and staged runtime metadata", () => {
    const root = fixtureRepo("1.0.8");
    const runtimeRoot = fixtureRuntime(root, "1.0.8");
    expect(verifyPackageVersion({ repoRoot: root, expected: "1.0.8", runtimeRoot }))
      .toBe("1.0.8");
  });

  it("accepts independent Memmy and Memory release versions", () => {
    const root = fixtureRepo("1.1.2", "2.1.0");
    const runtimeRoot = fixtureRuntime(root, "1.1.2", "2.1.0");
    expect(verifyPackageVersion({ repoRoot: root, expected: "1.1.2", runtimeRoot }))
      .toBe("1.1.2");
  });

  it("synchronizes Memmy metadata without overwriting the Memory release", () => {
    const root = fixtureRepo("1.1.1", "2.1.0");
    writeJson(join(root, "package.json"), { version: "1.1.2" });
    const script = join(root, "scripts", "sync-project-version.mjs");
    mkdirSync(dirname(script), { recursive: true });
    copyFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "sync-project-version.mjs"),
      script,
    );

    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(readJson(join(root, "App/memmy-agent/package.json")).version).toBe("1.1.2");
    expect(readJson(join(root, "App/shell/desktop/package.json")).version).toBe("1.1.2");
    expect(readFileSync(join(root, "App/backend/src/project-version.ts"), "utf8"))
      .toContain('MEMMY_VERSION = "1.1.2"');
    expect(readJson(join(root, "Memory/package.json")).version).toBe("2.1.0");
    expect(readJson(join(root, "Memory/src/cli/npm/package.json")).version).toBe("2.1.0");
    const rootLock = readJson(join(root, "package-lock.json"));
    expect(rootLock.version).toBe("1.1.2");
    expect(rootLock.packages[""].version).toBe("1.1.2");
    expect(rootLock.packages["App/shell/desktop"].version).toBe("1.1.2");
    expect(rootLock.packages.Memory.version).toBe("2.1.0");
    const agentLock = readJson(join(root, "App/memmy-agent/package-lock.json"));
    expect(agentLock.version).toBe("1.1.2");
    expect(agentLock.packages[""].version).toBe("1.1.2");
  });

  it("rejects a requested version that differs from source metadata", () => {
    const root = fixtureRepo("1.0.8");
    expect(() => verifyPackageVersion({ repoRoot: root, expected: "1.0.9" }))
      .toThrow(/does not match the requested version/);
  });

  it("rejects stale and missing staged runtime metadata", () => {
    const root = fixtureRepo("1.0.8");
    const runtimeRoot = fixtureRuntime(root, "1.0.8");
    writeJson(join(runtimeRoot, "memmy-agent", "package.json"), { version: "1.0.7" });
    expect(() => verifyPackageVersion({ repoRoot: root, expected: "1.0.8", runtimeRoot }))
      .toThrow(/staged memmy-agent package version/);

    rmSync(join(runtimeRoot, "memory", "package-lock.json"));
    expect(() => verifyPackageVersion({ repoRoot: root, expected: "1.0.8", runtimeRoot }))
      .toThrow(/staged memory lock is missing/);
  });

  it("executes the CLI entrypoint and fails on a stale fixture", () => {
    const root = fixtureRepo("1.0.8");
    const script = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "scripts",
      "internal",
      "shared",
      "verify-package-version.mjs",
    );
    const good = spawnSync(process.execPath, [
      script,
      "--repo-root", root,
      "--expected", "1.0.8",
    ], { encoding: "utf8" });
    expect(good.status, good.stderr).toBe(0);

    const stale = spawnSync(process.execPath, [
      script,
      "--repo-root", root,
      "--expected", "1.0.9",
    ], { encoding: "utf8" });
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain("does not match the requested version");
  });

  it("stops public package wrappers before build on version or config overrides", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
    for (const scriptName of ["package-mac.sh", "package-win.sh"]) {
      const script = join(repoRoot, "scripts", scriptName);
      const mismatch = spawnSync("bash", [script, "--version", "9.9.9"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(mismatch.status).not.toBe(0);
      expect(mismatch.stderr).toContain("does not match the requested version");

      const override = spawnSync("bash", [
        script,
        "--version", version,
        "--config", "untrusted-builder.yml",
      ], { cwd: repoRoot, encoding: "utf8" });
      expect(override.status).not.toBe(0);
      expect(override.stderr).toContain("cannot be overridden");
    }
  });
});

function fixtureRepo(version, memoryVersion = version) {
  const root = mkdtempSync(join(tmpdir(), "memmy-version-guard-"));
  roots.push(root);
  for (const relativePath of [
    "package.json",
    "App/memmy-agent/package.json",
    "App/shell/desktop/package.json",
  ]) {
    writeJson(join(root, relativePath), { version });
  }
  for (const relativePath of [
    "Memory/package.json",
    "Memory/src/cli/npm/package.json",
  ]) {
    writeJson(join(root, relativePath), { version: memoryVersion });
  }
  writeJson(join(root, "package-lock.json"), {
    version,
    packages: {
      "": { version },
      Memory: { version: memoryVersion },
      "App/shell/desktop": { version },
    },
  });
  writeJson(join(root, "App/memmy-agent/package-lock.json"), {
    version,
    packages: { "": { version } },
  });
  writeText(
    join(root, "App/backend/src/project-version.ts"),
    `export const MEMMY_VERSION = ${JSON.stringify(version)};\n`,
  );
  return root;
}

function fixtureRuntime(root, version, memoryVersion = version) {
  const runtimeRoot = join(root, "App/shell/desktop/dist/runtime");
  for (const [component, componentVersion] of [
    ["memory", memoryVersion],
    ["memmy-agent", version],
  ]) {
    writeJson(join(runtimeRoot, component, "package.json"), { version: componentVersion });
    writeJson(join(runtimeRoot, component, "package-lock.json"), {
      version: componentVersion,
      packages: { "": { version: componentVersion } },
    });
  }
  return runtimeRoot;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}
