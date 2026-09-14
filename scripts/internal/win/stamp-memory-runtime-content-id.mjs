#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const [runtimeDirectoryArgument] = process.argv.slice(2);
if (!runtimeDirectoryArgument) {
  throw new Error("Usage: stamp-memory-runtime-content-id.mjs <runtime-directory>");
}

const runtimeDirectory = resolve(runtimeDirectoryArgument);
const metadataPath = join(runtimeDirectory, "memory-runtime.json");
const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
  throw new Error("Memory runtime metadata must be a JSON object");
}

const contentId = await hashRuntimeContent(runtimeDirectory);
const temporaryPath = `${metadataPath}.${process.pid}.tmp`;
try {
  await writeFile(
    temporaryPath,
    `${JSON.stringify({ ...metadata, contentId }, null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryPath, metadataPath);
} finally {
  await rm(temporaryPath, { force: true });
}
process.stdout.write(`${contentId}\n`);

async function hashRuntimeContent(root) {
  const files = await collectFiles(root);
  const hash = createHash("sha256");
  hash.update("memmy-memory-runtime-content-v1\0");
  for (const path of files) {
    const relativePath = relative(root, path).split(sep).join("/");
    const details = await stat(path);
    hash.update(`file\0${relativePath}\0${details.size}\0`);
    const input = createReadStream(path);
    for await (const chunk of input) hash.update(chunk);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function collectFiles(root, directory = root) {
  const paths = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Memory runtime content identity does not accept symbolic links: ${path}`);
    }
    if (entry.isDirectory()) {
      paths.push(...await collectFiles(root, path));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Memory runtime content identity found an unsupported entry: ${path}`);
    }
    if (directory === root && entry.name === "memory-runtime.json") continue;
    paths.push(path);
  }
  return paths;
}
