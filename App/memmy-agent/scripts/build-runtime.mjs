#!/usr/bin/env node
import { npmInvocation } from "../../../scripts/internal/shared/npm-invocation.mjs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { bundleRuntime } from "../../../scripts/internal/shared/bundle-runtime.mjs";

if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Agent runtime requires Node 22 or newer.");

const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: {
  target: { type: "string" }, output: { type: "string" }, "skip-build": { type: "boolean" }
} });
const hostTarget = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const target = values.target ?? hostTarget;
// Native modules must be installed on the release runner for the target OS/architecture.
if (!/^(darwin|linux|windows)-(arm64|x64)$/.test(target) || target !== hostTarget) {
  throw new Error(`Build ${target} on a matching runner (current: ${hostTarget}).`);
}
const outputRoot = resolve(values.output ?? join(agentRoot, "dist", "releases"));
const temporaryRoot = await mkdtemp(join(tmpdir(), "memmy-agent-runtime-"));
try {
  if (!values["skip-build"]) run("npm", ["run", "build"], agentRoot);
  run(process.execPath, [join(agentRoot, "scripts", "build-npm-package.mjs")], agentRoot);
  const source = join(temporaryRoot, "staged");
  const packageRoot = join(source, "package");
  await mkdir(source, { recursive: true });
  await cp(join(agentRoot, "npm-packages", "memmy-agent"), packageRoot, { recursive: true });
  // Third-party lifecycle scripts are not needed to ship the runtime and some are POSIX-only
  // (e.g. @tencent-connect/openclaw-qqbot runs `... 2>/dev/null || true`, which fails under
  // Windows cmd.exe unless a `true` binary happens to be on PATH). Install without scripts,
  // then run only the install script of the native module the runtime actually loads.
  run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], packageRoot);
  run("npm", ["rebuild", "better-sqlite3", "--no-audit", "--no-fund"], packageRoot);
  const destination = join(temporaryRoot, "bundled");
  await bundleRuntime({ source, destination, packageDirectory: "package", kind: "agent", target: { platform: process.platform, arch: process.arch } });
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  await writeJson(join(destination, "package", "agent-runtime.json"), {
    name: "memmy-agent-runtime", version: manifest.version, formatVersion: 1, target,
    entrypoint: "dist/main.js", nodeAbi: process.versions.modules
  });
  await mkdir(outputRoot, { recursive: true });
  const name = `memmy-agent-runtime-${manifest.version}-${target}.tgz`;
  const archive = join(outputRoot, name);
  run("tar", ["-czf", archive, "-C", destination, "package"], agentRoot);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  await writeJson(join(outputRoot, `agent-release-${target}.json`), {
    version: manifest.version, assets: { [target]: { name, sha256: hash.digest("hex"), size: (await stat(archive)).size } }
  });
  console.log(archive);
} finally {
  // Windows may briefly lock freshly installed files (antivirus/indexer), so retry on EBUSY/EPERM.
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

function run(command, args, cwd) {
  if (command === "npm") ({ command, args } = npmInvocation(args));
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, PATH: `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
