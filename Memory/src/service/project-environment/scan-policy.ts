import {
  canonicalJson,
  sha256Hex
} from "@memmy/local-api-contracts";
import type { InventoryEntry, RuntimeProbe } from "./types.js";

export const PROJECT_ENVIRONMENT_SCAN_POLICY = {
  maxDepth: 20,
  maxEntries: 20_000,
  maxRelativePathUtf8Bytes: 4096,
  maxTextBytes: 1024 * 1024
} as const;

export const PROJECT_SOURCE_EXTENSIONS = [
  ".c", ".cc", ".cpp", ".cs", ".go", ".h", ".hpp", ".java", ".js", ".jsx",
  ".kt", ".kts", ".mjs", ".cjs", ".php", ".py", ".rb", ".rs", ".scala",
  ".swift", ".ts", ".tsx"
] as const;

export function isDeterministicCandidate(relativePath: string): boolean {
  if (validateWorkspaceRelativePath(relativePath) || isSensitivePath(relativePath)) return false;
  const segments = relativePath.split("/");
  const basename = segments.at(-1)!;
  const lower = basename.toLowerCase();
  const depth = segments.length - 1;
  if (segments.length === 3 && segments[0] === ".github" && segments[1] === "workflows" && /\.(ya?ml)$/i.test(basename)) return true;
  if (depth <= 2 && /\.(sln|csproj)$/i.test(basename)) return true;
  if (depth !== 0) return false;
  if (/^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|makefile)$/i.test(basename)) return true;
  if (/^(package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lock)$/i.test(basename)) return true;
  if (/^(tsconfig|jsconfig).*\.json$/i.test(basename)) return true;
  if (/^(eslint\.config\.(js|cjs|mjs|ts)|\.eslintrc(\.(json|ya?ml|js|cjs))?)$/i.test(basename)) return true;
  if (/^(jest\.config\.(js|cjs|mjs|ts|json)|vitest\.config\.(js|mjs|ts))$/i.test(basename)) return true;
  if (/^(poetry\.lock|uv\.lock|requirements.*\.txt|\.python-version|tox\.ini|pytest\.ini|setup\.cfg)$/i.test(basename)) return true;
  if (/^(cargo\.lock|rust-toolchain(\.toml)?|go\.sum|go\.work(\.sum)?)$/i.test(basename)) return true;
  if (/^(build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties)$/i.test(basename)) return true;
  if (/^(dockerfile(\..*)?|compose\.ya?ml|docker-compose\.ya?ml)$/i.test(basename)) return true;
  if (/^(\.gitlab-ci\.yml|azure-pipelines\.yml|jenkinsfile)$/i.test(basename)) return true;
  return /^(\.nvmrc|\.node-version|\.tool-versions|\.java-version|\.ruby-version)$/i.test(basename);
}

export function isSensitivePath(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  const basename = lower.split("/").at(-1) ?? lower;
  return basename.startsWith(".env") || basename.includes("credentials") || basename.includes("secret") ||
    /\.(pem|key|p12|pfx|crt|cer)$/i.test(basename) || basename === ".npmrc" ||
    basename === ".pypirc" || basename === "settings.xml" || lower.startsWith(".ssh/");
}

export function validateWorkspaceRelativePath(value: string): string | null {
  if (new TextEncoder().encode(value).byteLength > PROJECT_ENVIRONMENT_SCAN_POLICY.maxRelativePathUtf8Bytes) {
    return "relative path exceeds 4096 UTF-8 bytes";
  }
  if (value.includes("\0")) return "relative path must not contain NUL";
  if (value.includes("\\")) return "relative path must use forward slashes";
  if (value.startsWith("/") || value.startsWith("//")) return "relative path must not be absolute";
  if (/^[A-Za-z]:/.test(value)) return "relative path must not include a Windows drive prefix";
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return "relative path contains an empty, dot, or parent segment";
  }
  return null;
}

export function buildCompactFileTree(entries: InventoryEntry[]): string {
  const paths = entries.map((entry) => ({ path: entry.relativePath, directory: entry.type === "directory" }));
  const children = new Map<string, Map<string, boolean>>();
  for (const item of paths) {
    const segments = item.path.split("/");
    for (let index = 0; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join("/");
      const name = segments[index]!;
      const isDirectory = index < segments.length - 1 || item.directory;
      const siblings = children.get(parent) ?? new Map<string, boolean>();
      siblings.set(name, (siblings.get(name) ?? false) || isDirectory);
      children.set(parent, siblings);
    }
  }
  const lines: string[] = [];
  const visit = (parent: string, depth: number): void => {
    const siblings = children.get(parent);
    if (!siblings) return;
    for (const [name, isDirectory] of [...siblings.entries()].sort(([left], [right]) => compareCodePoints(left, right))) {
      lines.push(`${"  ".repeat(depth)}${name}${isDirectory ? "/" : ""}`);
      if (isDirectory) visit(parent ? `${parent}/${name}` : name, depth + 1);
    }
  };
  visit("", 0);
  return lines.join("\n");
}

export function projectFingerprint(input: {
  kind: "code" | "folder";
  entries: InventoryEntry[];
  omittedCount: number;
  deterministicFacts: unknown;
}): string {
  const sortedTypeAndPath = input.entries
    .map((entry) => `${entry.type}:${entry.relativePath}`)
    .sort(compareCodePoints);
  const sortedCandidatePathAndHash = input.entries
    .filter((entry): entry is Extract<InventoryEntry, { type: "file" }> & { sha256: string } =>
      entry.type === "file" && typeof entry.sha256 === "string" && isDeterministicCandidate(entry.relativePath))
    .map((entry) => `${entry.relativePath}:${entry.sha256}`)
    .sort(compareCodePoints);
  return sha256Hex(canonicalJson({
    kind: input.kind,
    sortedTypeAndPath,
    sortedCandidatePathAndHash,
    omittedCount: input.omittedCount,
    deterministicFacts: JSON.parse(JSON.stringify(input.deterministicFacts))
  }));
}

export function requiredRuntimeProbes(
  entries: InventoryEntry[]
): RuntimeProbe[] {
  const paths = new Set(entries.map((entry) => entry.relativePath.toLowerCase()));
  const extensions = new Set(entries.map((entry) => extensionOf(entry.relativePath.toLowerCase())));
  const probes: RuntimeProbe[] = [];
  if (paths.has("package.json") || extensions.has(".js") || extensions.has(".ts") || extensions.has(".tsx")) probes.push("node_version");
  if (paths.has("pyproject.toml") || extensions.has(".py")) probes.push("python_version");
  if (paths.has("go.mod") || extensions.has(".go")) probes.push("go_version");
  if (paths.has("cargo.toml") || extensions.has(".rs")) probes.push("rust_version");
  if (paths.has("pom.xml") || paths.has("build.gradle") || extensions.has(".java") || extensions.has(".kt")) probes.push("java_version");
  return probes;
}

export function deterministicReadCandidates(
  entries: InventoryEntry[]
): Array<{ relativePath: string; sha256: string; maxBytes: number }> {
  const maxBytes = PROJECT_ENVIRONMENT_SCAN_POLICY.maxTextBytes;
  return entries
    .filter((entry): entry is Extract<InventoryEntry, { type: "file" }> & { sha256: string } =>
      entry.type === "file" && typeof entry.sha256 === "string" && isDeterministicCandidate(entry.relativePath))
    .sort((left, right) => compareCodePoints(left.relativePath, right.relativePath))
    .map((entry) => ({ relativePath: entry.relativePath, sha256: entry.sha256, maxBytes }));
}

export function extensionOf(relativePath: string): string {
  const basename = relativePath.split("/").at(-1) ?? relativePath;
  const index = basename.lastIndexOf(".");
  return index <= 0 ? "" : basename.slice(index).toLowerCase();
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
