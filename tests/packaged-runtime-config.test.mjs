import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPackage } from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizePublicCloudService,
  writeDesktopEditionManifest,
} from "../scripts/internal/shared/write-desktop-edition-manifest-lib.mjs";
import { pruneRuntimeEnvFiles } from "../scripts/internal/shared/prune-runtime-env-files-lib.mjs";

const roots = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("packaged desktop runtime configuration", () => {
  it("writes exactly the public allowlist and never serializes env decoys", async () => {
    const root = fixtureRoot();
    const envFile = join(root, ".env");
    const output = join(root, "dist", "main", "desktop-edition.json");
    writeFileSync(envFile, [
      "MEMMY_CLOUD_SERVICE=https://manifest.example.test/",
      "MEMMY_PRIVATE_TOKEN=must-not-be-packaged",
      "MEMMY_LEGAL_CN_BASE_URL=https://legal.example.test",
    ].join("\n"));

    await writeDesktopEditionManifest({
      output,
      edition: "cn",
      accountChannel: "phone",
      signing: "signed",
      environment: {},
      envFile,
    });

    const manifestText = readFileSync(output, "utf8");
    const manifest = JSON.parse(manifestText);
    expect(manifest).toEqual({
      edition: "cn",
      accountChannel: "phone",
      signing: "signed",
      cloudService: "https://manifest.example.test",
    });
    expect(manifestText).not.toContain("MEMMY_PRIVATE_TOKEN");
    expect(manifestText).not.toContain("must-not-be-packaged");
    expect(manifestText).not.toContain("MEMMY_LEGAL_CN_BASE_URL");
  });

  it("uses an explicit environment origin before the root env file", async () => {
    const root = fixtureRoot();
    const envFile = join(root, ".env");
    const output = join(root, "desktop-edition.json");
    writeFileSync(envFile, "MEMMY_CLOUD_SERVICE=https://file.example.test\n");

    await writeDesktopEditionManifest({
      output,
      edition: "intl",
      accountChannel: "email",
      signing: "unsigned",
      environment: { MEMMY_CLOUD_SERVICE: "https://external.example.test" },
      envFile,
    });

    expect(JSON.parse(readFileSync(output, "utf8")).cloudService).toBe(
      "https://external.example.test",
    );
  });

  it.each([
    "http://api.example.test",
    "https://user:pass@api.example.test",
    "https://api.example.test/path",
    "https://api.example.test?token=value",
    "https://api.example.test/#fragment",
  ])("rejects a non-public cloud-service value: %s", (value) => {
    expect(() => normalizePublicCloudService(value)).toThrow(/MEMMY_CLOUD_SERVICE/);
  });

  it("removes runtime env files and symlinks without touching normal files", async () => {
    const root = fixtureRoot();
    const dependency = join(root, "node_modules", "dependency");
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, ".env"), "REDIS_HOST=127.0.0.1\n");
    writeFileSync(join(dependency, ".env.local"), "TOKEN=decoy\n");
    writeFileSync(join(dependency, "runtime.js"), "export {};\n");
    try {
      symlinkSync(join(dependency, "runtime.js"), join(dependency, ".env.production"));
    } catch (error) {
      if (error?.code !== "EPERM") throw error;
      writeFileSync(join(dependency, ".env.production"), "TOKEN=platform-fallback\n");
    }

    expect(await pruneRuntimeEnvFiles(root)).toBe(3);
    expect(existsSync(join(dependency, ".env"))).toBe(false);
    expect(existsSync(join(dependency, ".env.local"))).toBe(false);
    expect(existsSync(join(dependency, ".env.production"))).toBe(false);
    expect(existsSync(join(dependency, "runtime.js"))).toBe(true);
    expect(await pruneRuntimeEnvFiles(root)).toBe(0);
  });

  it("executes the writer and pruner CLI entrypoints", () => {
    const root = fixtureRoot();
    const output = join(root, "desktop-edition.json");
    const writer = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "scripts",
      "internal",
      "shared",
      "write-desktop-edition-manifest.mjs",
    );
    const writerResult = spawnSync(process.execPath, [
      writer,
      "--output", output,
      "--edition", "cn",
      "--account-channel", "phone",
      "--signing", "unsigned",
    ], {
      encoding: "utf8",
      env: { ...process.env, MEMMY_CLOUD_SERVICE: "https://cli.example.test" },
    });
    expect(writerResult.status, writerResult.stderr).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8")).cloudService).toBe("https://cli.example.test");

    const runtime = join(root, "runtime");
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, ".env"), "TOKEN=decoy\n");
    const pruner = join(dirname(writer), "prune-runtime-env-files.mjs");
    const pruneResult = spawnSync(process.execPath, [pruner, runtime], { encoding: "utf8" });
    expect(pruneResult.status, pruneResult.stderr).toBe(0);
    expect(existsSync(join(runtime, ".env"))).toBe(false);
  });

  it("creates a standalone Windows Memory manifest without private workspace dependencies", () => {
    const root = fixtureRoot();
    const sourcePackage = join(root, "Memory", "package.json");
    const runtimePackage = join(root, "runtime", "package.json");
    const runtimeMetadata = join(root, "runtime", "memory-runtime.json");
    writeFixtureJson(sourcePackage, {
      name: "@memmy/memory",
      version: "2.1.0",
      dependencies: {
        "@memmy/agent-source-core": "0.0.0",
        zod: "^4.4.3",
      },
    });
    const generator = join(
      dirname(fileURLToPath(import.meta.url)),
      "..", "scripts", "internal", "win", "create-memory-runtime-manifest.mjs",
    );

    const result = spawnSync(process.execPath, [
      generator,
      sourcePackage,
      runtimePackage,
      runtimeMetadata,
    ], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(runtimePackage, "utf8"))).toEqual({
      name: "@memmy/packaged-memory-runtime",
      version: "2.1.0",
      private: true,
      type: "module",
      dependencies: { zod: "^4.4.3" },
    });
    expect(JSON.parse(readFileSync(runtimeMetadata, "utf8"))).toEqual({
      version: "2.1.0",
      protocolVersion: 1,
      target: "windows-x64",
      entrypoint: "dist/src/server/index.js",
      viewer: "dist/viewer/index.html",
    });
  });

  it("validates desktop and Memory ASAR versions against independent authorities", async () => {
    const root = fixtureRoot();
    const verifier = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "scripts",
      "internal",
      "shared",
      "verify-packaged-asar.mjs",
    );
    const asar = await createAsarFixture(
      root,
      "independent-component-versions",
      "1.1.2",
      false,
      true,
      [],
      "win32",
      "complete",
      "2.1.0",
    );

    const verified = spawnSync(
      process.execPath,
      [verifier, ...verifierArgs(asar, "1.1.2", "win32", "x64", "2.1.0")],
      { encoding: "utf8" },
    );
    expect(verified.status, verified.stderr).toBe(0);

    const staleMemory = spawnSync(
      process.execPath,
      [verifier, ...verifierArgs(asar, "1.1.2", "win32", "x64", "2.0.9")],
      { encoding: "utf8" },
    );
    expect(staleMemory.status).not.toBe(0);
    expect(staleMemory.stderr).toContain("dist/runtime/memory/package.json");

    const missingMemoryAuthority = spawnSync(process.execPath, [
      verifier,
      "--asar", asar,
      "--expected", "1.1.2",
      "--platform", "win32",
      "--arch", "x64",
    ], { encoding: "utf8" });
    expect(missingMemoryAuthority.status).not.toBe(0);
    expect(missingMemoryAuthority.stderr).toContain("--expected-memory is required");

    const invalidMemoryAuthority = spawnSync(
      process.execPath,
      [verifier, ...verifierArgs(asar, "1.1.2", "win32", "x64", "invalid")],
      { encoding: "utf8" },
    );
    expect(invalidMemoryAuthority.status).not.toBe(0);
    expect(invalidMemoryAuthority.stderr).toContain(
      "Expected packaged Memory version must use semantic version syntax",
    );

    const unexpectedDarwinMemoryAuthority = spawnSync(
      process.execPath,
      [verifier, ...verifierArgs(asar, "1.1.2", "darwin", "arm64"), "--expected-memory", "2.1.0"],
      { encoding: "utf8" },
    );
    expect(unexpectedDarwinMemoryAuthority.status).not.toBe(0);
    expect(unexpectedDarwinMemoryAuthority.stderr).toContain(
      "--expected-memory is only supported for win32 packages",
    );

    const emptyDarwinMemoryAuthority = spawnSync(process.execPath, [
      verifier,
      ...verifierArgs(asar, "1.1.2", "darwin", "arm64"),
      "--expected-memory", "",
    ], { encoding: "utf8" });
    expect(emptyDarwinMemoryAuthority.status).not.toBe(0);
    expect(emptyDarwinMemoryAuthority.stderr).toContain(
      "--expected-memory is only supported for win32 packages",
    );

    const staleAgentAsar = await createAsarFixture(
      root,
      "stale-agent-version",
      "1.1.2",
      false,
      true,
      [],
      "win32",
      "complete",
      "2.1.0",
      "1.1.1",
    );
    const staleAgent = spawnSync(
      process.execPath,
      [verifier, ...verifierArgs(staleAgentAsar, "1.1.2", "win32", "x64", "2.1.0")],
      { encoding: "utf8" },
    );
    expect(staleAgent.status).not.toBe(0);
    expect(staleAgent.stderr).toContain("dist/runtime/memmy-agent/package.json");
  });

  it("fails closed on ASAR env files and stale embedded versions", async () => {
    const root = fixtureRoot();
    const verifier = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "scripts",
      "internal",
      "shared",
      "verify-packaged-asar.mjs",
    );
    const goodAsar = await createAsarFixture(root, "good", "1.0.8");
    const good = spawnSync(process.execPath, [verifier, ...verifierArgs(goodAsar, "1.0.8")], {
      encoding: "utf8",
    });
    expect(good.status, good.stderr).toBe(0);

    const missingAgentSourceCoreAsar = await createAsarFixture(
      root,
      "without-agent-source-core",
      "1.0.8",
      false,
      true,
      [],
      "win32",
      "manifest-only",
    );
    const missingAgentSourceCore = spawnSync(
      process.execPath,
      [verifier, ...verifierArgs(missingAgentSourceCoreAsar, "1.0.8")],
      { encoding: "utf8" },
    );
    expect(missingAgentSourceCore.status).not.toBe(0);
    expect(missingAgentSourceCore.stderr).toContain(
      "dist/runtime/memory/node_modules/@memmy/agent-source-core/dist/src/index.js",
    );

    const darwinAsar = await createAsarFixture(root, "darwin", "1.0.8", false, true, [], "darwin");
    const darwin = spawnSync(process.execPath, [verifier, ...verifierArgs(darwinAsar, "1.0.8", "darwin", "arm64")], {
      encoding: "utf8",
    });
    expect(darwin.status, darwin.stderr).toBe(0);

    const noLocksAsar = await createAsarFixture(root, "without-locks", "1.0.8", false, false);
    const withoutLocks = spawnSync(
      process.execPath,
      [verifier, ...verifierArgs(noLocksAsar, "1.0.8")],
      { encoding: "utf8" },
    );
    expect(withoutLocks.status, withoutLocks.stderr).toBe(0);

    const staleAsar = await createAsarFixture(root, "stale", "1.0.7");
    const stale = spawnSync(process.execPath, [verifier, ...verifierArgs(staleAsar, "1.0.8")], {
      encoding: "utf8",
    });
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain("does not match the requested version");

    const envAsar = await createAsarFixture(root, "with-env", "1.0.8", true);
    const withEnv = spawnSync(process.execPath, [verifier, ...verifierArgs(envAsar, "1.0.8")], {
      encoding: "utf8",
    });
    expect(withEnv.status).not.toBe(0);
    expect(withEnv.stderr).toContain("forbidden environment file");

    const foreignNativeAsar = await createAsarFixture(root, "foreign-native", "1.0.8", false, true, [
      ["dist/runtime/memory/node_modules/onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime.so", "foreign"],
    ]);
    const foreignNative = spawnSync(process.execPath, [verifier, ...verifierArgs(foreignNativeAsar, "1.0.8")], {
      encoding: "utf8",
    });
    expect(foreignNative.status).not.toBe(0);
    expect(foreignNative.stderr).toContain("incompatible onnxruntime-node platform");

    const toolchainAsar = await createAsarFixture(root, "toolchain", "1.0.8", false, true, [
      ["dist/runtime/memmy-agent/node_modules/vitest/index.js", "test-only"],
    ]);
    const toolchain = spawnSync(process.execPath, [verifier, ...verifierArgs(toolchainAsar, "1.0.8")], {
      encoding: "utf8",
    });
    expect(toolchain.status).not.toBe(0);
    expect(toolchain.stderr).toContain("optional-peer test toolchain");

    const thirdPartyMapAsar = await createAsarFixture(root, "third-party-map", "1.0.8", false, true, [
      ["dist/runtime/memory/node_modules/dependency/dist/index.js.map", "third-party-map"],
    ]);
    const thirdPartyMap = spawnSync(process.execPath, [verifier, ...verifierArgs(thirdPartyMapAsar, "1.0.8")], {
      encoding: "utf8",
    });
    expect(thirdPartyMap.status).not.toBe(0);
    expect(thirdPartyMap.stderr).toContain("third-party production source map");
  });

  it("passes the defined Windows package architecture to the shared ASAR verifier", () => {
    const buildScript = readFileSync(join(
      dirname(fileURLToPath(import.meta.url)),
      "..", "scripts", "internal", "win", "build-nsis.sh",
    ), "utf8");
    const verifierCall = buildScript.slice(
      buildScript.indexOf('node "$ROOT_DIR/scripts/internal/shared/verify-packaged-asar.mjs"'),
      buildScript.indexOf("\n}", buildScript.indexOf('node "$ROOT_DIR/scripts/internal/shared/verify-packaged-asar.mjs"')),
    );

    expect(verifierCall).toContain('--arch "$PACKAGE_ARCH"');
    expect(verifierCall).toContain('--expected-memory "$MEMORY_VERSION"');
    expect(verifierCall).not.toContain("TARGET_ARCH");
  });

  it("stages the private agent source workspace package without resolving it from npm", () => {
    const buildScript = readFileSync(join(
      dirname(fileURLToPath(import.meta.url)),
      "..", "scripts", "internal", "win", "build-nsis.sh",
    ), "utf8");

    expect(buildScript).toContain('AGENT_SOURCE_CORE_DIR="$ROOT_DIR/AgentSourceCore"');
    expect(buildScript).toContain(
      'node "$ROOT_DIR/scripts/internal/win/create-memory-runtime-manifest.mjs"',
    );
    expect(buildScript).toContain(
      'RUNTIME_AGENT_SOURCE_CORE_DIR="$RUNTIME_DIR/memory/node_modules/@memmy/agent-source-core"',
    );
    expect(buildScript).toContain(
      'cp -R "$AGENT_SOURCE_CORE_DIR/dist" "$RUNTIME_AGENT_SOURCE_CORE_DIR/dist"',
    );
    expect(buildScript).toContain(
      'require_packaged_runtime_file "$RUNTIME_AGENT_SOURCE_CORE_DIR/dist/src/index.js"',
    );
    expect(buildScript.indexOf('npm_ci_win_x64 "$RUNTIME_DIR/memory"')).toBeLessThan(
      buildScript.indexOf('RUNTIME_AGENT_SOURCE_CORE_DIR="$RUNTIME_DIR/memory/node_modules/@memmy/agent-source-core"'),
    );
    expect(buildScript).toContain(
      'local packaged_memory_runtime="$DESKTOP_DIR/release/win-unpacked/resources/memory-runtime"',
    );
    expect(buildScript).toContain(
      'require_packaged_runtime_file "$packaged_agent_source_core/package.json"',
    );
    expect(buildScript).toContain(
      'require_packaged_runtime_file "$packaged_agent_source_core/dist/src/index.js"',
    );
  });

  it("copies Memory node_modules into both Windows offline runtime variants", () => {
    for (const configName of [
      "electron-builder.win.yml",
      "electron-builder.win.unsigned.yml",
    ]) {
      const config = readFileSync(join(
        dirname(fileURLToPath(import.meta.url)),
        "..", "App", "shell", "desktop", configName,
      ), "utf8");
      expect(config).toContain([
        "  - from: dist/runtime/memory/node_modules",
        "    to: memory-runtime/node_modules",
        "    filter:",
        '      - "**/*"',
      ].join("\n"));
    }
  });
});

async function createAsarFixture(
  root,
  name,
  version,
  includeEnv = false,
  includeLocks = true,
  extraFiles = [],
  platform = "win32",
  agentSourceCoreFixture = "complete",
  memoryVersion = version,
  agentVersion = version,
) {
  const source = join(root, `${name}-source`);
  const asar = join(root, `${name}.asar`);
  const manifest = { version };
  writeFixtureJson(join(source, "package.json"), manifest);
  writeFixtureJson(join(source, "dist/main/desktop-edition.json"), {
    cloudService: "https://manifest.example.test",
  });
  for (const component of ["memory", "memmy-agent"]) {
    const componentVersion = component === "memory" ? memoryVersion : agentVersion;
    const componentManifest = { version: componentVersion };
    const componentLock = { version: componentVersion, packages: { "": { version: componentVersion } } };
    writeFixtureJson(join(source, `dist/runtime/${component}/package.json`), componentManifest);
    if (includeLocks) writeFixtureJson(join(source, `dist/runtime/${component}/package-lock.json`), componentLock);
  }
  const contracts = join(
    source,
    "dist/runtime/memmy-agent/node_modules/@memmy/local-api-contracts/dist/index.js",
  );
  mkdirSync(dirname(contracts), { recursive: true });
  writeFileSync(contracts, "export {};\n");
  if (platform === "win32") {
    const ownSourceMap = join(source, "dist/runtime/memmy-agent/dist/main.js.map");
    mkdirSync(dirname(ownSourceMap), { recursive: true });
    writeFileSync(ownSourceMap, "own-production-map\n");
    if (agentSourceCoreFixture === "complete") {
      const agentSourceCore = join(
        source,
        "dist/runtime/memory/node_modules/@memmy/agent-source-core/dist/src/index.js",
      );
      mkdirSync(dirname(agentSourceCore), { recursive: true });
      writeFileSync(agentSourceCore, "export {};\n");
    }
    if (agentSourceCoreFixture !== "missing") {
      writeFixtureJson(
        join(source, "dist/runtime/memory/node_modules/@memmy/agent-source-core/package.json"),
        {
          name: "@memmy/agent-source-core",
          version: "0.0.0",
          type: "module",
          main: "./dist/src/index.js",
        },
      );
    }
  }
  const targetArch = platform === "darwin" ? "arm64" : "x64";
  const onnxRuntimeRoot = join(source, `dist/runtime/memory/node_modules/onnxruntime-node/bin/napi-v3/${platform}/${targetArch}`);
  mkdirSync(onnxRuntimeRoot, { recursive: true });
  writeFileSync(join(onnxRuntimeRoot, "onnxruntime_binding.node"), `${platform}-${targetArch}-node`);
  if (platform === "win32") writeFileSync(join(onnxRuntimeRoot, "onnxruntime.dll"), "win-x64-dll");
  const lifecycleSidecar = join(
    source,
    "node_modules/@memmy/backend/dist/src/adapters/outbound/skill-writer/workspace-bridge/memmy-workspace-bridge.mjs",
  );
  mkdirSync(dirname(lifecycleSidecar), { recursive: true });
  writeFileSync(lifecycleSidecar, "export {};\n");
  for (const [relativePath, contents] of extraFiles) {
    const targetPath = join(source, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, contents);
  }
  if (includeEnv) writeFileSync(join(source, ".env.production"), "TOKEN=decoy\n");
  await createPackage(source, asar);
  return asar;
}

function verifierArgs(asar, expected, platform = "win32", arch = "x64", expectedMemory = expected) {
  const args = ["--asar", asar, "--expected", expected, "--platform", platform, "--arch", arch];
  if (platform === "win32") args.push("--expected-memory", expectedMemory);
  return args;
}

function writeFixtureJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "memmy-packaged-runtime-"));
  roots.push(root);
  return root;
}
