import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "internal", "shared", "prepare-bundled-plugins.mjs");
const roots = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

/**
 * Runs the preparation script with the source directory environment cleared or
 * set, as a packaging script or the desktop dev script would.
 */
function prepare({ args, sourceDirectory }) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, MEMMY_BUNDLED_PLUGIN_SOURCE_DIR: sourceDirectory ?? "" }
  });
}

function outputDirectory() {
  const root = mkdtempSync(join(tmpdir(), "bundled-plugins-"));
  roots.push(root);
  return join(root, "bundled-plugins");
}

describe("bundled plugin preparation", () => {
  it("fails a packaging run that has no source directory to copy from", () => {
    const result = prepare({ args: [outputDirectory()] });
    // An installer missing a locked plugin is a broken build, so this must stay
    // loud on the packaging path, which passes no flags.
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MEMMY_BUNDLED_PLUGIN_SOURCE_DIR");
  });

  it("skips an optional run instead of blocking startup, and leaves the output alone", () => {
    const output = outputDirectory();
    mkdirSync(output, { recursive: true });
    // A dev machine running from source may hold plugins here from elsewhere —
    // the Host reads this directory at startup, so a skip must not wipe it.
    writeFileSync(join(output, "in-place.release.json"), "{}", "utf8");

    const result = prepare({ args: [output, "--optional"] });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Skipping bundled plugins");
    expect(readdirSync(output)).toEqual(["in-place.release.json"]);
  });

  it("still fails an optional run whose configured source directory is incomplete", () => {
    const source = mkdtempSync(join(tmpdir(), "bundled-plugins-source-"));
    roots.push(source);
    // Naming a directory is a statement that the releases are there. Skipping
    // on a typo would ship a desktop build quietly missing its plugins.
    const result = prepare({ args: [outputDirectory(), "--optional"], sourceDirectory: source });
    expect(result.status).not.toBe(0);
  });
});
