import { describe, expect, it } from "vitest";
import type { InventoryEntry } from "../../../src/service/project-environment/types.js";
import {
  buildCompactFileTree,
  deterministicReadCandidates,
  isDeterministicCandidate,
  projectFingerprint,
  requiredRuntimeProbes
} from "../../../src/service/project-environment/scan-policy.js";

describe("project environment scan policy", () => {
  it.each([
    "package.json", "tsconfig.base.json", "eslint.config.ts", "pyproject.toml",
    "Cargo.toml", "go.mod", "pom.xml", "build.gradle.kts", "Makefile",
    "Dockerfile.dev", ".github/workflows/ci.yaml", "app/example.csproj", ".tool-versions"
  ])("allows the closed deterministic candidate %s", (path) => {
    expect(isDeterministicCandidate(path)).toBe(true);
  });

  it.each([
    "src/config.json", "README.md", "src/index.ts", "docs/settings.yaml",
    ".env", ".npmrc", "settings.xml", "deploy-secret.yaml", "private.pem",
    "nested/package.json", ".github/workflows/nested/ci.yml"
  ])("does not hash or read %s", (path) => {
    expect(isDeterministicCandidate(path)).toBe(false);
  });

  it("plans only supported deterministic reads and runtime probes", () => {
    const entries: InventoryEntry[] = [
      hashedFile("package.json", "a"),
      file("src/index.ts"),
      hashedFile(".env", "b")
    ];
    expect(deterministicReadCandidates(entries)).toEqual([{
      relativePath: "package.json",
      sha256: "a".repeat(64),
      maxBytes: 1024 * 1024
    }]);
    expect(requiredRuntimeProbes(entries)).toEqual(["node_version"]);
  });

  it("builds a deterministic tree and fingerprints semantic evidence only", () => {
    const first: InventoryEntry[] = [
      file("src/z.ts", 10, 100),
      directory("src"),
      hashedFile("package.json", "a", 20, 200),
      file("src/a.ts", 30, 300)
    ];
    const reordered: InventoryEntry[] = [
      file("src/a.ts", 999, 999),
      hashedFile("package.json", "a", 999, 999),
      directory("src", 999),
      file("src/z.ts", 999, 999)
    ];
    expect(buildCompactFileTree(first)).toBe("package.json\nsrc/\n  a.ts\n  z.ts");
    const facts = { languages: ["TypeScript"] };
    const left = projectFingerprint({ kind: "code", entries: first, omittedCount: 0, deterministicFacts: facts });
    const right = projectFingerprint({ kind: "code", entries: reordered, omittedCount: 0, deterministicFacts: facts });
    expect(right).toBe(left);
    expect(projectFingerprint({
      kind: "code",
      entries: [hashedFile("package.json", "b"), directory("src"), file("src/a.ts"), file("src/z.ts")],
      omittedCount: 0,
      deterministicFacts: facts
    })).not.toBe(left);
  });
});

function file(relativePath: string, size = 1, mtimeMs = 1): Extract<InventoryEntry, { type: "file" }> {
  return { relativePath, type: "file", size, mtimeMs };
}

function hashedFile(
  relativePath: string,
  hashCharacter: string,
  size = 1,
  mtimeMs = 1
): Extract<InventoryEntry, { type: "file" }> {
  return { ...file(relativePath, size, mtimeMs), sha256: hashCharacter.repeat(64) };
}

function directory(relativePath: string, mtimeMs = 1): Extract<InventoryEntry, { type: "directory" }> {
  return { relativePath, type: "directory", mtimeMs };
}
