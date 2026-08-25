import { XMLParser } from "fast-xml-parser";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import ts from "typescript";
import YAML from "yaml";
import { extensionOf } from "./scan-policy.js";
import type {
  InventoryEntry,
  ProjectEnvironmentTextFile,
  RuntimeProbeResult
} from "./types.js";

export interface SourcedFact {
  value: string;
  sourceRelativePath: string;
  sourceSha256: string;
}

interface RuntimeProbeFact {
  probe: string;
  value: string;
}

export interface DeterministicProjectFacts {
  languageCounts: Record<string, number>;
  manifestLanguages: SourcedFact[];
  runtimeDeclarations: SourcedFact[];
  runtimeProbes: RuntimeProbeFact[];
  toolchains: SourcedFact[];
  buildEntries: SourcedFact[];
  testEntries: SourcedFact[];
  checkEntries: SourcedFact[];
}

export function parseDeterministicProjectFacts(input: {
  entries: InventoryEntry[];
  textFiles: ProjectEnvironmentTextFile[];
  runtimeProbes: RuntimeProbeResult[];
}): DeterministicProjectFacts {
  const facts: DeterministicProjectFacts = {
    languageCounts: sourceLanguageCounts(input.entries),
    manifestLanguages: [],
    runtimeDeclarations: [],
    runtimeProbes: [],
    toolchains: [],
    buildEntries: [],
    testEntries: [],
    checkEntries: []
  };
  for (const probe of input.runtimeProbes) {
    if (probe.exitCode === 0 && typeof probe.versionText === "string") {
      facts.runtimeProbes.push({ probe: probe.probe, value: probe.versionText });
    }
  }
  for (const file of input.textFiles) {
    parseConfigFile(facts, file.relativePath, file.sha256, file.text);
  }
  inferToolchainsFromInventory(facts, input.entries);
  return normalizeFacts(facts);
}

function parseConfigFile(
  facts: DeterministicProjectFacts,
  relativePath: string,
  sha256: string,
  text: string
): void {
  const basename = relativePath.split("/").at(-1) ?? relativePath;
  const lower = basename.toLowerCase();
  const add = (collection: SourcedFact[], value: unknown): void => {
    if (typeof value !== "string" || !value.trim()) return;
    collection.push({ value: value.trim(), sourceRelativePath: relativePath, sourceSha256: sha256 });
  };

  try {
    if (lower === "package.json") {
      const value = JSON.parse(text) as Record<string, unknown>;
      add(facts.manifestLanguages, "Node.js/JavaScript");
      const engines = record(value.engines);
      if (engines) {
        for (const [runtime, version] of Object.entries(engines)) add(facts.runtimeDeclarations, `${runtime} ${stringValue(version) ?? ""}`);
      }
      add(facts.toolchains, stringValue(value.packageManager));
      const scripts = record(value.scripts);
      if (scripts) {
        for (const name of Object.keys(scripts).sort(compare)) {
          const command = `npm run ${name}`;
          if (/^(build|compile|bundle)(:|$)/i.test(name)) add(facts.buildEntries, command);
          if (/^(test|spec)(:|$)/i.test(name)) add(facts.testEntries, command);
          if (/^(lint|check|typecheck|format)(:|$)/i.test(name)) add(facts.checkEntries, command);
        }
      }
      return;
    }
    if (/^(tsconfig|jsconfig).*\.json$/i.test(basename) || lower.endsWith(".json")) {
      const value = parseJsonc(text) as Record<string, unknown> | undefined;
      if (value && lower.startsWith("tsconfig")) add(facts.toolchains, "TypeScript");
      if (value && lower.includes("jest")) {
        add(facts.toolchains, "Jest");
        add(facts.testEntries, "Jest configuration");
      }
      return;
    }
    if (/\.(ya?ml)$/i.test(basename) || lower === ".eslintrc") {
      const value = YAML.parse(text) as unknown;
      if (lower.includes("pnpm")) add(facts.toolchains, "pnpm");
      if (relativePath.startsWith(".github/workflows/") || lower.includes("pipeline") || lower.includes("gitlab")) {
        add(facts.toolchains, "CI");
        for (const command of collectNamedStrings(value, "run")) categorizeCommand(facts, add, command);
      }
      if (lower.includes("compose")) {
        add(facts.toolchains, "Docker Compose");
        add(facts.buildEntries, "docker compose build");
      }
      if (lower === ".eslintrc" || lower.includes("eslint")) {
        add(facts.toolchains, "ESLint");
        add(facts.checkEntries, "ESLint configuration");
      }
      return;
    }
    if (["pyproject.toml", "poetry.lock", "uv.lock", "cargo.toml", "cargo.lock", "rust-toolchain.toml"].includes(lower)) {
      const value = parseToml(text) as Record<string, unknown>;
      if (lower === "pyproject.toml") {
        add(facts.manifestLanguages, "Python");
        const project = record(value.project);
        add(facts.runtimeDeclarations, project ? stringValue(project["requires-python"]) : undefined);
        const tool = record(value.tool);
        if (tool?.poetry) add(facts.toolchains, "Poetry");
        if (tool?.uv) add(facts.toolchains, "uv");
        if (tool?.pytest) {
          add(facts.toolchains, "pytest");
          add(facts.testEntries, "pytest");
        }
        if (tool?.ruff) {
          add(facts.toolchains, "Ruff");
          add(facts.checkEntries, "ruff check .");
        }
        if (tool?.mypy) {
          add(facts.toolchains, "mypy");
          add(facts.checkEntries, "mypy");
        }
        const buildSystem = record(value["build-system"]);
        add(facts.toolchains, buildSystem ? stringValue(buildSystem["build-backend"]) : undefined);
      } else if (lower.startsWith("cargo") || lower.startsWith("rust-toolchain")) {
        add(facts.manifestLanguages, "Rust");
        add(facts.toolchains, "Cargo");
        add(facts.buildEntries, "cargo build");
        add(facts.testEntries, "cargo test");
        add(facts.checkEntries, "cargo clippy");
        const toolchain = record(value.toolchain);
        add(facts.runtimeDeclarations, toolchain ? stringValue(toolchain.channel) : undefined);
      }
      return;
    }
    if (lower === "pom.xml" || lower.endsWith(".csproj")) {
      const parsed = new XMLParser({ ignoreAttributes: false }).parse(text) as Record<string, unknown>;
      if (lower === "pom.xml") {
        add(facts.manifestLanguages, "Java");
        add(facts.toolchains, "Maven");
        add(facts.buildEntries, "mvn package");
        add(facts.testEntries, "mvn test");
      } else {
        add(facts.manifestLanguages, ".NET/C#");
        add(facts.toolchains, ".NET SDK");
        add(facts.buildEntries, "dotnet build");
        add(facts.testEntries, "dotnet test");
      }
      void parsed;
      return;
    }
    if (lower === "go.mod") {
      add(facts.manifestLanguages, "Go");
      add(facts.toolchains, "Go modules");
      add(facts.buildEntries, "go build ./...");
      add(facts.testEntries, "go test ./...");
      const version = /^go\s+([^\s]+)$/m.exec(text)?.[1];
      add(facts.runtimeDeclarations, version ? `Go ${version}` : undefined);
      return;
    }
    if (/^requirements.*\.txt$/i.test(basename)) {
      add(facts.manifestLanguages, "Python");
      add(facts.toolchains, "pip");
      return;
    }
    if (/^(tox\.ini|pytest\.ini|setup\.cfg)$/i.test(basename)) {
      const sections = parseIniSections(text);
      if (lower === "tox.ini") {
        add(facts.toolchains, "tox");
        add(facts.testEntries, "tox");
      }
      if (lower === "pytest.ini" || sections.some((section) => section.startsWith("tool:pytest"))) {
        add(facts.toolchains, "pytest");
        add(facts.testEntries, "pytest");
      }
      if (sections.some((section) => section.includes("flake8"))) {
        add(facts.toolchains, "Flake8");
        add(facts.checkEntries, "flake8");
      }
      return;
    }
    if (/^(\.nvmrc|\.node-version|\.python-version|\.java-version|\.ruby-version|rust-toolchain)$/i.test(basename)) {
      add(facts.runtimeDeclarations, `${basename} ${text.trim()}`);
      return;
    }
    if (lower === ".tool-versions") {
      for (const line of text.split(/\r?\n/u)) add(facts.runtimeDeclarations, line.replace(/\s+/gu, " ").trim());
      return;
    }
    if (lower === "makefile") {
      add(facts.toolchains, "Make");
      const targets = [...text.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?![=])/gm)].map((match) => match[1]!);
      for (const target of targets) {
        if (/^(build|all|compile)$/i.test(target)) add(facts.buildEntries, `make ${target}`);
        if (/^test/i.test(target)) add(facts.testEntries, `make ${target}`);
        if (/^(lint|check|format)/i.test(target)) add(facts.checkEntries, `make ${target}`);
      }
      return;
    }
    if (/^dockerfile(\..*)?$/i.test(basename)) {
      add(facts.toolchains, "Docker");
      add(facts.buildEntries, "docker build .");
      const base = /^\s*FROM\s+([^\s]+)/imu.exec(text)?.[1];
      add(facts.runtimeDeclarations, base ? `Docker base ${base}` : undefined);
      return;
    }
    if (lower.endsWith(".sln")) {
      add(facts.manifestLanguages, ".NET/C#");
      add(facts.toolchains, ".NET SDK");
      add(facts.buildEntries, "dotnet build");
      add(facts.testEntries, "dotnet test");
      return;
    }
    if (lower === "gradle.properties") {
      add(facts.toolchains, "Gradle");
      return;
    }
    if (lower === "jenkinsfile") {
      add(facts.toolchains, "Jenkins");
      return;
    }
    if (/^(build|settings)\.gradle(\.kts)?$/i.test(basename)) {
      add(facts.manifestLanguages, "JVM");
      add(facts.toolchains, "Gradle");
      add(facts.buildEntries, "./gradlew build");
      add(facts.testEntries, "./gradlew test");
      return;
    }
    if (/^(eslint|jest|vitest)\.config\.(js|cjs|mjs|ts)$/i.test(basename) || /^\.eslintrc\.(js|cjs)$/i.test(basename)) {
      const source = ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, false);
      const hasStaticObject = source.statements.some((statement) => {
        if (ts.isExportAssignment(statement)) return staticLiteral(statement.expression) !== undefined;
        return ts.isExpressionStatement(statement) && staticModuleAssignment(statement.expression);
      });
      if (hasStaticObject) {
        if (/eslint/i.test(basename)) {
          add(facts.toolchains, "ESLint");
          add(facts.checkEntries, "ESLint configuration");
        } else {
          add(facts.toolchains, /vitest/i.test(basename) ? "Vitest" : "Jest");
          add(facts.testEntries, /vitest/i.test(basename) ? "Vitest configuration" : "Jest configuration");
        }
      }
    }
  } catch {
    // Invalid or dynamic configuration is deliberately ignored rather than guessed.
  }
}

function collectNamedStrings(value: unknown, key: string): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => collectNamedStrings(item, key));
  const object = record(value);
  if (!object) return [];
  const result: string[] = [];
  for (const [name, child] of Object.entries(object)) {
    if (name === key && typeof child === "string" && child.trim()) result.push(child.trim());
    result.push(...collectNamedStrings(child, key));
  }
  return result;
}

function categorizeCommand(
  facts: DeterministicProjectFacts,
  add: (collection: SourcedFact[], value: unknown) => void,
  command: string
): void {
  const normalized = command.replace(/\s+/gu, " ").trim();
  if (/\b(build|compile|bundle|package)\b/iu.test(normalized)) add(facts.buildEntries, normalized);
  if (/\b(test|pytest|vitest|jest)\b/iu.test(normalized)) add(facts.testEntries, normalized);
  if (/\b(lint|check|typecheck|format|ruff|mypy)\b/iu.test(normalized)) add(facts.checkEntries, normalized);
}

function parseIniSections(text: string): string[] {
  return text.split(/\r?\n/u)
    .map((line) => /^\s*\[([^\]]+)\]\s*$/u.exec(line)?.[1]?.trim().toLowerCase())
    .filter((section): section is string => Boolean(section));
}

function inferToolchainsFromInventory(facts: DeterministicProjectFacts, entries: InventoryEntry[]): void {
  const add = (collection: SourcedFact[], value: string, path: string, sha256 = "inventory"): void => {
    collection.push({ value, sourceRelativePath: path, sourceSha256: sha256 });
  };
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const path = entry.relativePath;
    const lower = path.toLowerCase();
    const sha = entry.sha256 ?? "inventory";
    if (lower === "package-lock.json") add(facts.toolchains, "npm", path, sha);
    else if (lower === "pnpm-lock.yaml") add(facts.toolchains, "pnpm", path, sha);
    else if (lower === "yarn.lock") add(facts.toolchains, "Yarn", path, sha);
    else if (lower === "bun.lock") add(facts.toolchains, "Bun", path, sha);
    else if (lower === "poetry.lock") add(facts.toolchains, "Poetry", path, sha);
    else if (lower === "uv.lock") add(facts.toolchains, "uv", path, sha);
    else if (lower === "cargo.lock") add(facts.toolchains, "Cargo", path, sha);
    else if (lower === "dockerfile" || lower.startsWith("dockerfile.")) add(facts.toolchains, "Docker", path, sha);
    else if (lower.startsWith(".github/workflows/") || lower === ".gitlab-ci.yml") add(facts.toolchains, "CI", path, sha);
  }
}

function sourceLanguageCounts(entries: InventoryEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const extension = extensionOf(entry.relativePath);
    if (!extension) continue;
    const name = languageName(extension);
    if (name === extension) continue;
    counts[extension] = (counts[extension] ?? 0) + 1;
  }
  return counts;
}

function normalizeFacts(facts: DeterministicProjectFacts): DeterministicProjectFacts {
  const sourcedKeys: Array<keyof Pick<DeterministicProjectFacts,
    "manifestLanguages" | "runtimeDeclarations" | "toolchains" | "buildEntries" | "testEntries" | "checkEntries">> = [
      "manifestLanguages", "runtimeDeclarations", "toolchains", "buildEntries", "testEntries", "checkEntries"
    ];
  for (const key of sourcedKeys) {
    const seen = new Set<string>();
    facts[key] = facts[key]
      .sort((left, right) => compare(`${left.sourceRelativePath}\0${left.value}`, `${right.sourceRelativePath}\0${right.value}`))
      .filter((fact) => {
        const normalized = fact.value.trim();
        if (!normalized || seen.has(normalized)) return false;
        seen.add(normalized);
        fact.value = normalized;
        return true;
      });
  }
  const probeOrder = ["node_version", "python_version", "go_version", "rust_version", "java_version"];
  facts.runtimeProbes.sort((left, right) => probeOrder.indexOf(left.probe) - probeOrder.indexOf(right.probe));
  return facts;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function staticLiteral(node: ts.Expression): unknown {
  if (ts.isParenthesizedExpression(node)) return staticLiteral(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) {
    const values = node.elements.map((element) => ts.isExpression(element) ? staticLiteral(element) : undefined);
    return values.some((value) => value === undefined) ? undefined : values;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const value: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || property.name === undefined || ts.isComputedPropertyName(property.name)) return undefined;
      const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)
        ? property.name.text
        : undefined;
      const child = staticLiteral(property.initializer);
      if (!name || child === undefined) return undefined;
      value[name] = child;
    }
    return value;
  }
  return undefined;
}

function staticModuleAssignment(node: ts.Expression): boolean {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  if (!ts.isPropertyAccessExpression(node.left) || node.left.name.text !== "exports") return false;
  if (!ts.isIdentifier(node.left.expression) || node.left.expression.text !== "module") return false;
  return staticLiteral(node.right) !== undefined;
}

function languageName(extension: string): string {
  return ({
    ".c": "C", ".cc": "C++", ".cpp": "C++", ".cs": "C#", ".go": "Go", ".h": "C/C++",
    ".hpp": "C++", ".java": "Java", ".js": "JavaScript", ".jsx": "JavaScript/JSX", ".kt": "Kotlin",
    ".kts": "Kotlin", ".mjs": "JavaScript", ".cjs": "JavaScript", ".php": "PHP", ".py": "Python",
    ".rb": "Ruby", ".rs": "Rust", ".scala": "Scala", ".swift": "Swift", ".ts": "TypeScript", ".tsx": "TypeScript/TSX"
  } as Record<string, string>)[extension] ?? extension;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
