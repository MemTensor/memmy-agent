import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(
  new URL("../../../../scripts/internal/shared/prepare-bundled-plugins.mjs", import.meta.url)
);
const macPackagePath = fileURLToPath(new URL("../../../../scripts/internal/mac/build-dmg.sh", import.meta.url));
const windowsPackagePath = fileURLToPath(new URL("../../../../scripts/internal/win/build-nsis.sh", import.meta.url));
let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("prepare bundled plugins", () => {
  it("allows a standalone development launch without a plugin source", () => {
    root = mkdtempSync(join(tmpdir(), "memmy-bundled-optional-"));
    const output = join(root, "bundled");
    const env = { ...process.env };
    delete env.MEMMY_BUNDLED_PLUGIN_SOURCE_DIR;
    delete env.MEMMY_REQUIRE_BUNDLED_PLUGINS;

    const result = spawnSync(process.execPath, [scriptPath, output], {
      env,
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(output);
    expect(result.stderr).toContain("continuing with no bundled plugins");
    expect(readdirSync(output)).toEqual(["bundled-plugins-state.json"]);
    expect(JSON.parse(readFileSync(join(output, "bundled-plugins-state.json"), "utf8")))
      .toEqual({
        schemaVersion: 1,
        managedPluginIds: ["literature-review"]
      });
  });

  it("honors the explicit plugin-free policy during official packaging", () => {
    root = mkdtempSync(join(tmpdir(), "memmy-bundled-required-"));
    const output = join(root, "bundled");
    const env = { ...process.env, MEMMY_REQUIRE_BUNDLED_PLUGINS: "1" };
    delete env.MEMMY_BUNDLED_PLUGIN_SOURCE_DIR;

    const result = spawnSync(process.execPath, [scriptPath, output], {
      env,
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(readdirSync(output)).toEqual(["bundled-plugins-state.json"]);

    const unexpectedSource = spawnSync(process.execPath, [scriptPath, join(root, "unexpected-source")], {
      env: { ...env, MEMMY_BUNDLED_PLUGIN_SOURCE_DIR: root },
      encoding: "utf8"
    });
    expect(unexpectedSource.status).not.toBe(0);
    expect(unexpectedSource.stderr).toContain(
      "must not be set for a package whose bundled plugin policy is omit"
    );
    expect(readFileSync(macPackagePath, "utf8")).toContain(
      "MEMMY_REQUIRE_BUNDLED_PLUGINS=1 node"
    );
    expect(readFileSync(windowsPackagePath, "utf8")).toContain(
      "MEMMY_REQUIRE_BUNDLED_PLUGINS=1 node"
    );
  });
});
