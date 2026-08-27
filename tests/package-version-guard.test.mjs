import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function fixtureRepo(version) {
  const root = mkdtempSync(join(tmpdir(), "memmy-version-guard-"));
  roots.push(root);
  for (const relativePath of [
    "package.json",
    "Memory/package.json",
    "Memory/src/cli/npm/package.json",
    "App/memmy-agent/package.json",
    "App/shell/desktop/package.json",
  ]) {
    writeJson(join(root, relativePath), { version });
  }
  writeJson(join(root, "package-lock.json"), {
    version,
    packages: {
      "": { version },
      Memory: { version },
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

function fixtureRuntime(root, version) {
  const runtimeRoot = join(root, "App/shell/desktop/dist/runtime");
  for (const component of ["memory", "memmy-agent"]) {
    writeJson(join(runtimeRoot, component, "package.json"), { version });
    writeJson(join(runtimeRoot, component, "package-lock.json"), {
      version,
      packages: { "": { version } },
    });
  }
  return runtimeRoot;
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}
