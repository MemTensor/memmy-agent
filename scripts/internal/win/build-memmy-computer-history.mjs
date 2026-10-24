#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWindowsComputerHistoryRuntime } from "./verify-computer-history-runtime.mjs";

// Node keeps this build entry portable for npm build on Windows without Git Bash.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const [destination, requestedArch = process.arch] = process.argv.slice(2);
if (!destination) throw new Error("Usage: build-memmy-computer-history.mjs <helper.exe> [amd64|x64|arm64]");
const arch = requestedArch === "x64" ? "amd64" : requestedArch;
if (!["amd64", "arm64"].includes(arch)) throw new Error(`Unsupported Windows History architecture: ${requestedArch}`);
const output = resolve(destination);
const project = resolve(root, "App/native-computer-history/apps/OpenComputerHistoryWindows");
const worker = readFileSync(resolve(project, "worker.ps1"));
const version = JSON.parse(readFileSync(resolve(root, "App/shell/desktop/package.json"), "utf8")).version;
mkdirSync(dirname(output), { recursive: true });
const temporary = `${output}.building-${process.pid}`;
const env = { ...process.env, GOTOOLCHAIN: process.env.MEMMY_WINDOWS_GO_TOOLCHAIN || "go1.22.12", GOOS: "windows", GOARCH: arch, CGO_ENABLED: "0" };
try {
  const build = spawnSync("go", ["build", "-trimpath", "-ldflags", `-s -w -X main.version=${version}`, "-o", temporary, "."], { cwd: project, env, stdio: "inherit" });
  if (build.error) throw new Error(`Building Windows History requires Go 1.22 or newer: ${build.error.message}`);
  if (build.status !== 0) throw new Error(`Windows History build failed (exit ${build.status})`);
  const bytes = readFileSync(temporary);
  const sha256 = verifyWindowsComputerHistoryRuntime(bytes, arch === "amd64" ? "x64" : arch, worker);
  renameSync(temporary, output);
  writeFileSync(`${output}.build.json`, `${JSON.stringify({ platform: "win32", arch, version, sha256, workerSha256: createHash("sha256").update(worker).digest("hex") }, null, 2)}\n`);
  console.log(`Built Windows ${arch} History recorder sha256=${sha256}`);
} finally {
  rmSync(temporary, { force: true });
}
