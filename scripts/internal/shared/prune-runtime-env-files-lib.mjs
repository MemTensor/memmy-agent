import { lstat, opendir, unlink } from "node:fs/promises";
import { resolve } from "node:path";

export async function pruneRuntimeEnvFiles(runtimeRoot) {
  const root = resolve(runtimeRoot);
  const matches = await findEnvFiles(root);
  for (const path of matches) await unlink(path);
  const remaining = await findEnvFiles(root);
  if (remaining.length) throw new Error("Runtime .env files remain after pruning");
  return matches.length;
}

async function findEnvFiles(root) {
  const matches = [];
  await walk(root, matches);
  return matches;
}

async function walk(directory, matches) {
  const handle = await opendir(directory);
  for await (const entry of handle) {
    const path = resolve(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      if (isEnvName(entry.name)) matches.push(path);
      continue;
    }
    if (stat.isDirectory()) {
      await walk(path, matches);
    } else if (stat.isFile() && isEnvName(entry.name)) {
      matches.push(path);
    }
  }
}

function isEnvName(name) {
  return name === ".env" || name.startsWith(".env.");
}
