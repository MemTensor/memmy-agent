import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "..");
const collector = join(root, "scripts/internal/shared/collect-runtime-artifacts.mjs");
const workflow = YAML.parse(await readFile(join(root, ".github/workflows/runtime-artifacts.yml"), "utf8"));
const roots = [];
afterEach(async () => { for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true }); });

it("collects all target artifacts and rejects corrupted downloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-artifact-test-"));
  roots.push(directory);
  const targets = workflow.jobs.build.strategy.matrix.include.map((entry) => entry.target);
  expect(new Set(targets)).toEqual(new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-arm64", "windows-x64"]));
  let corrupted;
  for (const target of targets) {
    const input = join(directory, "input", `runtimes-${target}`);
    await mkdir(input, { recursive: true });
    for (const kind of ["agent", "memory"]) {
      const manifestPath = kind === "agent" ? "App/memmy-agent/package.json" : "Memory/package.json";
      const version = JSON.parse(await readFile(join(root, manifestPath))).version;
      const name = `memmy-${kind}-runtime-${version}-${target}.${kind === "agent" ? "tgz" : "tar.gz"}`;
      const bytes = Buffer.from(`${kind}:${target}`);
      corrupted = join(input, name);
      await writeFile(corrupted, bytes);
      const metadata = { version, assets: { [target]: { name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } } };
      await writeFile(join(input, kind === "agent" ? `agent-release-${target}.json` : "memory-release.json"), JSON.stringify(metadata));
    }
  }
  const args = [collector, join(directory, "input"), join(directory, "output")];
  execFileSync(process.execPath, args);
  expect((await readdir(join(directory, "output"))).length).toBe(14);
  const manifest = JSON.parse(await readFile(join(directory, "output/runtime-artifacts.json")));
  expect(Object.keys(manifest.runtimes.agent.assets)).toHaveLength(6);
  expect(Object.keys(manifest.runtimes.memory.assets)).toHaveLength(6);
  await writeFile(corrupted, "corrupted");
  expect(() => execFileSync(process.execPath, args, { stdio: "pipe" })).toThrow();
});
