import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("publishes the identity embedded in each runtime archive", () => {
  const root = mkdtempSync(join(tmpdir(), "memmy-runtime-release-"));
  roots.push(root);
  const input = join(root, "input");
  const output = join(root, "output");
  mkdirSync(input);
  const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-arm64", "windows-x64"];
  for (const [index, target] of targets.entries()) {
    const stage = join(root, target);
    mkdirSync(stage);
    writeFileSync(join(stage, "memory-runtime.json"), JSON.stringify({
      version: "2.1.3", protocolVersion: 1, target, buildId: String(index).repeat(64), schemaVersion: 9
    }));
    const packed = spawnSync("tar", ["-czf", join(input, `memmy-memory-runtime-2.1.3-${target}.tar.gz`), "-C", stage, "."], { encoding: "utf8" });
    expect(packed.status, packed.stderr).toBe(0);
  }
  const assemble = fileURLToPath(new URL("../src/cli/scripts/assemble-release.mjs", import.meta.url));
  const assembled = spawnSync(process.execPath, [assemble, input, output, "2.1.3"], { encoding: "utf8" });
  expect(assembled.status, assembled.stderr).toBe(0);
  const manifest = JSON.parse(readFileSync(join(output, "memory-release.json"), "utf8"));
  for (const [index, target] of targets.entries()) {
    expect(manifest.assets[target]).toMatchObject({ buildId: String(index).repeat(64), schemaVersion: 9 });
  }
});
