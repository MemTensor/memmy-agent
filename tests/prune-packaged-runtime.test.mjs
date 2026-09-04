import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { prunePackagedRuntime } from "../scripts/internal/shared/prune-packaged-runtime-lib.mjs";

const roots = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("packaged runtime pruning", () => {
  it("keeps the Windows x64 runtime and Memmy source maps while pruning proven package waste", async () => {
    const runtimeRoot = createRuntimeFixture();

    const result = await prunePackagedRuntime({
      platform: "win32",
      arch: "x64",
      runtimeRoot,
    });

    expect(result.removedFiles).toBeGreaterThan(0);
    expect(result.removedBytes).toBeGreaterThan(0);
    expect(result.categories).toMatchObject({
      incompatibleOnnxRuntime: { removedFiles: 4 },
      thirdPartySourceMaps: { removedFiles: 3 },
      optionalPeerToolchain: { removedFiles: 8 },
    });

    expect(existsSync(runtimePath(runtimeRoot, "memory", "node_modules", "onnxruntime-node", "bin", "napi-v3", "win32", "x64", "onnxruntime_binding.node"))).toBe(true);
    expect(existsSync(runtimePath(runtimeRoot, "memory", "node_modules", "onnxruntime-node", "bin", "napi-v3", "darwin"))).toBe(false);
    expect(existsSync(runtimePath(runtimeRoot, "memory", "node_modules", "onnxruntime-node", "bin", "napi-v3", "linux"))).toBe(false);
    expect(existsSync(runtimePath(runtimeRoot, "memory", "node_modules", "onnxruntime-node", "bin", "napi-v3", "win32", "arm64"))).toBe(false);

    expect(existsSync(runtimePath(runtimeRoot, "memmy-agent", "dist", "main.js.map"))).toBe(true);
    expect(existsSync(runtimePath(runtimeRoot, "memmy-agent", "node_modules", "@memmy", "migrations", "dist", "index.js.map"))).toBe(true);
    expect(existsSync(runtimePath(runtimeRoot, "memmy-agent", "node_modules", "@memmy", "migrations", "node_modules", "third-party", "index.js.map"))).toBe(false);
    expect(existsSync(runtimePath(runtimeRoot, "memmy-agent", "node_modules", "third-party", "index.js.map"))).toBe(false);
    expect(existsSync(runtimePath(runtimeRoot, "memory", "node_modules", "third-party", "index.js.map"))).toBe(false);

    for (const packagePath of [
      ["vitest"],
      ["vite"],
      ["rolldown"],
      ["@vitest"],
      ["@rolldown", "binding-win32-x64-msvc"],
      ["@rolldown", "binding-linux-x64-gnu"],
    ]) {
      expect(existsSync(runtimePath(runtimeRoot, "memmy-agent", "node_modules", ...packagePath))).toBe(false);
    }
    expect(existsSync(runtimePath(runtimeRoot, "memmy-agent", "node_modules", "html-validate", "dist", "cjs", "index.js"))).toBe(true);
    expect(existsSync(runtimePath(runtimeRoot, "memory", "node_modules", "onnxruntime-web", "dist", "ort.wasm"))).toBe(true);
    expect(existsSync(runtimePath(runtimeRoot, "memmy-agent", "node_modules", "openclaw", "dist", "index.js"))).toBe(true);
    expect(existsSync(runtimePath(runtimeRoot, "memmy-agent", "node_modules", "typescript", "lib", "typescript.js"))).toBe(true);
  });

  it("fails before changing files when the required target onnxruntime is missing", async () => {
    const runtimeRoot = createRuntimeFixture({ includeRequiredOnnxRuntime: false });
    const incompatibleRuntime = runtimePath(runtimeRoot, "memory", "node_modules", "onnxruntime-node", "bin", "napi-v3", "linux", "x64", "libonnxruntime.so");

    await expect(prunePackagedRuntime({ platform: "win32", arch: "x64", runtimeRoot }))
      .rejects.toThrow(/required onnxruntime-node target directory/i);
    expect(existsSync(incompatibleRuntime)).toBe(true);
  });

  it("fails before changing files unless html-validate declares vitest as an optional peer", async () => {
    const runtimeRoot = createRuntimeFixture({ optionalVitestPeer: false });
    const thirdPartyMap = runtimePath(runtimeRoot, "memmy-agent", "node_modules", "third-party", "index.js.map");
    const vitestPath = runtimePath(runtimeRoot, "memmy-agent", "node_modules", "vitest");

    await expect(prunePackagedRuntime({ platform: "win32", arch: "x64", runtimeRoot }))
      .rejects.toThrow(/optional vitest peer/i);
    expect(existsSync(thirdPartyMap)).toBe(true);
    expect(existsSync(vitestPath)).toBe(true);
  });

  it("fails before changing files when another production dependency uses the optional-peer toolchain", async () => {
    const runtimeRoot = createRuntimeFixture({ otherProductionViteConsumer: true });
    const thirdPartyMap = runtimePath(runtimeRoot, "memmy-agent", "node_modules", "third-party", "index.js.map");
    const vitePath = runtimePath(runtimeRoot, "memmy-agent", "node_modules", "vite");

    await expect(prunePackagedRuntime({ platform: "win32", arch: "x64", runtimeRoot }))
      .rejects.toThrow(/production dependency path.*vite/i);
    expect(existsSync(thirdPartyMap)).toBe(true);
    expect(existsSync(vitePath)).toBe(true);
  });

  it("fails before changing files when another production dependency requires Vite as a peer", async () => {
    const runtimeRoot = createRuntimeFixture({ otherProductionVitePeerConsumer: true });
    const vitePath = runtimePath(runtimeRoot, "memmy-agent", "node_modules", "vite");

    await expect(prunePackagedRuntime({ platform: "win32", arch: "x64", runtimeRoot }))
      .rejects.toThrow(/production dependency path.*vite/i);
    expect(existsSync(vitePath)).toBe(true);
  });

  it("rejects a relative runtime root before changing files", async () => {
    await expect(prunePackagedRuntime({ platform: "win32", arch: "x64", runtimeRoot: "relative-runtime" }))
      .rejects.toThrow(/absolute path/i);
  });

  it("reports deleted files and bytes through the CLI", () => {
    const runtimeRoot = createRuntimeFixture();
    const cliPath = fileURLToPath(new URL("../scripts/internal/shared/prune-packaged-runtime.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [
      cliPath,
      "--platform", "win32",
      "--arch", "x64",
      "--runtime-root", runtimeRoot,
    ], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Pruned \d+ file\(s\), \d+ byte\(s\)/u);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1))).toMatchObject({
      platform: "win32",
      arch: "x64",
    });
  });
});

function createRuntimeFixture(options = {}) {
  const {
    includeRequiredOnnxRuntime = true,
    optionalVitestPeer = true,
    otherProductionViteConsumer = false,
    otherProductionVitePeerConsumer = false,
  } = options;
  const runtimeRoot = mkdtempSync(join(tmpdir(), "memmy-packaged-runtime-prune-"));
  roots.push(runtimeRoot);

  if (includeRequiredOnnxRuntime) {
    writeFixture(runtimePath(runtimeRoot, "memory", "node_modules", "onnxruntime-node", "bin", "napi-v3", "win32", "x64", "onnxruntime_binding.node"), "win-x64-node");
    writeFixture(runtimePath(runtimeRoot, "memory", "node_modules", "onnxruntime-node", "bin", "napi-v3", "win32", "x64", "onnxruntime.dll"), "win-x64-dll");
  }
  writeFixture(runtimePath(runtimeRoot, "memory", "node_modules", "onnxruntime-node", "bin", "napi-v3", "win32", "arm64", "onnxruntime_binding.node"), "win-arm64");
  writeFixture(runtimePath(runtimeRoot, "memory", "node_modules", "onnxruntime-node", "bin", "napi-v3", "darwin", "x64", "onnxruntime_binding.node"), "darwin-x64");
  writeFixture(runtimePath(runtimeRoot, "memory", "node_modules", "onnxruntime-node", "bin", "napi-v3", "darwin", "arm64", "onnxruntime_binding.node"), "darwin-arm64");
  writeFixture(runtimePath(runtimeRoot, "memory", "node_modules", "onnxruntime-node", "bin", "napi-v3", "linux", "x64", "libonnxruntime.so"), "linux-x64");

  writeFixture(runtimePath(runtimeRoot, "memmy-agent", "dist", "main.js.map"), "own-map");
  writeFixture(runtimePath(runtimeRoot, "memmy-agent", "node_modules", "@memmy", "migrations", "dist", "index.js.map"), "memmy-map");
  writeFixture(runtimePath(runtimeRoot, "memmy-agent", "node_modules", "@memmy", "migrations", "node_modules", "third-party", "index.js.map"), "nested-third-party-map");
  writeFixture(runtimePath(runtimeRoot, "memmy-agent", "node_modules", "third-party", "index.js.map"), "third-party-agent-map");
  writeFixture(runtimePath(runtimeRoot, "memory", "node_modules", "third-party", "index.js.map"), "third-party-memory-map");

  writeJson(runtimePath(runtimeRoot, "memmy-agent", "node_modules", "html-validate", "package.json"), {
    name: "html-validate",
    peerDependencies: { vitest: "^4.0.1" },
    peerDependenciesMeta: optionalVitestPeer ? { vitest: { optional: true } } : {},
  });
  writeFixture(runtimePath(runtimeRoot, "memmy-agent", "node_modules", "html-validate", "dist", "cjs", "index.js"), "html-validate-runtime");
  for (const packagePath of [
    ["vitest", "index.js"],
    ["vite", "index.js"],
    ["rolldown", "index.js"],
    ["@vitest", "runner", "index.js"],
    ["@rolldown", "binding-win32-x64-msvc", "binding.node"],
    ["@rolldown", "binding-linux-x64-gnu", "binding.node"],
  ]) {
    writeFixture(runtimePath(runtimeRoot, "memmy-agent", "node_modules", ...packagePath), packagePath.join("/"));
  }
  writeFixture(runtimePath(runtimeRoot, "memmy-agent", "node_modules", ".bin", "vitest"), "bin");
  writeFixture(runtimePath(runtimeRoot, "memmy-agent", "node_modules", ".bin", "vite.cmd"), "bin");

  writeFixture(runtimePath(runtimeRoot, "memory", "node_modules", "onnxruntime-web", "dist", "ort.wasm"), "keep");
  writeFixture(runtimePath(runtimeRoot, "memmy-agent", "node_modules", "openclaw", "dist", "index.js"), "keep");
  writeFixture(runtimePath(runtimeRoot, "memmy-agent", "node_modules", "typescript", "lib", "typescript.js"), "keep");
  writeJson(runtimePath(runtimeRoot, "memmy-agent", "package-lock.json"), createToolchainLock({
    optionalVitestPeer,
    otherProductionViteConsumer,
    otherProductionVitePeerConsumer,
  }));
  return runtimeRoot;
}

function createToolchainLock({ optionalVitestPeer, otherProductionViteConsumer, otherProductionVitePeerConsumer }) {
  const rootDependencies = { "html-validate": "10.17.0" };
  if (otherProductionViteConsumer) rootDependencies["runtime-vite-consumer"] = "1.0.0";
  if (otherProductionVitePeerConsumer) rootDependencies["runtime-vite-peer-consumer"] = "1.0.0";
  return {
    lockfileVersion: 3,
    packages: {
      "": {
        dependencies: rootDependencies,
        devDependencies: { vitest: "4.1.7" },
      },
      "node_modules/html-validate": {
        peerDependencies: { vitest: "^4.0.1" },
        peerDependenciesMeta: optionalVitestPeer ? { vitest: { optional: true } } : {},
      },
      "node_modules/runtime-vite-consumer": { dependencies: { vite: "8.0.14" } },
      "node_modules/runtime-vite-peer-consumer": { peerDependencies: { vite: "^8.0.0" } },
      "node_modules/vitest": { dependencies: { "@vitest/runner": "4.1.7", vite: "8.0.14" } },
      "node_modules/@vitest/runner": {},
      "node_modules/vite": { dependencies: { rolldown: "1.0.2" } },
      "node_modules/rolldown": {
        optionalDependencies: {
          "@rolldown/binding-win32-x64-msvc": "1.0.2",
          "@rolldown/binding-linux-x64-gnu": "1.0.2",
        },
      },
      "node_modules/@rolldown/binding-win32-x64-msvc": {},
      "node_modules/@rolldown/binding-linux-x64-gnu": {},
    },
  };
}

function runtimePath(runtimeRoot, ...parts) {
  return join(runtimeRoot, ...parts);
}

function writeFixture(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function writeJson(path, value) {
  writeFixture(path, `${JSON.stringify(value, null, 2)}\n`);
}
