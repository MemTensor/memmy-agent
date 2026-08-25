import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseDeterministicProjectFacts } from "../../../src/service/project-environment/manifest-parsers.js";
import type {
  InventoryEntry,
  ProjectEnvironmentTextFile
} from "../../../src/service/project-environment/types.js";

describe("deterministic project manifest parsers", () => {
  it("extracts manifest, command, toolchain, and runtime facts from local text results", () => {
    const textFiles = [
      textFile("package.json", JSON.stringify({
        packageManager: "pnpm@10",
        engines: { node: ">=22" },
        scripts: { build: "tsc", test: "vitest", lint: "eslint ." }
      })),
      textFile("pyproject.toml", "[project]\nrequires-python='>=3.12'\n[tool.pytest.ini_options]\naddopts='-q'"),
      textFile("Cargo.toml", "[package]\nname='demo'"),
      textFile("go.mod", "module example.test/demo\n\ngo 1.24\n"),
      textFile("pom.xml", "<project><artifactId>demo</artifactId></project>")
    ];
    const facts = parseDeterministicProjectFacts({
      entries: sourceEntries(),
      textFiles,
      runtimeProbes: [{ probe: "node_version", exitCode: 0, versionText: "v22.23.1" }]
    });
    expect(values(facts.manifestLanguages)).toEqual(expect.arrayContaining([
      "Node.js/JavaScript", "Python", "Rust", "Go", "Java"
    ]));
    expect(values(facts.toolchains)).toEqual(expect.arrayContaining([
      "pnpm@10", "pytest", "Cargo", "Go modules", "Maven"
    ]));
    expect(values(facts.buildEntries)).toEqual(expect.arrayContaining([
      "npm run build", "cargo build", "go build ./...", "mvn package"
    ]));
    expect(facts.runtimeProbes).toEqual([{ probe: "node_version", value: "v22.23.1" }]);
  });

  it("uses only successful runtime probes and does not execute dynamic configuration", () => {
    const facts = parseDeterministicProjectFacts({
      entries: sourceEntries(),
      textFiles: [textFile("eslint.config.js", "export default makeConfig(process.env.SECRET)")],
      runtimeProbes: [
        { probe: "node_version", exitCode: 1, versionText: null },
        { probe: "python_version", exitCode: 0, versionText: "Python 3.12.1" }
      ]
    });
    expect(values(facts.toolchains)).not.toContain("ESLint");
    expect(facts.runtimeProbes).toEqual([{ probe: "python_version", value: "Python 3.12.1" }]);
    expect(facts.languageCounts).toEqual({ ".py": 1, ".ts": 1 });
  });
});

function sourceEntries(): InventoryEntry[] {
  return [file("src/index.ts"), file("tools/main.py")];
}

function file(relativePath: string): Extract<InventoryEntry, { type: "file" }> {
  return { relativePath, type: "file", size: 1, mtimeMs: 1 };
}

function textFile(relativePath: string, text: string): ProjectEnvironmentTextFile {
  return {
    relativePath,
    text,
    sha256: createHash("sha256").update(text).digest("hex")
  };
}

function values(facts: Array<{ value: string }>): string[] {
  return facts.map((fact) => fact.value);
}
