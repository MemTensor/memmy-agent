import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("packaged Memory build identity", () => {
  it.each([true, false])("reads the installed build identity with a manifest present=%s", (hasManifest) => {
    const root = mkdtempSync(join(tmpdir(), "memmy-runtime-build-"));
    roots.push(root);
    const modulePath = join(root, "dist/src/runtime-build.mjs");
    mkdirSync(join(root, "dist/src"), { recursive: true });
    const source = readFileSync(new URL("../src/runtime-build.ts", import.meta.url), "utf8");
    writeFileSync(modulePath, transpileModule(source, {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 }
    }).outputText);
    if (hasManifest) writeFileSync(join(root, "memory-runtime.json"), JSON.stringify({ buildId: "a".repeat(64) }));
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval",
      `const runtime = await import(${JSON.stringify(pathToFileURL(modulePath).href)}); process.stdout.write(runtime.MEMORY_RUNTIME_BUILD_ID ?? "development");`
    ], { encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe(hasManifest ? "a".repeat(64) : "development");
  });
});
