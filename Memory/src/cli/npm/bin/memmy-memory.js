#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const binDirectory = dirname(fileURLToPath(import.meta.url));
const binaryPath = resolveBinaryPath();

if (!existsSync(binaryPath)) {
  console.error("memmy-memory binary is not installed.");
  console.error("Please reinstall the package or run npm install without MEMMY_MEMORY_INSTALL_SKIP_DOWNLOAD.");
  process.exit(1);
}

const child = spawn(binaryPath, process.argv.slice(2), {
  stdio: "inherit",
  windowsHide: false,
  shell: process.platform === "win32" && binaryPath.toLowerCase().endsWith(".cmd")
});

child.on("error", (error) => {
  console.error(`failed to start memmy-memory binary: ${error.message}`);
  process.exit(1);
});

child.on("close", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

function resolveBinaryPath() {
  const names = process.platform === "win32"
    ? ["memmy-memory.exe", "memmy-memory.cmd"]
    : ["memmy-memory"];
  for (const name of names) {
    const candidate = join(binDirectory, name);
    if (existsSync(candidate)) return candidate;
  }
  return join(binDirectory, names[0]);
}
