import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workflow = "runtime-artifacts.yml";
const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-arm64", "windows-x64"];

function command(executable, args, live = false) {
  const result = spawnSync(executable, args, { cwd: repoRoot, encoding: "utf8", stdio: live ? "inherit" : "pipe" });
  if (result.status !== 0) throw new Error(`${executable} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr ?? "see output above"}`);
  return result.stdout?.trim() ?? "";
}

export async function buildMemoryAll({ run = command, wait = delay } = {}) {
  if (run("git", ["status", "--porcelain"])) throw new Error("Commit your local changes before building all platforms.");
  const sha = run("git", ["rev-parse", "HEAD"]);
  const remote = run("git", ["remote", "get-url", "origin"]);
  const repository = run("gh", ["repo", "view", remote, "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const branch = `zy_memory_runtime_${randomUUID()}`;
  console.log(`Uploading committed source ${sha} to ${repository} (${branch})`);
  run("git", ["push", "origin", `${sha}:refs/heads/${branch}`], true);
  let build;
  for (let attempt = 0; attempt < 24; attempt++) {
    const runs = JSON.parse(run("gh", ["run", "list", "--repo", repository, "--workflow", workflow, "--branch", branch, "--event", "push", "--limit", "50", "--json", "databaseId,displayTitle,headSha,url"]));
    build = runs.find((entry) => entry.headSha === sha);
    if (build) break;
    await wait(5000);
  }
  if (!build) throw new Error(`Build was pushed but was not found yet. Check Actions in ${repository}, branch ${branch}.`);
  console.log(`Building six Memory runtimes: ${build.url}`);
  run("gh", ["run", "watch", String(build.databaseId), "--repo", repository, "--exit-status", "--interval", "15"], true);
  const output = join(repoRoot, "Memory/dist/releases", `all-${build.databaseId}`);
  await mkdir(output, { recursive: true });
  run("gh", ["run", "download", String(build.databaseId), "--repo", repository, "--name", "all-platform-runtimes", "--dir", output], true);
  await verifyMemoryDownload(output, sha);
  try { run("git", ["push", "origin", "--delete", branch], true); }
  catch (error) { console.warn(`Artifacts are complete; temporary branch cleanup failed: ${error.message}`); }
  console.log(`Six Memory runtime archives verified: ${output}`);
  return output;
}

export async function verifyMemoryDownload(output, sha) {
  const manifest = JSON.parse(await readFile(join(output, "runtime-artifacts.json"), "utf8"));
  const memory = manifest.runtimes?.memory;
  if (manifest.sourceCommit !== sha || Object.keys(manifest.runtimes ?? {}).join() !== "memory" ||
      Object.keys(memory?.assets ?? {}).sort().join() !== [...targets].sort().join()) {
    throw new Error("Downloaded manifest does not match the requested commit and six Memory targets.");
  }
  for (const target of targets) {
    const asset = memory.assets[target];
    if (asset.name !== `memmy-memory-runtime-${memory.version}-${target}.tar.gz` || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(memory.version)) {
      throw new Error(`Invalid Memory artifact name: ${target}`);
    }
    const file = join(output, asset.name);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest("hex") !== asset.sha256 || (await stat(file)).size !== asset.size) throw new Error(`Checksum or size mismatch: ${asset.name}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await buildMemoryAll(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
