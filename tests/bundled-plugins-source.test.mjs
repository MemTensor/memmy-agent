import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
    env: {
      ...process.env,
      MEMMY_BUNDLED_PLUGIN_SOURCE_DIR: sourceDirectory ?? ""
    }
  });
}

function outputDirectory() {
  const root = mkdtempSync(join(tmpdir(), "bundled-plugins-"));
  roots.push(root);
  return join(root, "bundled-plugins");
}

describe("bundled plugin preparation", () => {
  it("prepares state metadata without release artifacts for an optional build", () => {
    const output = outputDirectory();
    const result = prepare({ args: [output, "--optional"] });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("optional build is continuing");
    expect(readdirSync(output)).toEqual(["bundled-plugins-state.json"]);
    expect(JSON.parse(readFileSync(join(output, "bundled-plugins-state.json"), "utf8")))
      .toEqual({
        schemaVersion: 1,
        managedPluginIds: ["literature-review"]
      });
  });

  it("fails a build with no source unless omission is explicit", () => {
    const result = prepare({ args: [outputDirectory()] });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("pass --optional");
  });

  it("still fails an optional run whose configured source directory is incomplete", () => {
    const source = mkdtempSync(join(tmpdir(), "bundled-plugins-source-"));
    roots.push(source);
    const result = prepare({ args: [outputDirectory(), "--optional"], sourceDirectory: source });
    expect(result.status).not.toBe(0);
  });
});
