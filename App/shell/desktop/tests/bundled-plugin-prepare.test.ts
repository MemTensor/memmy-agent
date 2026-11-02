import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const scriptPath = join(repositoryRoot, "scripts/internal/shared/prepare-plugin-migration-state.mjs");
let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("desktop plugin marketplace preparation", () => {
  it("prepares legacy migration metadata after the bundled release lock is removed", () => {
    root = mkdtempSync(join(tmpdir(), "memmy-plugin-migration-"));
    const output = join(root, "bundled");
    const result = spawnSync(process.execPath, [scriptPath, output], {
      env: { ...process.env, MEMMY_BUNDLED_PLUGIN_SOURCE_DIR: "" },
      encoding: "utf8"
    });
    expect(result.status).toBe(0);
    expect(existsSync(join(repositoryRoot, "App/shell/desktop/resources/bundled-plugins.json"))).toBe(false);
    expect(readdirSync(output)).toEqual(["bundled-plugins-state.json"]);
    expect(JSON.parse(readFileSync(join(output, "bundled-plugins-state.json"), "utf8")))
      .toEqual({ schemaVersion: 1, managedPluginIds: ["literature-review"] });
  });

  it("uses migration-only preparation for macOS, Windows, and desktop development", () => {
    for (const script of ["scripts/internal/mac/build-dmg.sh", "scripts/internal/win/build-nsis.sh"]) {
      const source = readFileSync(join(repositoryRoot, script), "utf8");
      expect(source).toContain('"$ROOT_DIR/scripts/internal/shared/prepare-plugin-migration-state.mjs"');
      expect(source).not.toContain("prepare-bundled-plugins.mjs");
      expect(source).not.toContain('"$DESKTOP_DIR/dist/bundled-plugins" --optional');
    }
    const desktop = JSON.parse(readFileSync(join(repositoryRoot, "App/shell/desktop/package.json"), "utf8"));
    expect(desktop.scripts.dev).toContain("npm run prepare:plugin-migration-state");
    expect(desktop.scripts["prepare:bundled-plugins"]).toBeUndefined();
  });
});
