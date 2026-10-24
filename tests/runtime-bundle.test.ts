import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { bundleRuntime } from "../scripts/internal/shared/bundle-runtime.mjs";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime bundle #"));
  roots.push(root);
  const source = path.join(root, "source");
  const put = async (file: string, contents: string) => {
    const target = path.join(source, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  };
  return { root, source, put, destination: path.join(root, "output") };
}

it("runs relocated Memory entries without staging, retaining resources and exact external dependency versions", async () => {
  const { root, source, destination, put } = await fixture();
  await put("package/package.json", JSON.stringify({ type: "module" }));
  await put("package/dist/src/server/index.js", `import { readFileSync } from 'node:fs';
    import value from 'demo'; import sqlite from 'better-sqlite3';
    console.log(JSON.stringify([value, sqlite, readFileSync(new URL('./message%20%231.txt', import.meta.url), 'utf8')]));`);
  await put("package/dist/src/server/message #1.txt", "asset");
  await put("package/dist/src/cli/index.js", `import value from 'demo'; console.log(value);`);
  await put("package/node_modules/demo/package.json", JSON.stringify({ name: "demo", main: "index.cjs" }));
  await put("package/node_modules/demo/index.cjs", `module.exports = require('glob');`);
  await put("package/node_modules/demo/node_modules/glob/package.json", JSON.stringify({ name: "glob", main: "index.cjs" }));
  await put("package/node_modules/demo/node_modules/glob/index.cjs", `module.exports = 'nested-version';`);
  await put("package/node_modules/glob/package.json", JSON.stringify({ name: "glob", main: "index.cjs" }));
  await put("package/node_modules/glob/index.cjs", `module.exports = 'wrong-version';`);
  await put("package/node_modules/better-sqlite3/package.json", JSON.stringify({ name: "better-sqlite3", main: "lib/index.cjs", dependencies: { helper: "1" } }));
  await put("package/node_modules/better-sqlite3/lib/index.cjs", `module.exports = require('helper');`);
  await put("package/node_modules/helper/package.json", JSON.stringify({ name: "helper", main: "index.cjs" }));
  await put("package/node_modules/helper/index.cjs", `module.exports = 'external-dependency';`);
  await put("package/node_modules/better-sqlite3/build/Release/better_sqlite3.node", "native-fixture");
  await put("package/node_modules/unused/index.js", "unused");
  await put("package/src/server.ts", "source-only");
  await put("package/dist/src/server/index.js.map", "{}");
  await bundleRuntime({ source, destination, packageDirectory: "package", kind: "memory" });
  const relocated = path.join(root, "relocated # runtime");
  await rename(destination, relocated);
  await rm(source, { recursive: true });
  const run = (entry: string) => execFileSync(process.execPath, [path.join(relocated, "package/dist/src", entry)], { encoding: "utf8" }).trim();
  expect(JSON.parse(run("server/index.js"))).toEqual(["nested-version", "external-dependency", "asset"]);
  expect(run("cli/index.js")).toBe("nested-version");
  await expect(readFile(path.join(relocated, "package/node_modules/better-sqlite3/build/Release/better_sqlite3.node"), "utf8")).resolves.toBe("native-fixture");
  for (const file of ["src/server.ts", "node_modules/unused/index.js", "node_modules/demo/index.cjs", "dist/src/server/index.js.map"]) {
    await expect(readFile(path.join(relocated, "package", file))).rejects.toThrow();
  }
});

it("packages the Agent serve entry and its dynamic tools without the standalone gateway", async () => {
  const { source, destination, put } = await fixture();
  const pkg = "node_modules/@memtensor/memmy-agent";
  await put(`${pkg}/package.json`, JSON.stringify({ type: "module", bin: { memmy: "dist/main.js" } }));
  await put(`${pkg}/dist/runtime-main.js`, await readFile(new URL("../App/memmy-agent/src/runtime-main.ts", import.meta.url), "utf8"));
  await put(`${pkg}/dist/main.js`, `throw new Error('standalone CLI must not run');`);
  await put(`${pkg}/dist/load-env.js`, "export {};");
  await put(`${pkg}/dist/config/loader.js`, "export class ConfigError extends Error {}");
  await put(`${pkg}/dist/version.js`, `export const VERSION = '1.2.1';`);
  await put(`${pkg}/dist/entrypoints/cli/startup-migrations.js`, `export async function prepareStartupMigrations() { globalThis.migrationsReady = true; }`);
  await put(`${pkg}/dist/entrypoints/cli/commands.js`, `export async function serve(options) { if (!globalThis.migrationsReady) throw new Error('Migrations skipped'); console.log(JSON.stringify(options)); }
    export async function runInternalCommand(argv) { if (argv[2] === 'internal') { console.log('browser-prepare'); return true; } return false; }
    export async function gateway() { return import('unused-gateway'); }`);
  await put(`${pkg}/node_modules/unused-gateway/package.json`, JSON.stringify({ main: "index.js" }));
  await put(`${pkg}/node_modules/unused-gateway/index.js`, `throw new Error('unused gateway');`);
  for (const name of ["isomorphic-git", "@playwright/mcp", "open-computer-use"]) {
    await put(`${pkg}/node_modules/${name}/package.json`, JSON.stringify({ name, main: "index.js" }));
    await put(`${pkg}/node_modules/${name}/index.js`, `module.exports = ${JSON.stringify(name)};`);
  }
  await bundleRuntime({ source, destination, packageDirectory: pkg, kind: "agent" });
  await rm(source, { recursive: true });
  const output = execFileSync(process.execPath, [path.join(destination, pkg, "dist/main.js"), "serve", "--config", "config.json", "-t", "30"], { encoding: "utf8" });
  expect(JSON.parse(output)).toEqual({ config: "config.json", timeout: "30" });
  expect(execFileSync(process.execPath, [path.join(destination, pkg, "dist/main.js"), "internal", "browser-prepare"], { encoding: "utf8" }).trim()).toBe("browser-prepare");
  expect(execFileSync(process.execPath, [path.join(destination, pkg, "dist/main.js"), "--version"], { encoding: "utf8" }).trim()).toBe("1.2.1");
  await expect(readFile(path.join(destination, pkg, "node_modules/@playwright/mcp/index.js"), "utf8")).resolves.toContain("@playwright/mcp");
  await expect(readFile(path.join(destination, pkg, "node_modules/unused-gateway/index.js"))).rejects.toThrow();
});

it("fails packaging when an external package's required dependency is missing", async () => {
  const { source, destination, put } = await fixture();
  await put("package/package.json", JSON.stringify({ type: "module" }));
  await put("package/dist/src/server/index.js", `import sqlite from 'better-sqlite3'; console.log(sqlite);`);
  await put("package/node_modules/better-sqlite3/package.json", JSON.stringify({ main: "lib/index.js", dependencies: { missing: "1" } }));
  await put("package/node_modules/better-sqlite3/lib/index.js", `module.exports = require('missing');`);
  await expect(bundleRuntime({ source, destination, packageDirectory: "package", kind: "memory" })).rejects.toThrow("Missing runtime dependency missing");
});

it("keeps native runtime assets for Windows while excluding build material", async () => {
  const { includeRuntimePath } = await import("../scripts/internal/shared/runtime-payload.mjs");
  const target = { platform: "windows", arch: "x64" };
  for (const file of [
    "node_modules/yaml/dist/doc/Document.js",
    "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    "node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime.dll",
    "node_modules/tiktoken/tiktoken_bg.wasm",
    "dist/skills/computer-history/SKILL.md"
  ]) expect(includeRuntimePath(file, target), file).toBe(true);
  for (const file of [
    "node_modules/better-sqlite3/build/Release/obj/better_sqlite3.o",
    "node_modules/onnxruntime-node/bin/napi-v3/darwin/arm64/onnxruntime_binding.node",
    "node_modules/sqlite-vec-windows-arm64/vec0.dll",
    "node_modules/demo/tests/test.js",
    "dist/main.js.map", "dist/main.d.ts", "package-lock.json"
  ]) expect(includeRuntimePath(file, target), file).toBe(false);
});


it("invokes Windows npm with Node and preserves paths containing spaces", async () => {
  const { root } = await fixture();
  const { npmInvocation } = await import("../scripts/internal/shared/npm-invocation.mjs");
  const executable = path.join(root, "Program Files", "node.exe");
  const cli = path.join(root, "Program Files", "node_modules/npm/bin/npm-cli.js");
  await mkdir(path.dirname(cli), { recursive: true });
  await writeFile(cli, "");
  const args = ["pack", "C:\\Users\\Name With Spaces\\package"];
  expect(npmInvocation(args, { execPath: executable, env: {}, platform: "win32" })).toEqual({ command: executable, args: [cli, ...args] });
});
