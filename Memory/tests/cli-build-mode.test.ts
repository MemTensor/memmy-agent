import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const manifestPath = resolve(import.meta.dirname, "../package.json");
const scriptPath = resolve(import.meta.dirname, "../src/cli/scripts/set-executable.mjs");

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Memory CLI build mode", () => {
  it("runs the executable-mode step after every build", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(manifest.scripts?.postbuild).toBe(
      "node src/cli/scripts/set-executable.mjs dist/src/cli/index.js"
    );
  });

  it.skipIf(process.platform === "win32")("marks a newly generated CLI executable", () => {
    const root = mkdtempSync(resolve(tmpdir(), "memmy-cli-build-mode-"));
    roots.push(root);
    const target = resolve(root, "index.js");
    writeFileSync(target, "#!/usr/bin/env node\n", { mode: 0o644 });

    const result = spawnSync(process.execPath, [scriptPath, target], {
      encoding: "utf8"
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(statSync(target).mode & 0o111).toBe(0o111);
  });
});
