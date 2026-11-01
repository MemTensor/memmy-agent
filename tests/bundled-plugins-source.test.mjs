import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "internal", "shared", "prepare-plugin-migration-state.mjs");
const roots = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function temporaryDirectory() {
  const root = mkdtempSync(join(tmpdir(), "plugin-migration-"));
  roots.push(root);
  return root;
}

function prepare(output, sourceDirectory = "") {
  return spawnSync(process.execPath, [script, output], {
    encoding: "utf8",
    env: { ...process.env, MEMMY_BUNDLED_PLUGIN_SOURCE_DIR: sourceDirectory }
  });
}

function expectMigrationOnly(output) {
  expect(readdirSync(output)).toEqual(["bundled-plugins-state.json"]);
  expect(JSON.parse(readFileSync(join(output, "bundled-plugins-state.json"), "utf8")))
    .toEqual({ schemaVersion: 1, managedPluginIds: ["literature-review"] });
}

describe("marketplace-only plugin preparation", () => {
  it("prepares legacy migration IDs without requiring release inputs or an omission flag", () => {
    const output = join(temporaryDirectory(), "bundled-plugins");
    const result = prepare(output);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(output);
    expectMigrationOnly(output);
  });

  it("removes stale artifacts left by an earlier bundled build", () => {
    const output = join(temporaryDirectory(), "bundled-plugins");
    mkdirSync(output);
    for (const name of ["old.zip", "old.release.json", "old.skill.json"]) {
      writeFileSync(join(output, name), "stale release");
    }
    expect(prepare(output).status).toBe(0);
    expectMigrationOnly(output);
  });

  it("never copies releases from a retired source environment setting", () => {
    const source = temporaryDirectory();
    writeFileSync(join(source, "literature-review-0.5.40.release.json"), "old release");
    writeFileSync(join(source, "literature-review-0.5.40.zip"), "old archive");
    const output = join(temporaryDirectory(), "bundled-plugins");
    expect(prepare(output, source).status).toBe(0);
    expectMigrationOnly(output);
    expect(prepare(output, join(source, "missing")).status).toBe(0);
    expectMigrationOnly(output);
  });
});
