import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

// Include runtime code, assets and dependency resolution. A source change must
// change identity even when a release forgets to increment Memory's version.
export async function memoryRuntimeBuildIdentity(repoRoot) {
  const inputs = [
    "Memory/src", "Memory/viewer/src", "Memory/viewer/public", "Memory/adapters", "AgentSourceCore/src",
    "Memory/package.json", "Memory/tsconfig.json", "Memory/tsconfig.base.json",
    "Memory/viewer/package.json", "Memory/viewer/vite.config.ts", "Memory/viewer/index.html",
    "AgentSourceCore/package.json", "AgentSourceCore/tsconfig.json", "tsconfig.base.json", "package-lock.json"
  ];
  const hash = createHash("sha256");
  async function addFile(path) {
    const content = await readFile(join(repoRoot, path));
    // Git checkouts on Windows may use CRLF. Normalize text, preserve binaries.
    const normalized = /\.(?:[cm]?[jt]sx?|json|mdx?|css|html|ya?ml|sh|ps1|toml|txt)$/.test(path)
      ? Buffer.from(content.toString("utf8").replace(/\r\n/g, "\n")) : content;
    hash.update(`${path}\0${normalized.length}\0`);
    hash.update(normalized);
  }
  async function addDirectory(path) {
    const entries = await readdir(join(repoRoot, path), { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.name.startsWith(".") || ["node_modules", "dist"].includes(entry.name)) continue;
      const child = `${path}/${entry.name}`;
      // This ignored bridge is generated from sources in the same directory.
      if (child === "Memory/src/agent-source/integration/workspace-bridge/memmy-workspace-bridge.mjs") continue;
      if (entry.isDirectory()) await addDirectory(child);
      else if (entry.isFile()) await addFile(child);
    }
  }
  for (const input of inputs) {
    if (input.endsWith("/src") || input.endsWith("/public") || input === "Memory/adapters") await addDirectory(input);
    else await addFile(input);
  }
  const schema = await readFile(join(repoRoot, "Memory/src/storage/schema.ts"), "utf8");
  const schemaVersion = Number(/export const SCHEMA_VERSION = (\d+);/.exec(schema)?.[1]);
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw new Error("Memory schema version is missing");
  return { buildId: hash.digest("hex"), schemaVersion };
}
